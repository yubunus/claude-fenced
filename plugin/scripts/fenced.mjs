#!/usr/bin/env node
// claude-fenced: keep Claude Code's working files inside the project.
//
// Out of the box Claude Code puts scratch work where the user never looks: a per-session
// scratchpad under /tmp/claude-<uid>/, ad-hoc files in /tmp or $TMPDIR, plans in
// ~/.claude/plans and auto-memory in ~/.claude/projects/<slug>/memory. This script backs the
// plugin's hooks and moves all of that into <project>/<base>/ (base defaults to .claude).
// Like the caveman plugin, it works by injecting context: at SessionStart (which fires again
// after resume, /clear and compaction), as a one-line reminder with every prompt, and at
// SubagentStart. Where Claude Code has a real setting (plansDirectory, autoMemoryDirectory,
// $TMPDIR via CLAUDE_ENV_FILE) it uses that as well.
//
//   node fenced.mjs session-start | subagent-start | prompt   hooks, JSON payload on stdin
//   node fenced.mjs status [dir] | unfence [dir]              manual
//
// Hooks always exit 0 and swallow their own errors: a broken hook must never break a session.

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULTS = Object.freeze({
  enabled: true, // master switch
  base: '.claude', // project-relative folder that holds everything below
  tmpdir: true, // point $TMPDIR (and macOS mktemp) of Claude's Bash commands at <base>/tmp
  memory: true, // move auto-memory to <base>/memory (autoMemoryDirectory)
  plans: true, // move plan files to <base>/plans (plansDirectory)
  links: true, // read-only symlinks into Claude Code's private data at <base>/internals
  reminder: true, // one-line reminder with every prompt
  subagents: true, // give subagents the rules too
});

const SCRATCH_SUBDIRS = ['notes', 'tests', 'backups', 'research'];
const GITIGNORE = "# Created by claude-fenced: keeps Claude's working files out of git.\n*\n";
const STDIN_WATCHDOG_MS = 2000;
const RECENT_MS = 24 * 3600 * 1000;
const SESSION_STATE_TTL_MS = 30 * 24 * 3600 * 1000;
// Chrome and Python create Unix sockets under $TMPDIR, and macOS caps socket paths at 104
// bytes. Longer tmp paths get a short alias under /tmp (Claude Code itself caps its own at 44).
const SOCKET_SAFE_TMPDIR_BYTES = 50;
const COMMAND_RE = /(?:^\s*|<command-name>\s*)\/(?:fenced|claude-fenced):(on|off|status)\b/;
const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------------------------
// Context: where the project is, what the config says, where everything should go

function resolveContext(payload = {}, dirOverride) {
  const configDir = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  const projectDir = realpathOr(path.resolve(dirOverride || process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd()));
  const cfg = loadConfig(projectDir, configDir);
  const base = path.join(projectDir, cfg.base);
  // The transcript sits in Claude Code's own folder for this project; prefer it over re-deriving the slug.
  const transcript = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  const projectData = transcript ? path.dirname(transcript) : path.join(configDir, 'projects', projectSlug(projectDir));
  return {
    cfg,
    configDir,
    projectDir,
    projectData,
    slug: path.basename(projectData),
    home: realpathOr(os.homedir()),
    sessionId: validId(payload.session_id),
    source: typeof payload.source === 'string' ? payload.source : 'startup',
    dataDir: path.resolve(process.env.CLAUDE_PLUGIN_DATA || path.join(configDir, 'plugins', 'data', 'fenced-claude-fenced')),
    dirs: {
      base,
      scratchpad: path.join(base, 'scratchpad'),
      tmp: path.join(base, 'tmp'),
      plans: path.join(base, 'plans'),
      memory: path.join(base, 'memory'),
      internals: path.join(base, 'internals'),
    },
  };
}

function loadConfig(projectDir, configDir) {
  const cfg = { ...DEFAULTS };
  for (const file of [path.join(configDir, 'fenced.json'), path.join(projectDir, '.claude', 'fenced.json')]) {
    const data = readJson(file);
    if (!isPlainObject(data)) continue;
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof data[key] === typeof DEFAULTS[key]) cfg[key] = data[key];
    }
  }
  if (/^(0|off|false|no|disabled?)$/i.test((process.env.CLAUDE_FENCED || '').trim())) cfg.enabled = false;
  cfg.base = sanitizeBase(cfg.base);
  return cfg;
}

function sanitizeBase(value) {
  const base = String(value).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!base || path.isAbsolute(base) || base.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return DEFAULTS.base;
  }
  return base;
}

