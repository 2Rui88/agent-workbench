import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

PROFILE = Path(os.path.expanduser('~/.edge-codex')).resolve()
EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
CDP_PORT = int(os.environ.get('COORDINATOR_EDGE_CDP_PORT', '9222'))
if not 1024 <= CDP_PORT <= 65535:
    raise SystemExit('COORDINATOR_EDGE_CDP_PORT must be between 1024 and 65535')


def process_uses_profile(pid: str, profile: Path = PROFILE) -> bool:
    """Return true only when an existing Edge process has opened this data directory."""
    try:
        result = subprocess.run(['lsof', '-p', pid, '-Fn'], capture_output=True, text=True, check=False)
    except OSError:
        return False
    prefix = str(profile) + os.sep
    for line in result.stdout.splitlines():
        if not line.startswith('n'):
            continue
        try:
            opened = str(Path(line[1:]).resolve())
        except OSError:
            continue
        if opened == str(profile) or opened.startswith(prefix):
            return True
    return False


def existing_edge_pids() -> list[str]:
    result = subprocess.run(['pgrep', '-x', 'Microsoft Edge'], capture_output=True, text=True, check=False)
    return [pid for pid in result.stdout.splitlines() if pid.strip()]


def assert_start_allowed() -> None:
    if not PROFILE.is_dir() or PROFILE.is_symlink() or PROFILE.stat().st_uid != os.getuid():
        raise SystemExit(f'专用 Edge Profile 不存在或不属于当前用户：{PROFILE}')
    for pid in existing_edge_pids():
        if process_uses_profile(pid):
            raise SystemExit(f'专用 Edge Profile 已被进程 {pid} 使用；不关闭、不接管现有 Edge。')
    probe = socket.socket()
    probe.settimeout(1)
    try:
        if probe.connect_ex(('127.0.0.1', CDP_PORT)) == 0:
            raise SystemExit(f'CDP 端口 {CDP_PORT} 已被占用；不启动第二个调试实例。')
    finally:
        probe.close()


assert_start_allowed()
if '--check-only' in sys.argv:
    print(json.dumps({'profile': str(PROFILE), 'cdpPort': CDP_PORT, 'existingEdgeMayCoexist': True}))
    raise SystemExit(0)

process = subprocess.Popen([
    EDGE,
    f'--remote-debugging-port={CDP_PORT}',
    '--user-data-dir=' + str(PROFILE),
    '--profile-directory=Default',
    '--no-first-run',
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
for _ in range(40):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{CDP_PORT}/json/version', timeout=1) as response:
            version = json.load(response)
        if version.get('Browser', '').startswith('Edg/') and version.get('webSocketDebuggerUrl'):
            print(json.dumps({'pid': process.pid, 'profile': str(PROFILE), 'browser': version['Browser'], 'cdpVerified': True, 'manualLoginIfNeeded': True}))
            break
    except Exception:
        time.sleep(0.5)
else:
    raise SystemExit('Edge startup protocol not ready; no fallback')
