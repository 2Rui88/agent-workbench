# Unified Windows CLI

The CLI owns local process lifecycle only. It does not bypass Task MCP task gates or
Coordinator authorization.

## Initialize

```powershell
node apps/cli/dist/main.js init
```

To initialize the Coordinator runtime on Windows after the workbench config exists:

```powershell
node apps/cli/dist/main.js init-coordinator
```

This creates the runtime JSON, role credentials, SQLite state, and a portable socket
path that is converted to a Windows Named Pipe by the Coordinator. Create the separate
human approval credential interactively before enabling the Coordinator service:

```powershell
node packages/coordinator/dist/scripts/human-control.js <runtime.json> init
```

The command prompts for an explicit `yes`; the human credential is never printed. After it succeeds, enable the service without editing JSON manually:

```powershell
node apps/cli/dist/main.js enable-coordinator
```

The generated configuration contains two service entries:

- `task-service`, enabled by default;
- `coordinator`, disabled until a valid coordinator runtime and human credential exist.

Build the service packages before starting them:

```powershell
npm run build:task
npm run build:coordinator
npm run build:cli
```

## Start and inspect

```powershell
node apps/cli/dist/main.js start --service task-service
node apps/cli/dist/main.js status
```

After `group-init` and human credential initialization, enable the coordinator service
or select it explicitly:

```powershell
node apps/cli/dist/main.js start --service coordinator
node apps/cli/dist/main.js status
node apps/cli/dist/main.js stop
```

Each service gets a separate log under `dataDir`. The CLI records PIDs and only stops
the processes it recorded, using `taskkill /T /F` on Windows.

`doctor` checks the host prerequisites and the migrated package sources. Unix Kitty mode requires the `kitty` executable. On Windows, `kitty:start` keeps the same mode entry point and automatically routes to the native Windows Terminal observer backend when Kitty is unavailable; set `AGENT_WORKBENCH_KITTY_STRICT=1` to require Kitty explicitly. Windows Terminal (`wt.exe`) is optional for the core services and Coordinator Named Pipe runtime:

```powershell
node apps/cli/dist/main.js doctor
```

The coordinator uses a Windows Named Pipe internally even when the runtime config keeps
the portable `socketPath` field. Task MCP continues to use its HTTP `/mcp` endpoint for
Codex and Claude compatibility.

## Windows Terminal observer backend

Windows uses a native `wt.exe` observer backend instead of the Unix Kitty launcher. After the Coordinator runtime is initialized, start the five observer tabs with:

```powershell
npm --prefix packages/coordinator run windows-terminal:start -- <runtime.json>
```

The backend opens one overview tab and four role tabs. Each tab runs the existing bounded observer renderer. It requires Windows Terminal to be installed and available as `wt.exe`; it does not require Linux, WSL, Kitty, or a Unix socket.