function skipReason(ctx) {
  if (!ctx.cfg.enabled) return 'turned off in config (fenced.json or CLAUDE_FENCED)';
  if (ctx.projectDir === path.parse(ctx.projectDir).root) return 'the project is the filesystem root';
  if (ctx.projectDir === ctx.home) return 'the project is your home directory';
  const configDir = realpathOr(ctx.configDir);
  if (isWithin(ctx.projectDir, configDir) || isWithin(ctx.dirs.base, configDir)) {
    return 'the project overlaps the Claude config directory';
  }
  try {
    if (!fs.statSync(ctx.projectDir).isDirectory()) return 'the project directory is missing';
  } catch {
    return 'the project directory is missing';
  }
  return null;
}

// Mirrors Claude Code's per-project folder names (~/.claude/projects/<slug>, /tmp/claude-<uid>/<slug>).
function projectSlug(dir) {
  const slug = dir.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= 200) return slug;
  let hash = 0;
  for (let i = 0; i < dir.length; i++) hash = ((hash << 5) - hash + dir.charCodeAt(i)) | 0;
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function harnessTempDir(slug) {
  const root = realpathOr(process.env.CLAUDE_CODE_TMPDIR || '/tmp');
  return path.join(root, `claude-${process.getuid?.() ?? 0}`, slug);
}

// ---------------------------------------------------------------------------------------------
// Per-session and per-project state (kept in the plugin's data folder)

function offFlagPath(ctx) {
  return ctx.sessionId ? path.join(ctx.dataDir, 'sessions', `${ctx.sessionId}.off`) : null;
}

function isOff(ctx) {
  const flag = offFlagPath(ctx);
  return flag !== null && fs.existsSync(flag);
}

function setOff(ctx, off) {
  const flag = offFlagPath(ctx);
  if (!flag) return;
  if (off) {
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, `${new Date().toISOString()}\n`);
  } else {
    fs.rmSync(flag, { force: true });
  }
}

// Returns true the first time it is called for this session and key.
function firstTimeThisSession(ctx, key) {
  if (!ctx.sessionId) return false;
  const marker = path.join(ctx.dataDir, 'sessions', `${ctx.sessionId}.${key}`);
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function gcSessionState(ctx) {
  const dir = path.join(ctx.dataDir, 'sessions');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - SESSION_STATE_TTL_MS;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {}
  }
}

function projectStatePath(ctx) {
  return path.join(ctx.dataDir, 'projects', `${ctx.slug}.json`);
}

function readProjectState(ctx) {
  const data = readJson(projectStatePath(ctx));
  return isPlainObject(data) ? data : {};
}

// ---------------------------------------------------------------------------------------------
// Folder layout

function ensureManagedDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  writeIfMissing(path.join(dir, '.gitignore'), GITIGNORE);
}

function ensureLayout(ctx) {
  const { dirs } = ctx;
  ensureManagedDir(dirs.scratchpad);
  for (const sub of SCRATCH_SUBDIRS) fs.mkdirSync(path.join(dirs.scratchpad, sub), { recursive: true });
  writeIfMissing(path.join(dirs.scratchpad, 'README.md'), scratchpadReadme(ctx));
  ensureManagedDir(dirs.tmp);
  if (ctx.cfg.links && !IS_WINDOWS) {
    ensureManagedDir(dirs.internals);
    writeIfMissing(path.join(dirs.internals, 'README.md'), internalsReadme(ctx));
    ensureLinks(ctx);
  }
}

function ensureLinks(ctx) {
  const dir = ctx.dirs.internals;
  ensureSymlink(path.join(dir, 'project-data'), ctx.projectData);
  ensureSymlink(path.join(dir, 'session-temp'), harnessTempDir(ctx.slug));

  // Pre-edit backups are stored per session, so link every session of this project that has some.
  const historyRoot = path.join(ctx.configDir, 'file-history');
  const historyLinks = path.join(dir, 'file-history');
  const sessions = new Set(ctx.sessionId ? [ctx.sessionId] : []);
  try {
    for (const name of fs.readdirSync(ctx.projectData)) {
      if (name.endsWith('.jsonl')) sessions.add(name.slice(0, -'.jsonl'.length));
    }
  } catch {}
  for (const id of sessions) {
    const target = path.join(historyRoot, id);
    if (id === ctx.sessionId || fs.existsSync(target)) ensureSymlink(path.join(historyLinks, id), target);
  }
  // The current session's link dangles until its first edit; earlier ones that never got backups go.
  try {
    for (const name of fs.readdirSync(historyLinks)) {
      const link = path.join(historyLinks, name);
      if (name !== ctx.sessionId && fs.lstatSync(link).isSymbolicLink() && !fs.existsSync(link)) fs.unlinkSync(link);
    }
  } catch {}
}

