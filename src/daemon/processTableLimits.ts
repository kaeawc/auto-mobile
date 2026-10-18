import { DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS } from "./constants";

export const DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * Floor the process-table scan timeout is clamped to (issue #6140 review). Node's
 * (and Bun's) `execSync` treats `timeout: 0` as "no timeout" — i.e. UNBOUNDED, the
 * opposite of "expire immediately" — not a short/immediate bound. A computed
 * remaining budget can legitimately be exactly `0`, so `boundedProcessTableScanTimeout`
 * must never forward that value as-is: doing so would silently remove the bound
 * this scan exists to enforce. Callers with zero budget remaining should skip the
 * scan entirely (as `tryJoinPeerDaemonAfterSpawnExit` already does); this floor is
 * defense-in-depth for any other caller of `findDaemonProcesses`/
 * `findLiveDaemonProcesses` that does not pre-check for a zero budget.
 */
export const MIN_PROCESS_TABLE_SCAN_TIMEOUT_MS = 1;

export function boundedProcessTableScanTimeout(timeoutMs: number | undefined): number {
  return Math.max(
    MIN_PROCESS_TABLE_SCAN_TIMEOUT_MS,
    Math.min(
      timeoutMs ?? DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS,
      DAEMON_PROCESS_TABLE_SCAN_TIMEOUT_MS,
    ),
  );
}
