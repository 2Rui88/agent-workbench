# PowerContext 部署整理实施计划（计划 A）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把本机 PowerContext 部署从 `~/powercontext-demo` 迁到 `~/playground/powercontext`，建立带校验和清理规则的备份工具，并清理已经失效的官方启动器。

**Architecture:** 新目录作为独立 git 仓库，用来维护我们自己这一版（`multi_principal_server.py` 加上已安装的 powercontext 1.1.0）。备份工具只用 Python 标准库实现。迁移顺序是"先复制、再切换、验证通过后才删除旧目录"，每一步对外部状态的修改都先列出命令，等用户确认后再执行。

**Tech Stack:** Python 3.12 标准库（`sqlite3`、`hashlib`、`json`、`unittest`、`urllib`），uv 虚拟环境，macOS `launchctl`、`plutil`。

**Spec:** `docs/superpowers/specs/2026-10-08-multi-agent-runtime-design.md` 第 3 节

## Global Constraints

- 新目录：`~/playground/powercontext`；路径中不再出现 `-demo`。
- 服务：`http://127.0.0.1:8787`，数据目录 `~/Library/Application Support/powercontext`（**不迁移**）。
- 凭据文件和环境文件权限 `0600`，目录 `0700`；任何输出、日志、提交中都不能出现 token。
- 备份目录：`~/playground/powercontext/backups/<UTC 时间>-<原因>/`，附带 `manifest.json`。
- 清理规则：保留最近 3 份校验通过的备份，以及与未完成操作关联的备份；只有超过 30 天且已被取代的才列为候选；必须先列清单、等用户确认后才能删除。
- 体积阈值：线上数据库（含 WAL）体积的 3 倍，或 500M，以较小者为准。
- Python 必须在项目虚拟环境中运行（`uv venv`），不安装第三方依赖。
- 每个改动外部状态的步骤（launchctl、`~/.config`、`~/Library/LaunchAgents`、`~/.codex` 文档、删除文件）执行前都要停下，列出确切命令，等用户确认。
- 不提交、不推送到任何远程仓库。

## Review Focus

- `.env` 中带空格的值必须用引号包住（例如 `'Bearer x'`）。路径替换时要保持原有引用格式，否则严格解析器会拒绝整个文件。用解析器重新读取的测试来固定这一点。
- 数据库正在被服务写入（有 WAL）时做备份，结果必须是一致的单文件，不能带 `-wal`/`-shm`。用"边写边备份"的测试来固定这一点。
- 备份目录里出现没有 manifest 的目录，或者 manifest 中的 checksum 对不上，不能被当成有效备份；清理逻辑也不能因此认为"已有更新的备份"。
- 只有 `launchctl bootout` 成功、`bootstrap` 失败时，服务就会停止。切换步骤要带回滚命令，并且先确认旧 plist 已备份。
- `codex-env.zsh` 会被 `.zshrc` 加载。路径改错会让每个新 shell 都报错或读不到授权，所以修改后必须开一个新 shell 实测，不能只检查文件内容。

---

### Task 1: 建立新目录和仓库骨架

**Files:**
- Create: `~/playground/powercontext/.gitignore`
- Create: `~/playground/powercontext/README.md`
- Copy（`cp -p`，保留权限和时间）: `multi_principal_server.py`、`test_multi_principal_server.py`、`configure_zcode_powercontext.py`、`.env`、`principals.json`
- Copy 到 `archive/`: `handoff-revision-2-payload.json`、`handoff-revision-2-payload.json.body`

- [ ] **Step 1: 只读盘点旧目录（不需要确认）**

```bash
ls -la ~/powercontext-demo
stat -f '%Sp %z %N' ~/powercontext-demo/.env ~/powercontext-demo/principals.json
```

预期：`.env`、`principals.json` 都是 `-rw-------`。

- [ ] **Step 2: 停下，请用户确认下面的复制命令**

```bash
mkdir -p ~/playground/powercontext/archive ~/playground/powercontext/backups ~/playground/powercontext/ops
chmod 700 ~/playground/powercontext ~/playground/powercontext/backups
cd ~/powercontext-demo
cp -p multi_principal_server.py test_multi_principal_server.py configure_zcode_powercontext.py .env principals.json ~/playground/powercontext/
cp -p handoff-revision-2-payload.json handoff-revision-2-payload.json.body ~/playground/powercontext/archive/
```

- [ ] **Step 3: 写 `.gitignore`**

