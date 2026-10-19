import assert from 'node:assert/strict';
import test from 'node:test';

test('heartbeat reporter prints only on failure and on recovery, not every beat', async () => {
  const { heartbeatReporter } = await import('../src/lead-launch.js');
  const lines: string[] = [];
  const report = heartbeatReporter((line) => lines.push(line));
  report.succeeded(); report.failed('RUNTIME_DISCONNECTED'); report.failed('RUNTIME_DISCONNECTED'); report.failed('FORBIDDEN'); report.succeeded(); report.succeeded();
  assert.deepEqual(lines, ['[Coordinator] lead heartbeat failing (RUNTIME_DISCONNECTED); retrying quietly every 20s.\n', '[Coordinator] lead heartbeat failing (FORBIDDEN); retrying quietly every 20s.\n', '[Coordinator] lead heartbeat restored.\n']);
});
