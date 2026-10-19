# Source manifest

The initial monorepo import copied these clean source revisions:

| Module | Source revision | Destination |
|---|---|---|
| CLI Session Task MCP | `64ba562b567cacb821c66bace1024f7e24f182f9` | `packages/task-service` |
| Codex Session Coordinator | `5ea544ad274e5cc12425ed2426f2b91494c7b153` | `packages/coordinator` |

The source `.git` directories, dependency folders, build output and runtime state were
excluded. The original package manifests and tests remain in their respective package
directories until the workspace-level dependency consolidation is complete.
