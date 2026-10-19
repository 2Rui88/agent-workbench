#!/bin/zsh
# LaunchAgent entrypoint for the CLI Session Task MCP service.
# launchd does not inherit the shell PATH, so resolve node explicitly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
exec node "$REPO_ROOT/dist/server/main.js"