function ensureSymlink(link, target) {
  try {
    const st = fs.lstatSync(link);
    if (!st.isSymbolicLink()) return false; // a real file or folder is in the way: leave it alone
    if (fs.readlinkSync(link) === target) return true;
    fs.unlinkSync(link);
  } catch (err) {
    if (err.code !== 'ENOENT') return false;
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Claude Code settings: plansDirectory and autoMemoryDirectory

function settingsLayers(ctx) {
  const layer = (name, file) => {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { name, file, exists: false, ok: true, data: {} };
    }
    try {
      const data = JSON.parse(text);
      return { name, file, exists: true, ok: isPlainObject(data), data: isPlainObject(data) ? data : {} };
    } catch {
      return { name, file, exists: true, ok: false, data: {} };
    }
  };
  return {
    local: layer('local', path.join(ctx.projectDir, '.claude', 'settings.local.json')),
    project: layer('project', path.join(ctx.projectDir, '.claude', 'settings.json')),
    user: layer('user', path.join(ctx.configDir, 'settings.json')),
  };
}

function configuredValue(layers, key) {
  for (const layer of [layers.local, layers.project, layers.user]) {
    const value = layer.data[key];
    if (typeof value === 'string' && value.trim()) return { value, layer: layer.name };
  }
  return null;
}

function sandboxEnabled(layers) {
  for (const layer of [layers.local, layers.project, layers.user]) {
    const enabled = layer.data.sandbox?.enabled;
    if (typeof enabled === 'boolean') return enabled;
  }
  return false;
}

// State of the plans/memory relocation: active | pending (claude-fenced set it during this
// session; Claude Code applies it at the next start) | unset | custom (the user points it
// elsewhere; left alone) | blocked (settings file isn't writable JSON) | off (config).
function inspectSettings(ctx, layers, state = readProjectState(ctx)) {
  const setThisSession = (key) =>
    ctx.sessionId !== null && state.settings?.session === ctx.sessionId && Array.isArray(state.settings.keys) && state.settings.keys.includes(key);
  const inspect = (key, ours, want, resolve) => {
    const cur = configuredValue(layers, key);
    if (!cur) return { state: 'unset', want };
    if (!sameDir(resolve(cur.value), ours)) return { state: 'custom', value: cur.value };
    return { state: setThisSession(key) ? 'pending' : 'active' };
  };
  return {
    memory: ctx.cfg.memory ? inspect('autoMemoryDirectory', ctx.dirs.memory, ctx.dirs.memory, expandHome) : { state: 'off' },
    plans: ctx.cfg.plans
      ? inspect('plansDirectory', ctx.dirs.plans, toPosix(path.relative(ctx.projectDir, ctx.dirs.plans)), (v) => path.resolve(ctx.projectDir, v))
      : { state: 'off' },
  };
}

function provisionSettings(ctx, layers) {
  const state = readProjectState(ctx);
  const result = { ...inspectSettings(ctx, layers, state), notes: [], migrated: 0, caughtUp: 0 };
  const wanted = {};
  if (result.memory.state === 'unset') wanted.autoMemoryDirectory = result.memory.want;
  if (result.plans.state === 'unset') wanted.plansDirectory = result.plans.want;

  if (Object.keys(wanted).length > 0) {
    const local = layers.local;
    let writable = local.ok;
    try {
      if (fs.lstatSync(local.file).isSymbolicLink()) writable = false;
    } catch {}
    const newState = writable ? 'pending' : 'blocked';
    if (wanted.autoMemoryDirectory) result.memory.state = newState;
    if (wanted.plansDirectory) result.plans.state = newState;
    if (writable) {
      if (wanted.autoMemoryDirectory) {
        // Copy existing memories first so the new folder is complete the moment Claude Code switches to it.
        const from = defaultMemoryDir(ctx);
        ensureManagedDir(ctx.dirs.memory);
        result.migrated = copyTree(from, ctx.dirs.memory, { overwrite: false });
        state.memory = { from, since: Date.now(), session: ctx.sessionId, catchUp: true };
      }
      writeJsonAtomic(local.file, { ...local.data, ...wanted });
      if (!local.exists) ensureGitIgnored(ctx, local.file);
      state.settings = { session: ctx.sessionId, keys: Object.keys(wanted), at: new Date().toISOString() };
      writeJsonAtomic(projectStatePath(ctx), state);
    } else {
      result.notes.push(
        `Could not update ${toPosix(path.relative(ctx.projectDir, local.file))} (it is not plain JSON, or it is a symlink). ` +
          `To move memory/plans into ${ctx.cfg.base}/, the user can add ${JSON.stringify(wanted)} to it.`,
      );
    }
  }
  if (result.memory.state === 'active') result.caughtUp = catchUpMemory(ctx, state);
  if (['active', 'pending'].includes(result.memory.state)) ensureManagedDir(ctx.dirs.memory);
  if (['active', 'pending'].includes(result.plans.state)) ensureManagedDir(ctx.dirs.plans);
  return result;
}

function defaultMemoryDir(ctx) {
  return path.join(ctx.projectData, 'memory');
}

// Claude Code reads autoMemoryDirectory at startup, so the session that set it keeps saving
// memories to the old folder. Carry anything it saved over once, at the next session.
function catchUpMemory(ctx, state) {
  const memory = state.memory;
  if (!isPlainObject(memory) || !memory.catchUp || memory.session === ctx.sessionId) return 0;
  const copied = copyTree(memory.from, ctx.dirs.memory, {
    overwrite: true,
    newerThan: memory.since - 2000,
    backupDir: path.join(ctx.dirs.scratchpad, 'backups', 'memory-sync'),
  });
  state.memory = { ...memory, catchUp: false };
  writeJsonAtomic(projectStatePath(ctx), state);
  return copied;
}

// Settings files Claude Code creates are git-ignored globally; one we create must be ignored too,
// or its absolute paths end up in someone else's clone.
function ensureGitIgnored(ctx, file) {
  const git = (args) => execFileSync('git', args, { cwd: ctx.projectDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
  try {
    git(['check-ignore', '-q', '--', path.relative(ctx.projectDir, file)]);
    return; // exit 0: already ignored
  } catch (err) {
    if (err.status !== 1) return; // 128: not a git repository (or git is missing)
  }
  try {
    const exclude = path.resolve(ctx.projectDir, git(['rev-parse', '--git-path', 'info/exclude']).trim());
    const rule = '**/.claude/settings.local.json';
    const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (existing.split(/\r?\n/).includes(rule)) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${existing && !existing.endsWith('\n') ? '\n' : ''}# added by claude-fenced\n${rule}\n`);
  } catch {}
}

// ---------------------------------------------------------------------------------------------
// $TMPDIR for Claude's Bash commands (CLAUDE_ENV_FILE is sourced before each command)

function exportTmpdir(ctx, layers) {
  if (!ctx.cfg.tmpdir) return { state: 'off' };
  if (sandboxEnabled(layers)) return { state: 'sandbox' }; // the sandbox manages its own $TMPDIR
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) return { state: 'unavailable' };

  const tmp = ctx.dirs.tmp;
  const alias = tmpAlias(ctx);
  const flag = offFlagPath(ctx);
  const lines = [
    `# claude-fenced: temp files from this session's shell commands go to ${tmp}`,
    `if ${flag ? `[ ! -e ${shQuote(flag)} ] && ` : ''}[ -d ${shQuote(tmp)} ]; then`,
    alias
      ? `  if [ -d ${shQuote(alias)} ]; then TMPDIR=${shQuote(alias)}; else TMPDIR=${shQuote(tmp)}; fi`
      : `  TMPDIR=${shQuote(tmp)}`,
    '  export TMPDIR TMP="$TMPDIR" TEMP="$TMPDIR"',
  ];
  if (process.platform === 'darwin') {
    lines.push(
      '  # macOS mktemp ignores $TMPDIR; give it -p unless the caller already named a path',
      `  mktemp() { local a; for a in "$@"; do case "$a" in */*) command mktemp "$@"; return;; esac; done; command mktemp -p ${shQuote(tmp)} "$@"; }`,
    );
  }
  lines.push('fi', '');
  fs.appendFileSync(envFile, lines.join('\n'));
  const result = { state: 'on', alias };
  if (ctx.sessionId) writeJsonAtomic(tmpdirMarkerPath(ctx), result); // lets /fenced:on and status report it
  return result;
}

function tmpdirMarkerPath(ctx) {
  return path.join(ctx.dataDir, 'sessions', `${ctx.sessionId}.tmpdir`);
}

// What $TMPDIR looks like for this session's Bash commands, without touching anything.
function tmpdirState(ctx, layers) {
  if (!ctx.cfg.tmpdir) return { state: 'off' };
  if (sandboxEnabled(layers)) return { state: 'sandbox' };
  const marker = ctx.sessionId ? readJson(tmpdirMarkerPath(ctx)) : undefined;
  return isPlainObject(marker) && marker.state === 'on' ? { state: 'on', alias: marker.alias ?? null } : { state: 'unavailable' };
}

function tmpAlias(ctx) {
  if (IS_WINDOWS || Buffer.byteLength(ctx.dirs.tmp) <= SOCKET_SAFE_TMPDIR_BYTES) return null;
  const uid = process.getuid();
  const root = path.join('/tmp', `claude-fenced-${uid}`);
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') return null;
  }
  try {
    // /tmp is shared: only use a folder that is really ours, like Claude Code does for its temp root.
    const st = fs.lstatSync(root);
    if (!st.isDirectory() || st.uid !== uid) return null;
    if ((st.mode & 0o777) !== 0o700) fs.chmodSync(root, 0o700);
    const alias = path.join(root, crypto.createHash('sha1').update(ctx.projectDir).digest('hex').slice(0, 8));
    return ensureSymlink(alias, ctx.dirs.tmp) ? alias : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Text Claude sees

function sessionContext(ctx, info) {
  const { dirs, cfg } = ctx;
  const b = cfg.base;
  const lines = [
    '<claude-fenced>',
    'The user runs the claude-fenced plugin: every working file you create for this project must live inside the project, where they can see it, never in hidden system locations. ' +
      'This is a standing instruction from the user. It replaces the "Scratchpad directory" guidance in your environment info and any habit of using /tmp, /private/tmp, /var/folders, a default $TMPDIR or ~/.claude for working files. ' +
      'Use a different location only when the user explicitly names one.',
    '',
    `Project: ${ctx.projectDir}`,
    'Where things go (absolute paths; the folders exist and are git-ignored; add subfolders as you like):',
    `- ${dirs.scratchpad}/ is your scratchpad. Use it wherever you would have used the session scratchpad or /tmp:`,
    '    notes/     findings, research summaries, context about this project, decisions, TODOs, handoff notes',
    '    tests/     throwaway test scripts, repro cases, experiments, benchmarks',
    '    backups/   a copy of a file before a risky edit or bulk rewrite (mirror its relative path, add a timestamp)',
    '    research/  clones and downloads of outside code or docs you study',
    `- ${dirs.tmp}/ is for throwaway temp files.${tmpSentence(ctx, info.tmp)}`,
  ];
  const plans = info.settings.plans.state;
  if (plans === 'active') lines.push(`- ${dirs.plans}/ holds plan-mode files (plansDirectory).`);
  if (plans === 'pending') lines.push(`- ${dirs.plans}/ holds plan-mode files from the next session on (claude-fenced just set plansDirectory).`);
  const memory = info.settings.memory.state;
  if (memory === 'active') lines.push(`- ${dirs.memory}/ holds this project's auto-memory (autoMemoryDirectory).`);
  if (memory === 'pending') {
    lines.push(
      `- ${dirs.memory}/ holds this project's auto-memory from the next session on (claude-fenced just set autoMemoryDirectory). ` +
        'For the rest of this session keep saving memories where your system prompt says; claude-fenced copies them over.',
    );
  }
  if (cfg.links && !IS_WINDOWS) {
    lines.push(
      `- ${dirs.internals}/ has read-only links to Claude Code's private data for this project: project-data/ (session transcripts, oversized tool outputs), ` +
        "session-temp/ (Claude Code's own per-session scratchpad and background-task output), file-history/<session>/ (automatic pre-edit backups used by /rewind). " +
        'Read them when useful; never write, move or delete anything through them.',
    );
  }
  lines.push(
    '',
    'Habits:',
    `- Keep scratch out of the source tree: no stray test_*.py, *.bak, notes.md or debug scripts next to the real code. They go under ${b}/scratchpad/.`,
    `- Before researching something again, check ${b}/scratchpad/notes/. Save non-trivial findings there so later sessions (and the user) can reuse them.`,
    '- Leave scratch files for the user to review; only clean up obvious junk you just created.',
    `- Never commit or \`git add -f\` anything under ${b}/scratchpad, ${b}/tmp or the other folders above.`,
  );

  const notes = listFiles(path.join(dirs.scratchpad, 'notes')).slice(0, 10);
  if (notes.length > 0) {
    lines.push('', `Notes from earlier work (newest first): ${notes.map((f) => `${displayPath(ctx, f.path)} (${formatSize(f.size)}, ${ago(f.mtime)})`).join('; ')}`);
  }
  if (['resume', 'compact', 'fork'].includes(ctx.source)) {
    const recent = [
      ...listFiles(dirs.scratchpad, { skip: new Set(['.git', 'node_modules', 'notes', 'research']) }),
      ...listFiles(dirs.tmp),
    ]
      .filter((f) => Date.now() - f.mtime < RECENT_MS)
      .sort((x, y) => y.mtime - x.mtime)
      .slice(0, 12);
    if (recent.length > 0) {
      lines.push(`Scratch files touched in the last 24h (to pick up where you left off): ${recent.map((f) => `${displayPath(ctx, f.path)} (${ago(f.mtime)})`).join('; ')}`);
    }
  }
  if (info.settings.migrated > 0) lines.push(`Copied ${info.settings.migrated} existing memory file(s) from ${defaultMemoryDir(ctx)} into ${dirs.memory}.`);
  if (info.settings.caughtUp > 0) lines.push(`Carried over ${info.settings.caughtUp} memory file(s) saved to the old memory folder during the previous session.`);
  for (const note of info.settings.notes) lines.push(note);
  lines.push('</claude-fenced>');
  return lines.join('\n');
}

function tmpSentence(ctx, tmp) {
  const auto = "so mktemp, Python's tempfile, pytest's tmp_path and similar land there automatically";
  switch (tmp.state) {
    case 'on':
      return tmp.alias
        ? ` It is already $TMPDIR for your Bash commands, through the short alias ${tmp.alias} (kept short so Unix socket paths fit), ${auto}.`
        : ` It is already $TMPDIR for your Bash commands, ${auto}.`;
    case 'sandbox':
      return ` $TMPDIR is not redirected because the Claude Code sandbox manages it; write temp files here explicitly (e.g. mktemp -p ${shQuote(ctx.dirs.tmp)}).`;
    default:
      return ` Write temp files here explicitly (e.g. mktemp -p ${shQuote(ctx.dirs.tmp)}).`;
  }
}

function subagentContext(ctx) {
  const { dirs } = ctx;
  return [
    '<claude-fenced>',
    `Standing instruction from the user for this project (${ctx.projectDir}): keep every working file you create inside the project, never in /tmp, /private/tmp, /var/folders, a default $TMPDIR, ~/.claude or the "Scratchpad directory" from your environment info (this replaces that guidance). ` +
      `Scratch work goes under ${dirs.scratchpad}/ (notes/, tests/, backups/, research/ or another fitting subfolder); throwaway temp files go in ${dirs.tmp}/. ` +
      `Use another location only if the user or your task explicitly names one. Keep scratch out of the source tree, don't delete scratch files, and never write through ${dirs.internals}/ (read-only links).`,
    '</claude-fenced>',
  ].join('\n');
}

function reminderText(ctx) {
  return (
    `claude-fenced: working files for this project go under ${ctx.dirs.scratchpad}/ (throwaway temp files: ${ctx.dirs.tmp}/), ` +
    'not /tmp, /var/folders, ~/.claude or the session scratchpad, unless the user names another location.'
  );
}

function statusReport(ctx, { cli = false } = {}) {
  const skip = skipReason(ctx);
  const layers = settingsLayers(ctx);
  const settings = inspectSettings(ctx, layers);
  const describe = ({ state, value }) =>
    ({
      active: 'active',
      pending: 'set during this session; Claude Code applies it from the next session',
      unset: 'not set yet (claude-fenced sets it at the next session start)',
      custom: `left alone: you point it at ${value}`,
      off: 'off (config)',
    })[state] ?? state;
  const tmp = tmpdirState(ctx, layers);
  const tmpText = {
    on: `redirected for Claude's Bash commands${tmp.alias ? `, via ${tmp.alias}` : ''}`,
    sandbox: 'not redirected (the sandbox manages it)',
    off: 'not redirected (config)',
    unavailable: cli ? 'redirected in sessions claude-fenced starts' : 'not redirected in this session (starts with the next session)',
  }[tmp.state];
  const count = (dir) => listFiles(dir, { maxVisit: 5000 }).length;
  const active = skip ? `no: ${skip}` : !cli && isOff(ctx) ? 'no: turned off for this session (/fenced:on turns it back on)' : 'yes';
  const configFiles = [path.join(ctx.configDir, 'fenced.json'), path.join(ctx.projectDir, '.claude', 'fenced.json')];
  return [
    `claude-fenced status for ${ctx.projectDir}`,
    `  active       ${active}`,
    `  base         ${ctx.cfg.base}/`,
    `  scratchpad   ${ctx.dirs.scratchpad}/  (${count(ctx.dirs.scratchpad)} files)`,
    `  tmp          ${ctx.dirs.tmp}/  (${count(ctx.dirs.tmp)} files; $TMPDIR ${tmpText})`,
    `  plans        ${describe(settings.plans)}`,
    `  memory       ${describe(settings.memory)}`,
    `  internals    ${ctx.cfg.links && !IS_WINDOWS ? `${ctx.dirs.internals}/  (read-only links into ${ctx.configDir})` : 'off'}`,
    `  reminder     ${ctx.cfg.reminder ? 'on' : 'off'}    subagents ${ctx.cfg.subagents ? 'on' : 'off'}`,
    `  config       ${configFiles.map((f) => `${f} (${fs.existsSync(f) ? 'found' : 'none'})`).join(', ')}`,
  ].join('\n');
}

function scratchpadReadme(ctx) {
  const b = ctx.cfg.base;
  return `# Claude's scratchpad

Created by **claude-fenced**. Claude Code keeps its working files for this project here instead of
\`/tmp\` or its private session folders, so you can see everything it makes.

| Folder | What goes there |
| --- | --- |
| \`notes/\` | findings, research summaries, project context, decisions, handoff notes |
| \`tests/\` | throwaway test scripts, repro cases, experiments |
| \`backups/\` | copies of files taken before risky edits |
| \`research/\` | clones and downloads of outside code and docs |

Next to it in \`${b}/\`: \`tmp/\` (throwaway temp files; \`$TMPDIR\` for Claude's shell commands),
\`plans/\` (plan-mode files), \`memory/\` (auto-memory) and \`internals/\` (read-only links into
\`~/.claude\`: transcripts, oversized tool outputs, pre-edit backups).

Everything here is git-ignored. Delete whatever you like; Claude recreates folders as needed.
`;
}

function internalsReadme(ctx) {
  return `# internals: read-only links

Symlinks created by **claude-fenced** into Claude Code's private data for this project, so you can
look at it without digging through \`~/.claude\`:

- \`project-data/\` → \`${ctx.projectData}\`: session transcripts (\`*.jsonl\`) and oversized tool outputs (\`<session>/tool-results/\`)
- \`session-temp/\` → \`${harnessTempDir(ctx.slug)}\`: Claude Code's own per-session scratchpad and background-task output
- \`file-history/<session>/\` → \`${path.join(ctx.configDir, 'file-history')}/<session>\`: copies of files taken before Claude edited them (what \`/rewind\` uses)

Removing a link (\`rm internals/project-data\`) leaves the data alone. Don't delete *through* a link
(\`rm -r internals/project-data/\`): that deletes Claude Code's own files.
`;
}

// ---------------------------------------------------------------------------------------------
// Hook handlers

function onSessionStart(payload) {
  const ctx = resolveContext(payload);
  if (skipReason(ctx)) return null;
  if (ctx.source === 'startup' || ctx.source === 'clear') gcSessionState(ctx);
  if (ctx.source === 'clear') setOff(ctx, false); // /clear resets the conversation, including /fenced:off
  if (isOff(ctx)) return null; // /fenced:off earlier in this session: stay quiet after compaction or resume
  const layers = settingsLayers(ctx);
  ensureLayout(ctx);
  const settings = provisionSettings(ctx, layers);
  const tmp = exportTmpdir(ctx, layers);
  return hookOutput('SessionStart', { additionalContext: sessionContext(ctx, { settings, tmp }) });
}

function onSubagentStart(payload) {
  const ctx = resolveContext(payload);
  if (!ctx.cfg.subagents || skipReason(ctx) || isOff(ctx)) return null;
  ensureManagedDir(ctx.dirs.scratchpad);
  ensureManagedDir(ctx.dirs.tmp);
  return hookOutput('SubagentStart', { additionalContext: subagentContext(ctx) });
}

function onPrompt(payload) {
  const ctx = resolveContext(payload);
  const command = typeof payload.prompt === 'string' ? payload.prompt.match(COMMAND_RE)?.[1] : undefined;
  if (command === 'status') return hookOutput('UserPromptSubmit', { additionalContext: statusReport(ctx) });
  if (skipReason(ctx)) return null;
  if (command === 'off') {
    setOff(ctx, true);
    return hookOutput('UserPromptSubmit', {
      additionalContext:
        'claude-fenced is now OFF for the rest of this session: stop following the claude-fenced rules and use your default locations for temporary files ' +
        '(the scratchpad directory from your environment info) or wherever the user asks. $TMPDIR is no longer redirected.',
    });
  }
  if (command === 'on') {
    setOff(ctx, false);
    const layers = settingsLayers(ctx);
    ensureLayout(ctx);
    const settings = { ...inspectSettings(ctx, layers), notes: [], migrated: 0, caughtUp: 0 };
    return hookOutput('UserPromptSubmit', { additionalContext: sessionContext(ctx, { settings, tmp: tmpdirState(ctx, layers) }) });
  }
  if (isOff(ctx)) return null;
  return hookOutput('UserPromptSubmit', {
    additionalContext: ctx.cfg.reminder ? reminderText(ctx) : undefined,
    systemMessage: protectedDirWarning(ctx, payload),
  });
}

// Claude Code treats .claude/ as a protected folder: outside bypass mode it asks before every
// write there, and allow rules or hooks can't change that. Tell the user once per session.
function protectedDirWarning(ctx, payload) {
  const mode = payload.permission_mode;
  const underDotClaude = ctx.cfg.base === '.claude' || ctx.cfg.base.startsWith('.claude/');
  if (!mode || mode === 'bypassPermissions' || !underDotClaude || !firstTimeThisSession(ctx, 'warned')) return undefined;
  return (
    'claude-fenced: Claude Code asks before every write inside .claude/ unless it runs with --dangerously-skip-permissions. ' +
    `To keep scratch files without those prompts, set "base": ".scratch" in ${path.join(ctx.configDir, 'fenced.json')}.`
  );
}

function hookOutput(event, { additionalContext, systemMessage } = {}) {
  const out = {};
  if (additionalContext) out.hookSpecificOutput = { hookEventName: event, additionalContext };
  if (systemMessage) out.systemMessage = systemMessage;
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------------------------
// Manual commands

function unfence(dir) {
  const ctx = resolveContext({}, dir);
  const report = [`claude-fenced unfence ${ctx.projectDir}`];
  const local = settingsLayers(ctx).local;
  if (local.exists && local.ok) {
    const data = { ...local.data };
    if (typeof data.autoMemoryDirectory === 'string' && sameDir(expandHome(data.autoMemoryDirectory), ctx.dirs.memory)) {
      const copied = copyTree(ctx.dirs.memory, defaultMemoryDir(ctx), { overwrite: true });
      delete data.autoMemoryDirectory;
      report.push(`  memory: autoMemoryDirectory removed; ${copied} file(s) copied back to ${defaultMemoryDir(ctx)}`);
    }
    if (typeof data.plansDirectory === 'string' && sameDir(path.resolve(ctx.projectDir, data.plansDirectory), ctx.dirs.plans)) {
      delete data.plansDirectory;
      report.push('  plans: plansDirectory removed');
    }
    if (Object.keys(data).length !== Object.keys(local.data).length) writeJsonAtomic(local.file, data);
  }
  const optOut = path.join(ctx.projectDir, '.claude', 'fenced.json');
  const existing = readJson(optOut);
  writeJsonAtomic(optOut, { ...(isPlainObject(existing) ? existing : {}), enabled: false });
  report.push(`  opted out: ${optOut} now has "enabled": false (delete it to turn claude-fenced back on here)`);
  report.push(`  left in place: ${ctx.dirs.base}/{scratchpad,tmp,plans,memory,internals}. Delete them yourself if you no longer want them.`);
  return report.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Small helpers

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function writeIfMissing(file, content) {
  try {
    fs.writeFileSync(file, content, { flag: 'wx' }); // wx also refuses to follow a planted symlink
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

function copyTree(src, dst, { overwrite, newerThan = 0, backupDir } = {}, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return 0;
  }
  let copied = 0;
  for (const entry of entries) {
    if (entry.name === '.gitignore') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      if (depth < 4) copied += copyTree(from, to, { overwrite, newerThan, backupDir }, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const source = fs.statSync(from);
    if (source.mtimeMs < newerThan) continue;
    let dest = null;
    try {
      dest = fs.statSync(to);
    } catch {}
    if (dest && (!overwrite || dest.mtimeMs >= source.mtimeMs)) continue;
    fs.mkdirSync(dst, { recursive: true });
    if (dest && backupDir) {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(to, path.join(backupDir, `${entry.name}.${Math.round(dest.mtimeMs)}`));
    }
    fs.copyFileSync(from, to);
    fs.utimesSync(to, source.atime, source.mtime);
    copied++;
  }
  return copied;
}

function listFiles(root, { maxDepth = 4, maxVisit = 3000, skip = new Set(['.git', 'node_modules']) } = {}) {
  const files = [];
  let visited = 0;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++visited > maxVisit) return;
      if (entry.name === '.gitignore' || (depth === 0 && entry.name === 'README.md')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !skip.has(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const st = fs.statSync(full);
          files.push({ path: full, size: st.size, mtime: st.mtimeMs });
        } catch {}
      }
    }
  };
  walk(root, 0);
  return files.sort((a, b) => b.mtime - a.mtime);
}

function displayPath(ctx, file) {
  return isWithin(file, ctx.dirs.base) ? toPosix(path.relative(ctx.dirs.base, file)) : file;
}

function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function sameDir(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return norm(a) === norm(b) || realpathOr(norm(a)) === realpathOr(norm(b));
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ago(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

// Acts on the first complete JSON object instead of waiting for EOF, with a watchdog, so a host
// that is slow to close the pipe can't eat the hook's time budget.
function readPayload() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let input = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      process.stdin.pause();
      process.stdin.unref?.();
      let data;
      try {
        data = JSON.parse(input);
      } catch {}
      resolve(isPlainObject(data) ? data : {});
    };
    const watchdog = setTimeout(finish, STDIN_WATCHDOG_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
      try {
        JSON.parse(input);
        finish();
      } catch {}
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  const hooks = { 'session-start': onSessionStart, 'subagent-start': onSubagentStart, prompt: onPrompt };
  try {
    if (hooks[command]) {
      const out = hooks[command](await readPayload());
      if (out) process.stdout.write(JSON.stringify(out));
    } else if (command === 'status') {
      process.stdout.write(`${statusReport(resolveContext({}, arg || process.cwd()), { cli: true })}\n`);
    } else if (command === 'unfence') {
      process.stdout.write(`${unfence(arg || process.cwd())}\n`);
    } else {
      process.stdout.write('usage: fenced.mjs session-start | subagent-start | prompt | status [dir] | unfence [dir]\n');
    }
  } catch (err) {
    if (process.env.CLAUDE_FENCED_DEBUG) process.stderr.write(`claude-fenced: ${err.stack || err}\n`);
    if (!hooks[command]) process.exitCode = 1;
  }
}

main();
