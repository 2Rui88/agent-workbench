// The lead shares the terminal with its supervisor log: report heartbeat state changes only, never every beat.
export function heartbeatReporter(write: (line: string) => void): { failed(code: string): void; succeeded(): void } {
  let failing: string | undefined;
  return {
    failed(code) { if (failing !== code) write(`[Coordinator] lead heartbeat failing (${code}); retrying quietly every 20s.\n`); failing = code; },
    succeeded() { if (failing !== undefined) write('[Coordinator] lead heartbeat restored.\n'); failing = undefined; }
  };
}