```gitignore
.env
.env.*
principals.json
principals.json.*
backups/
.venv/
__pycache__/
*.pyc
archive/*.json
archive/*.body
```

- [ ] **Step 4: 写 README（只记录运维入口，不写任何凭据）**

````markdown
# PowerContext 本地部署（自维护版本）

- 服务脚本：`multi_principal_server.py`（多 Principal 包装层，基于已安装的 powercontext 1.1.0）
- LaunchAgent：`~/Library/LaunchAgents/com.local.powercontext-multi-principal.plist`
- 数据目录：`~/Library/Application Support/powercontext`
- 凭据：`principals.json`、`.env`（`0600`，不入库）
- 备份：`ops/pc_backup.py`，规则见 `docs/superpowers/specs/2026-10-08-multi-agent-runtime-design.md` 第 3.2 节（位于 coordinator 仓库）

常用命令：

```sh
.venv/bin/python ops/pc_backup.py inventory
.venv/bin/python ops/pc_backup.py backup --reason <原因>
.venv/bin/python ops/verify_access.py
```
````

- [ ] **Step 5: 初始化仓库和虚拟环境，确认没有敏感文件被纳入**

```bash
cd ~/playground/powercontext
git init -q
uv venv -q .venv
git add -A
git status --short
```

预期：列表中**没有** `.env`、`principals.json`、`backups/`、`archive/*.json`。

- [ ] **Step 6: 提交**

```bash
git commit -q -m "chore: import self-maintained PowerContext deployment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 备份工具 `ops/pc_backup.py`

**Files:**
- Create: `~/playground/powercontext/ops/pc_backup.py`
- Create: `~/playground/powercontext/ops/test_pc_backup.py`

**Interfaces:**
- Produces:
  - `create_backup(live_db: Path, files: list[Path], backups_dir: Path, reason: str, operation: str | None = None, now: datetime | None = None) -> Path`
  - `import_legacy(sources: list[Path], backups_dir: Path, reason: str, pristine: bool, now: datetime | None = None) -> Path`
  - `verify(backup_dir: Path) -> list[str]`
  - `inventory(backups_dir: Path, live_db: Path) -> dict`
  - `prune_candidates(inv: dict, now: datetime, open_operations: set[str]) -> list[str]`
  - `prune(backups_dir: Path, live_db: Path, names: list[str], healthy: Callable[[], bool], now: datetime) -> list[str]`

- [ ] **Step 1: 写失败测试**

```python
# ops/test_pc_backup.py
import json
import os
import sqlite3
import stat
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pc_backup as b

UTC = timezone.utc


