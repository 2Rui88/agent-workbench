#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: COORDINATOR_DB_PATH=/path/to/state.sqlite $0 <group-id>" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
COORDINATOR_GROUP_ID="$1" exec kitty --session "$project_root/kitty/session.conf"
