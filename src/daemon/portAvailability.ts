import { createServer as createNetServer } from "node:net";
import { defaultTimer } from "../utils/SystemTimer";
import { DAEMON_PORT_AVAILABILITY_PROBE_TIMEOUT_MS } from "./constants";

/**
 * Confirms whether a TCP port is free to bind, from the MANAGER side (issue
 * #6260) — independent of process-table detection. `restart()` uses this as a
 * last line of defense right before `start()`: even when process discovery
 * believes every prior AutoMobile daemon was stopped, a still-bound canonical
 * port is definitive proof one was not, and `start()`'s own `findAvailablePort`
 * would otherwise silently fall back to the next port in range and report
 * unqualified success — precisely the split-brain #6260 describes.
 */
export interface DaemonPortAvailabilityChecker {
  /**
   * `timeoutMs` caps the probe under the caller's remaining budget (issue #7001);
   * the checker never waits longer than its own default probe timeout either way.
   */
  isPortFree(port: number, host: string, timeoutMs?: number): Promise<boolean>;
}

/**
 * Minimal listener surface the port probe needs; `node:net`'s `Server` satisfies
 * it and tests substitute an in-memory emitter.
 */
export interface ProbeListener {
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  listen(port: number, host: string, listeningListener: () => void): unknown;
  close(callback: () => void): unknown;
}

/**
 * Bind errors that mean the ADDRESS cannot host a listener at all (e.g. `::1`
 * on a container without IPv6 loopback), so no incumbent can be bound there.
 * Every other bind failure keeps the fail-closed "port is occupied" reading.
 */
const UNBINDABLE_ADDRESS_ERROR_CODES = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

export class NetDaemonPortAvailabilityChecker implements DaemonPortAvailabilityChecker {
  constructor(private readonly createListener: () => ProbeListener = createNetServer) {}

  isPortFree(
    port: number,
    host: string,
    timeoutMs: number = DAEMON_PORT_AVAILABILITY_PROBE_TIMEOUT_MS,
  ): Promise<boolean> {
    const probeTimeoutMs = Math.min(DAEMON_PORT_AVAILABILITY_PROBE_TIMEOUT_MS, timeoutMs);
    if (probeTimeoutMs <= 0) {
      // No budget left to learn anything: report the port as bound so callers
      // fail closed rather than launching a second daemon on unverified state.
      return Promise.resolve(false);
    }
    return new Promise((resolvePromise) => {
      const probeServer = this.createListener();
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        defaultTimer.clearTimeout(timeoutHandle);
        probeServer.close(() => resolvePromise(result));
      };
      const timeoutHandle = defaultTimer.setTimeout(() => finish(false), probeTimeoutMs);
      probeServer.once("error", (bindError) =>
        finish(bindError.code !== undefined && UNBINDABLE_ADDRESS_ERROR_CODES.has(bindError.code)),
      );
      probeServer.listen(port, host, () => finish(true));
    });
  }
}