def make_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE t(v TEXT)")
    conn.executemany("INSERT INTO t VALUES (?)", [("x" * 100,)] * 200)
    conn.commit()
    conn.close()


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.db = self.tmp / "live.db"
        make_db(self.db)
        self.env = self.tmp / ".env"
        self.env.write_text("POWERCONTEXT_CODEX_AUTHORIZATION='Bearer secret value'\n")
        os.chmod(self.env, 0o600)
        self.backups = self.tmp / "backups"

    def test_backup_is_single_consistent_file_with_private_permissions(self):
        writer_done = threading.Event()

        def writer():
            conn = sqlite3.connect(self.db)
            for _ in range(200):
                conn.execute("INSERT INTO t VALUES ('y')")
                conn.commit()
            conn.close()
            writer_done.set()

        thread = threading.Thread(target=writer)
        thread.start()
        target = b.create_backup(self.db, [self.env], self.backups, "pre-migration")
        thread.join()
        names = sorted(p.name for p in target.iterdir())
        self.assertEqual(names, [".env", "live.db", "manifest.json"])
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)
        for item in target.iterdir():
            self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o600)
        conn = sqlite3.connect(target / "live.db")
        self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        conn.close()
        self.assertEqual(b.verify(target), [])
        self.assertIn("secret value", (target / ".env").read_text())

    def test_manifest_mismatch_and_missing_manifest_are_invalid(self):
        target = b.create_backup(self.db, [self.env], self.backups, "a")
        (target / ".env").write_text("tampered")
        self.assertTrue(any("checksum" in p for p in b.verify(target)))
        stray = self.backups / "20260101T000000Z-stray"
        stray.mkdir()
        inv = b.inventory(self.backups, self.db)
        by_name = {item["name"]: item for item in inv["backups"]}
        self.assertFalse(by_name[stray.name]["valid"])
        self.assertFalse(by_name[target.name]["valid"])

    def test_prune_candidates_keep_three_newest_valid_and_open_operations(self):
        start = datetime(2026, 8, 1, tzinfo=UTC)
        made = [b.create_backup(self.db, [], self.backups, f"r{i}", operation=f"op{i}", now=start + timedelta(days=i)) for i in range(6)]
        now = start + timedelta(days=60)
        inv = b.inventory(self.backups, self.db)
        candidates = b.prune_candidates(inv, now, open_operations={"op0"})
        self.assertEqual(candidates, [made[1].name, made[2].name])

    def test_prune_refuses_without_health_or_newer_valid_backup(self):
        old = b.create_backup(self.db, [], self.backups, "old", now=datetime(2026, 1, 1, tzinfo=UTC))
        now = datetime(2026, 10, 1, tzinfo=UTC)
        with self.assertRaises(b.PruneRefused):
            b.prune(self.backups, self.db, [old.name], healthy=lambda: True, now=now)
        for i in range(3):
            b.create_backup(self.db, [], self.backups, f"n{i}", now=datetime(2026, 9, 1 + i, tzinfo=UTC))
        with self.assertRaises(b.PruneRefused):
            b.prune(self.backups, self.db, [old.name], healthy=lambda: False, now=now)
        self.assertEqual(b.prune(self.backups, self.db, [old.name], healthy=lambda: True, now=now), [old.name])
        self.assertFalse(old.exists())

    def test_prune_rejects_names_that_are_not_candidates(self):
        keep = b.create_backup(self.db, [], self.backups, "keep")
        with self.assertRaises(b.PruneRefused):
            b.prune(self.backups, self.db, [keep.name], healthy=lambda: True, now=datetime.now(UTC))

    def test_legacy_import_marks_non_pristine_and_never_counts_as_newer(self):
        legacy = self.tmp / "old.db"
        make_db(legacy)
        target = b.import_legacy([legacy], self.backups, "legacy-0923", pristine=False, now=datetime(2026, 9, 23, tzinfo=UTC))
        manifest = json.loads((target / "manifest.json").read_text())
        self.assertFalse(manifest["pristine"])
        self.assertEqual(b.verify(target), [])
        inv = b.inventory(self.backups, self.db)
        self.assertFalse(inv["backups"][0]["counts_as_recovery_point"])

    def test_inventory_reports_threshold(self):
        b.create_backup(self.db, [], self.backups, "a")
        inv = b.inventory(self.backups, self.db)
        live = self.db.stat().st_size + (Path(str(self.db) + "-wal").stat().st_size if Path(str(self.db) + "-wal").exists() else 0)
        self.assertEqual(inv["threshold"], min(3 * live, 500 * 1024 * 1024))
        self.assertIn("over_threshold", inv)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`cd ~/playground/powercontext/ops && ../.venv/bin/python -m unittest test_pc_backup -v`
预期：失败，报 `ModuleNotFoundError: No module named 'pc_backup'`。

- [ ] **Step 3: 实现**

