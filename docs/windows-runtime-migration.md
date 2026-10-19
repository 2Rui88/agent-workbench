# Windows Runtime migration

## Rules

1. Keep the Task MCP HTTP endpoint for Codex and Claude compatibility.
2. Replace coordinator Unix IPC with a Windows Named Pipe by default, with a localhost
   TCP fallback for diagnostics and tests.
3. Use Node path APIs and canonical paths everywhere; do not compare path strings.
4. Use a process supervisor for every Agent. PID is metadata, not process ownership.
5. Use Windows Terminal for Kitty behavior. Herdr remains a browser observer.
6. Do not expose arbitrary terminal commands from the browser without task binding,
   authentication, audit and an explicit approval policy.

## Current implementation

`packages/windows-runtime/src` currently provides the shared path and endpoint primitives
and a Windows process supervisor that stops a process tree with `taskkill`. A native
Job Object adapter is the next increment; the supervisor interface is intentionally
stable so that adapter can be added without changing coordinator code.
