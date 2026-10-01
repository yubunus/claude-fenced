#!/bin/sh
# claude-fenced hook launcher: runs fenced.mjs with node (or bun). It never fails the hook,
# because a missing runtime must not break Claude Code sessions.
here=$(dirname "$0")
for runtime in node bun; do
  if command -v "$runtime" >/dev/null 2>&1; then
    exec "$runtime" "$here/fenced.mjs" "$@"
  fi
done
# No JavaScript runtime: keep the core rule alive at session start, skip everything else.
if [ "$1" = session-start ] && [ -n "$CLAUDE_PROJECT_DIR" ] && [ "$CLAUDE_PROJECT_DIR" != "$HOME" ]; then
  cat >/dev/null
  printf '%s\n' "claude-fenced: keep every working file you create for this project (scratch scripts, temp files, test scripts, backups, notes) under $CLAUDE_PROJECT_DIR/.claude/scratchpad/ instead of /tmp, \$TMPDIR or the session scratchpad directory, unless the user names another location. (node was not found, so only this basic rule is active.)"
fi
exit 0