```python
# ops/pc_backup.py
"""PowerContext 备份：一致性快照、manifest 校验、体积检查与确认式清理。"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

UTC = timezone.utc
KEEP_LATEST = 3
MAX_AGE = timedelta(days=30)
HARD_LIMIT = 500 * 1024 * 1024
NAME = re.compile(r"^(\d{8}T\d{6}Z)-[a-z0-9][a-z0-9.-]{0,63}$")


class PruneRefused(Exception):
    pass


def _slug(reason: str) -> str:
    slug = re.sub(r"[^a-z0-9.-]+", "-", reason.lower()).strip("-")[:64]
    if not slug:
        raise ValueError("reason must contain letters or digits")
    return slug


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _new_dir(backups_dir: Path, reason: str, now: datetime) -> Path:
    backups_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(backups_dir, 0o700)
    target = backups_dir / f"{now.astimezone(UTC).strftime('%Y%m%dT%H%M%SZ')}-{_slug(reason)}"
    target.mkdir(mode=0o700)
    os.chmod(target, 0o700)
    return target


def _write_manifest(target: Path, reason: str, operation: str | None, pristine: bool, now: datetime, sources: dict[str, Path]) -> None:
    entries = []
    for name, source in sorted(sources.items()):
        item = target / name
        os.chmod(item, 0o600)
        entries.append({"name": name, "source": str(source), "size": item.stat().st_size, "sha256": _sha256(item)})
    manifest = {"version": 1, "created_at": now.astimezone(UTC).isoformat(), "reason": reason, "operation": operation, "pristine": pristine, "entries": entries}
    path = target / "manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    os.chmod(path, 0o600)


def create_backup(live_db: Path, files: list[Path], backups_dir: Path, reason: str, operation: str | None = None, now: datetime | None = None) -> Path:
    now = now or datetime.now(UTC)
    target = _new_dir(backups_dir, reason, now)
    sources: dict[str, Path] = {}
    source = sqlite3.connect(f"file:{live_db}?mode=ro", uri=True)
    dest = sqlite3.connect(target / live_db.name)
    try:
        source.backup(dest)
        dest.execute("PRAGMA journal_mode=DELETE")
    finally:
        dest.close()
        source.close()
    sources[live_db.name] = live_db
    for item in files:
        shutil.copy2(item, target / item.name)
        sources[item.name] = item
    _write_manifest(target, reason, operation, True, now, sources)
    return target


def import_legacy(sources: list[Path], backups_dir: Path, reason: str, pristine: bool, now: datetime | None = None) -> Path:
    now = now or datetime.now(UTC)
    target = _new_dir(backups_dir, reason, now)
    mapping: dict[str, Path] = {}
    for item in sources:
        shutil.copy2(item, target / item.name)
        mapping[item.name] = item
    _write_manifest(target, reason, None, pristine, now, mapping)
    return target


def verify(backup_dir: Path) -> list[str]:
    manifest_path = backup_dir / "manifest.json"
    if not manifest_path.is_file():
        return ["manifest missing"]
    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError:
        return ["manifest unreadable"]
    problems = []
    listed = {entry["name"] for entry in manifest.get("entries", [])}
    actual = {p.name for p in backup_dir.iterdir() if p.name != "manifest.json"}
    if listed != actual:
        problems.append(f"file set mismatch: {sorted(actual ^ listed)}")
    for entry in manifest.get("entries", []):
        item = backup_dir / entry["name"]
        if not item.is_file() or item.is_symlink():
            problems.append(f"missing {entry['name']}")
        elif item.stat().st_size != entry["size"] or _sha256(item) != entry["sha256"]:
            problems.append(f"checksum mismatch {entry['name']}")
    return problems


def _live_size(live_db: Path) -> int:
    wal = Path(str(live_db) + "-wal")
    return live_db.stat().st_size + (wal.stat().st_size if wal.exists() else 0)


def inventory(backups_dir: Path, live_db: Path) -> dict:
    items = []
    for entry in sorted(backups_dir.iterdir() if backups_dir.exists() else []):
        if not entry.is_dir():
            continue
        match = NAME.match(entry.name)
        size = sum(p.stat().st_size for p in entry.rglob("*") if p.is_file())
        problems = verify(entry)
        manifest = {}
        if not problems:
            manifest = json.loads((entry / "manifest.json").read_text())
        valid = bool(match) and not problems
        items.append({
            "name": entry.name,
            "created_at": manifest.get("created_at") if valid else None,
            "size": size,
            "valid": valid,
            "problems": problems,
            "pristine": bool(manifest.get("pristine")) if valid else False,
            "operation": manifest.get("operation") if valid else None,
            "counts_as_recovery_point": valid and bool(manifest.get("pristine")),
        })
    total = sum(item["size"] for item in items)
    threshold = min(3 * _live_size(live_db), HARD_LIMIT)
    return {"backups": items, "total": total, "threshold": threshold, "over_threshold": total > threshold}


def prune_candidates(inv: dict, now: datetime, open_operations: set[str]) -> list[str]:
    points = sorted((i for i in inv["backups"] if i["counts_as_recovery_point"]), key=lambda i: i["created_at"], reverse=True)
    protected = {i["name"] for i in points[:KEEP_LATEST]}
    newest = points[0]["created_at"] if points else None
    result = []
    for item in inv["backups"]:
        if item["name"] in protected or not item["valid"] or item["operation"] in open_operations:
            continue
        created = datetime.fromisoformat(item["created_at"])
        if now - created > MAX_AGE and newest is not None and newest > item["created_at"]:
            result.append(item["name"])
    return sorted(result)


def prune(backups_dir: Path, live_db: Path, names: list[str], healthy: Callable[[], bool], now: datetime, open_operations: set[str] | None = None) -> list[str]:
    inv = inventory(backups_dir, live_db)
    if not any(i["counts_as_recovery_point"] for i in inv["backups"]):
        raise PruneRefused("no valid pristine recovery point exists")
    if not healthy():
        raise PruneRefused("service is not healthy")
    allowed = set(prune_candidates(inv, now, open_operations or set()))
    rejected = [n for n in names if n not in allowed]
    if rejected:
        raise PruneRefused(f"not prune candidates: {rejected}")
    for name in names:
        shutil.rmtree(backups_dir / name)
    return names


def service_healthy(url: str = "http://127.0.0.1:8787/health/ready") -> bool:
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return response.status == 200 and json.load(response).get("status") == "ready"
    except Exception:
        return False


def main(argv: list[str]) -> int:
    root = Path(os.environ.get("POWERCONTEXT_OPS_ROOT", Path.home() / "playground/powercontext"))
    parser = argparse.ArgumentParser(prog="pc_backup")
    parser.add_argument("--live-db", type=Path, default=Path.home() / "Library/Application Support/powercontext/powercontext.db")
    parser.add_argument("--backups", type=Path, default=root / "backups")
    sub = parser.add_subparsers(dest="command", required=True)
    make = sub.add_parser("backup")
    make.add_argument("--reason", required=True)
    make.add_argument("--operation")
    sub.add_parser("inventory")
    legacy = sub.add_parser("import-legacy")
    legacy.add_argument("--reason", required=True)
    legacy.add_argument("--non-pristine", action="store_true")
    legacy.add_argument("files", nargs="+", type=Path)
    drop = sub.add_parser("prune")
    drop.add_argument("--confirm", required=True, help="comma separated exact backup names")
    args = parser.parse_args(argv)
    if args.command == "inventory":
        print(json.dumps(inventory(args.backups, args.live_db), ensure_ascii=False, indent=2))
        inv = inventory(args.backups, args.live_db)
        print(json.dumps({"prune_candidates": prune_candidates(inv, datetime.now(UTC), set())}, ensure_ascii=False))
        return 0
    if args.command == "backup":
        before = inventory(args.backups, args.live_db)
        if before["over_threshold"]:
            print(json.dumps({"warning": "backup total exceeds threshold", "total": before["total"], "threshold": before["threshold"]}), file=sys.stderr)
        target = create_backup(args.live_db, [root / ".env", root / "principals.json"], args.backups, args.reason, args.operation)
        print(json.dumps({"backup": target.name, "problems": verify(target)}))
        return 0
    if args.command == "import-legacy":
        target = import_legacy(args.files, args.backups, args.reason, pristine=not args.non_pristine)
        print(json.dumps({"backup": target.name, "problems": verify(target)}))
        return 0
    names = [n for n in args.confirm.split(",") if n]
    removed = prune(args.backups, args.live_db, names, service_healthy, datetime.now(UTC))
    print(json.dumps({"removed": removed}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

- [ ] **Step 4: 运行测试，确认通过**

运行：`cd ~/playground/powercontext/ops && ../.venv/bin/python -m unittest test_pc_backup -v`
预期：7 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
cd ~/playground/powercontext && git add ops/pc_backup.py ops/test_pc_backup.py && git commit -q -m "feat: add verified PowerContext backup tooling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 身份核验脚本 `ops/verify_access.py`

**Files:**
- Create: `~/playground/powercontext/ops/verify_access.py`
- Create: `~/playground/powercontext/ops/test_verify_access.py`

**Interfaces:**
- Produces: `verify_principals(credentials: list[dict], fetch: Callable[[str], dict]) -> list[dict]`，返回值只包含 `credential_id`、`expected`、`actual`、`ok` 四个字段，不包含 token。

- [ ] **Step 1: 写失败测试**

```python
# ops/test_verify_access.py
import unittest

