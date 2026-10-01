# claude-fenced

A Claude Code plugin that keeps Claude's working files (scratch scripts, notes, plans and memory)
inside your project, where you can see them.

## The goal

Claude Code usually always works in the background. Its scratch files go to `/tmp`, and its plans and memory
go to folders under `~/.claude` that most people never open. When Claude gets something wrong due to improper memory, you
can't see what it was working from.

claude-fenced puts all of it in your project, for two reasons:

- **Fewer hallucinations.** Claude is told to save what it finds as notes in your project and to
  check them before researching the same thing again. After a long conversation is compacted or
  resumed, it is pointed back to those notes, so it carries on from what it wrote down. And every
  script and test it writes is right there for you to check.
- **Memory you control.** What Claude remembers about your project is a few plain text files. They
  now live in `.claude/memory/`, so you can read them, fix what is wrong and delete what is out of
  date.

## Install

You need `node` (or `bun`) installed.

```sh
claude plugin marketplace add yubunus/claude-fenced
claude plugin install fenced@claude-fenced
```

It is automatically active in every project from the next session you start.

## Using it

| Command | What it does |
| --- | --- |
| `/fenced:status` | Shows where Claude's files go in this project |
| `/fenced:off` | Turns claude-fenced off for the rest of the session |
| `/fenced:on` | Turns it back on |

## Settings

Optional. Put them in `~/.claude/fenced.json` (defaults) or `<project>/.claude/fenced.json`
(project specific).

| Key | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | `false` switches claude-fenced off |
| `base` | `".claude"` | The folder that holds everything, for example `".scratch"` |
| `tmpdir` | `true` | Send temp files from Claude's commands to `tmp/` |
| `memory` | `true` | Keep memory in `memory/` |
| `plans` | `true` | Keep plans in `plans/` |
| `links` | `true` | Create the `internals/` links |
| `reminder` | `true` | Add a one-line reminder to every prompt (about 70 tokens) |
| `subagents` | `true` | Give subagents the rules too |

`CLAUDE_FENCED=off` in your environment switches it off everywhere.

## Removing it

```sh
claude plugin uninstall fenced@claude-fenced
```

Your folders stay, and plans and memory keep living in the project. To send a project's plans and
memory back to Claude Code's own folders, run this before you uninstall:

```sh
node ~/.claude/plugins/marketplaces/claude-fenced/plugin/scripts/fenced.mjs unfence /path/to/project
```


## [MIT LICENSE](LICENSE)
