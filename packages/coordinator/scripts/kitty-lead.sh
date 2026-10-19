#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
cd "$project_root"
umask 077
log_dir=$(mktemp -d "$project_root/.state/kitty/lead-XXXXXX")
ready_file="$log_dir/ready.json"
COORDINATOR_KITTY_READY_FILE="$ready_file" COORDINATOR_LEAD_PID=$$ node dist/scripts/kitty-follow.js "$1" >"$log_dir/controller.log" 2>&1 &
controller_pid=$!
monitor_pid=''
cleanup() { if [ -n "$monitor_pid" ]; then kill "$monitor_pid" 2>/dev/null || true; fi; kill "$controller_pid" 2>/dev/null || true; wait "$controller_pid" 2>/dev/null || true; }
trap cleanup EXIT TERM
trap ':' INT
attempt=0
while [ ! -f "$ready_file" ]; do
  if ! kill -0 "$controller_pid" 2>/dev/null || [ "$attempt" -ge 100 ]; then
    echo "Kitty 接入失败；未启动主会话。日志：$log_dir/controller.log" >&2
    cat "$log_dir/controller.log" >&2
    exit 1
  fi
  attempt=$((attempt + 1)); sleep 0.1
done
(
  while kill -0 "$controller_pid" 2>/dev/null && [ ! -f "$ready_file.failed" ]; do sleep 1; done
  printf '\n[Coordinator] Kitty 布局控制已停止，主会话保留。请检查 %s；不要盲目重启。\n' "$log_dir/controller.log" >&2
) &
monitor_pid=$!
printf 'Kitty 动态观察已就绪。日志：%s\n' "$log_dir/controller.log"
# Observation only: the lead is a plain claude session that attaches itself (lead:attach).
"${SHELL:-/bin/zsh}" -i
