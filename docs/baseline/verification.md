# Baseline verification

The source projects were clean at migration time and were copied into this repository
without their `.git`, `node_modules`, build output or runtime state.

Known environment constraints at the baseline:

- The host Node version was `24.16.0`; the task service requires `>=24.19.0`.
- The task service uses a private `@leke` npm registry and needs valid npm credentials.
- Coordinator typecheck/build can run on this host, but its complete suite contains
  Unix/Herdr/Kitty assumptions and Windows symlink-permission failures.

The baseline is considered complete when the migration branch records the exact output
of the package checks after the Windows runtime changes. Do not label a full migration
as passing while private registry installation or platform-specific checks are skipped.