import verify_access as v


class VerifyTest(unittest.TestCase):
    def test_reports_mismatch_without_tokens(self):
        creds = [
            {"credential_id": "a", "principal_id": "coordinator-lead", "token": "tok-a"},
            {"credential_id": "b", "principal_id": "coordinator-advisor", "token": "tok-b"},
        ]
        answers = {"Bearer tok-a": {"principal": {"id": "coordinator-lead"}}, "Bearer tok-b": {"principal": {"id": "codex-macmini"}}}
        rows = v.verify_principals(creds, lambda auth: answers[auth])
        self.assertEqual([r["ok"] for r in rows], [True, False])
        self.assertNotIn("tok-", repr(rows))

    def test_fetch_failure_is_reported_not_raised(self):
        creds = [{"credential_id": "a", "principal_id": "x", "token": "t"}]

        def boom(_auth):
            raise OSError("refused")

        rows = v.verify_principals(creds, boom)
        self.assertEqual(rows[0]["actual"], None)
        self.assertFalse(rows[0]["ok"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`cd ~/playground/powercontext/ops && ../.venv/bin/python -m unittest test_verify_access -v`
预期：失败，`ModuleNotFoundError`。

- [ ] **Step 3: 实现**

```python
# ops/verify_access.py
"""逐个 Principal 调用 /v1/access/me，核对凭据对应的身份；输出中不包含 token。"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Callable

BASE = "http://127.0.0.1:8787"


def verify_principals(credentials: list[dict], fetch: Callable[[str], dict]) -> list[dict]:
    rows = []
    for item in credentials:
        try:
            actual = fetch(f"Bearer {item['token']}").get("principal", {}).get("id")
        except Exception:
            actual = None
        rows.append({"credential_id": item["credential_id"], "expected": item["principal_id"], "actual": actual, "ok": actual == item["principal_id"]})
    return rows


def _fetch(authorization: str) -> dict:
    request = urllib.request.Request(BASE + "/v1/access/me", headers={"Authorization": authorization})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def main() -> int:
    root = Path(os.environ.get("POWERCONTEXT_OPS_ROOT", Path.home() / "playground/powercontext"))
    data = json.loads((root / "principals.json").read_text())
    rows = verify_principals(data["credentials"], _fetch)
    print(json.dumps(rows, ensure_ascii=False, indent=2))
    return 0 if all(r["ok"] for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: 运行测试，确认通过**

运行：`cd ~/playground/powercontext/ops && ../.venv/bin/python -m unittest test_verify_access -v`
预期：2 个测试 PASS。

- [ ] **Step 5: 用现有凭据实测（只读，不需要确认）**

运行：`cd ~/playground/powercontext && POWERCONTEXT_OPS_ROOT=$PWD .venv/bin/python ops/verify_access.py`
预期：7 行全部 `"ok": true`（`server-token`、`codex-macmini`、`zcode-macmini`、`dashboard-admin`、3 个 coordinator 凭据）。如果有 `false`，停下来报告，不继续往下做。

- [ ] **Step 6: 提交**

```bash
cd ~/playground/powercontext && git add ops/verify_access.py ops/test_verify_access.py && git commit -q -m "feat: add principal identity verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 迁移前备份，并整理历史备份

**Files:** 只操作 `~/playground/powercontext/backups/`，代码不变。

- [ ] **Step 1: 做一份迁移前的新备份（停下，请用户确认）**

```bash
cd ~/playground/powercontext
.venv/bin/python ops/pc_backup.py backup --reason pre-migration --operation powercontext-migration-20261008
```

预期：输出 `{"backup": "<时间>-pre-migration", "problems": []}`。

- [ ] **Step 2: 把历史备份迁入统一目录，并标记为"非原样"（停下，请用户确认）**

```bash
cd ~/playground/powercontext
AS="$HOME/Library/Application Support/powercontext/backups"
.venv/bin/python ops/pc_backup.py import-legacy --non-pristine --reason legacy-pre-scope-cleanup-0922 "$AS/powercontext-pre-scope-cleanup-20260922-160744.db"
.venv/bin/python ops/pc_backup.py import-legacy --non-pristine --reason legacy-pre-likofu-retry-0923 "$AS/powercontext-pre-likofu-topic-retry-20260923T125407Z.db"
.venv/bin/python ops/pc_backup.py import-legacy --non-pristine --reason legacy-pre-low-production-0924 "$AS/powercontext-pre-low-production-retry-20260924T033033Z.db"
.venv/bin/python ops/pc_backup.py import-legacy --non-pristine --reason legacy-demo-db-0923 ~/powercontext-demo/powercontext.db.bak-20260923-123125
.venv/bin/python ops/pc_backup.py import-legacy --reason legacy-config-0923 ~/powercontext-demo/.env.bak-20260923 ~/powercontext-demo/principals.json.bak-20260923-123125
.venv/bin/python ops/pc_backup.py import-legacy --reason legacy-config-1004 ~/powercontext-demo/principals.json.bak-coordinator-20261004T073451Z
```

`multi-principal-20260922-183342/`、`low-config-20260924T032108Z/` 这两个是目录，先 `ls -la` 列出内容，再对其中的文件逐个执行 `import-legacy`。这里不导入 `-shm`/`-wal` 文件：备份中的 WAL 文件大小为 0，而 `-shm` 的修改时间晚于备份时间，正说明这些备份后来被打开过。

- [ ] **Step 3: 盘点**

运行：`.venv/bin/python ops/pc_backup.py inventory`
预期：`pre-migration` 是唯一 `counts_as_recovery_point: true` 的备份；所有 `legacy-*` 都是 `valid: true, pristine: false`。

- [ ] **Step 4: 记录**

不提交（`backups/` 在 `.gitignore` 中）。把盘点输出里的名称、大小和 `over_threshold` 的值写进最后的交付说明。

---

### Task 5: 切换 LaunchAgent 到新路径

**Files:**
- Modify: `~/Library/LaunchAgents/com.local.powercontext-multi-principal.plist`（`ProgramArguments[1]`、`[3]`、`[7]`）

- [ ] **Step 1: 备份 plist（停下，请用户确认）**

```bash
cp -p ~/Library/LaunchAgents/com.local.powercontext-multi-principal.plist ~/playground/powercontext/archive/com.local.powercontext-multi-principal.plist.before-migration
```

- [ ] **Step 2: 修改路径（停下，请用户确认）**

```bash
P=~/Library/LaunchAgents/com.local.powercontext-multi-principal.plist
plutil -replace ProgramArguments.1 -string "$HOME/playground/powercontext/multi_principal_server.py" "$P"
plutil -replace ProgramArguments.3 -string "$HOME/playground/powercontext/.env" "$P"
plutil -replace ProgramArguments.7 -string "$HOME/playground/powercontext/principals.json" "$P"
plutil -lint "$P"
plutil -p "$P" | grep -n "powercontext"
```

预期：`lint` 返回 OK；不再出现 `powercontext-demo`。

- [ ] **Step 3: 重新加载服务（停下，请用户确认；服务会中断几秒）**

```bash
launchctl bootout gui/$(id -u)/com.local.powercontext-multi-principal
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.powercontext-multi-principal.plist
```

如果 `bootstrap` 失败，立即用 Step 1 的备份恢复：

```bash
cp -p ~/playground/powercontext/archive/com.local.powercontext-multi-principal.plist.before-migration ~/Library/LaunchAgents/com.local.powercontext-multi-principal.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.powercontext-multi-principal.plist
```

- [ ] **Step 4: 验证**

```bash
sleep 3
ps -axo pid,command | grep multi_principal_server | grep -v grep
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/health/ready
cd ~/playground/powercontext && .venv/bin/python ops/verify_access.py
```

预期：进程参数指向 `~/playground/powercontext`；返回 `200`；7 行全部 `ok`。

---

### Task 6: 更新环境脚本、ZCode 脚本和文档

**Files:**
- Modify: `~/.config/powercontext/codex-env.zsh`（2 处）、`codex-env.fish`（1 处）、`set-codex-launchd-env.sh`（1 处）
- Modify: `~/playground/powercontext/configure_zcode_powercontext.py:29`
- Modify: `~/.codex/POWERCONTEXT_MULTI_PRINCIPAL_RUNBOOK.md`、`~/.codex/memories/MEMORY.md`

- [ ] **Step 1: 停下，请用户确认后替换路径**

```bash
for f in ~/.config/powercontext/codex-env.zsh ~/.config/powercontext/codex-env.fish ~/.config/powercontext/set-codex-launchd-env.sh; do
  cp -p "$f" ~/playground/powercontext/archive/"$(basename "$f")".before-migration
  sed -i '' 's#/Users/macmini/powercontext-demo/#/Users/macmini/playground/powercontext/#g' "$f"
done
grep -n "powercontext" ~/.config/powercontext/codex-env.zsh ~/.config/powercontext/codex-env.fish ~/.config/powercontext/set-codex-launchd-env.sh
```

- [ ] **Step 2: 刷新 launchd 环境，并在新 shell 中实测（不输出 token）**

```bash
launchctl kickstart -k gui/$(id -u)/com.local.powercontext.codex-env
zsh -ic '[ -n "$POWERCONTEXT_CODEX_AUTHORIZATION" ] && echo zsh-ok || echo zsh-missing'
fish -c '[ -n "$POWERCONTEXT_CODEX_AUTHORIZATION" ]; and echo fish-ok; or echo fish-missing'
launchctl getenv POWERCONTEXT_CODEX_AUTHORIZATION >/dev/null && echo launchd-ok
```

预期：`zsh-ok`、`fish-ok`、`launchd-ok`。

- [ ] **Step 3: 修改 ZCode 脚本的默认路径并提交**

把 `configure_zcode_powercontext.py` 中的 `default=Path.home() / "powercontext-demo/principals.json",` 改为 `default=Path.home() / "playground/powercontext/principals.json",`，然后：

```bash
cd ~/playground/powercontext && git add configure_zcode_powercontext.py && git commit -q -m "chore: point ZCode setup at relocated credentials

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: 停下，请用户确认后更新 Codex 文档**

```bash
cp -p ~/.codex/POWERCONTEXT_MULTI_PRINCIPAL_RUNBOOK.md ~/playground/powercontext/archive/RUNBOOK.before-migration.md
sed -i '' 's#/Users/macmini/powercontext-demo#/Users/macmini/playground/powercontext#g' ~/.codex/POWERCONTEXT_MULTI_PRINCIPAL_RUNBOOK.md
grep -n "powercontext-demo" ~/.codex/memories/MEMORY.md
```

`MEMORY.md` 只修改仍指向当前部署路径的那几行，具体改法列给用户确认后再执行。`rollout_summaries/` 和 `raw_memories.md` 是历史记录，不修改。

- [ ] **Step 5: 验证 ZCode 的 MCP**

请用户在 ZCode 中发起一次 PowerContext 读取（例如 `get_scope`），确认能够返回结果。本会话不代替 ZCode 发起调用。

---

### Task 7: 清理官方启动器

**Files:**
- Move: `~/Library/LaunchAgents/com.oceanbase.powercontext.plist` → `~/playground/powercontext/archive/`
- Move: `~/Library/Application Support/powercontext/logs/launchd-retry*` → `~/playground/powercontext/archive/launchd-retry/`

- [ ] **Step 1: 确认它确实没有在用（只读）**

```bash
launchctl print gui/$(id -u)/com.oceanbase.powercontext 2>&1 | head -3
ls -la "$HOME/Library/Application Support/powercontext/logs/" | grep launchd-retry
```

预期：`launchctl print` 报告找不到该服务。如果它已经加载，停下来报告，不做任何清理。

- [ ] **Step 2: 停下，请用户确认后归档并移出**

```bash
mkdir -p ~/playground/powercontext/archive/launchd-retry
mv ~/Library/LaunchAgents/com.oceanbase.powercontext.plist ~/playground/powercontext/archive/
mv "$HOME/Library/Application Support/powercontext/logs/"launchd-retry* ~/playground/powercontext/archive/launchd-retry/
ls ~/Library/LaunchAgents | grep -i powercontext
```

预期：只剩 `com.local.powercontext-multi-principal.plist` 和 `com.local.powercontext.codex-env.plist`。

- [ ] **Step 3: 确认服务不受影响**

运行：`curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/health/ready`
预期：`200`。

---

### Task 8: 清理旧备份和旧目录

**Files:** 删除操作，每一项都要用户确认。

- [ ] **Step 1: 列出清理候选**

运行：`cd ~/playground/powercontext && .venv/bin/python ops/pc_backup.py inventory`

把 `prune_candidates`、所有 `legacy-*` 的大小和总量列给用户。`legacy-*` 都标记为非原样、不算恢复点，并且创建时间都在 30 天以内，所以通常不会出现在候选列表中。是否删除由用户逐项决定；用户点名删除时执行：

```bash
rm -rf ~/playground/powercontext/backups/<用户点名的目录>
```

- [ ] **Step 2: 删除已迁入统一目录的原始备份文件（停下，请用户确认）**

先核对每个原始文件的 sha256 与对应 `legacy-*` manifest 中的记录一致：

```bash
shasum -a 256 "$HOME/Library/Application Support/powercontext/backups/"*.db ~/powercontext-demo/*.bak* 
```

一致后，按用户确认的清单删除 `Application Support/powercontext/backups/` 下对应的 `.db`、`-shm`、`-wal` 文件，以及已迁入的两个子目录。

- [ ] **Step 3: 删除旧目录（停下，请用户确认）**

前提条件：Task 5–7 的验证全部通过，并且服务已经在新路径上至少运行过一次完整的 Codex 会话。

```bash
grep -rl "powercontext-demo" ~/Library/LaunchAgents ~/.config/powercontext 2>/dev/null
rm -rf ~/powercontext-demo
```

`grep` 必须没有任何输出，才能执行 `rm`。

- [ ] **Step 4: 最终验证**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/health/ready
cd ~/playground/powercontext && .venv/bin/python ops/verify_access.py && .venv/bin/python ops/pc_backup.py inventory | head -40
```

预期：返回 `200`，所有身份 `ok`，盘点结果中没有无效备份。
