import { createServer as createNetServer } from "node:net";
import { logger } from "../utils/logger";
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

type BindOutcome = { kind: "bound" } | { kind: "timeout" } | { kind: "error"; code?: string };

export class NetDaemonPortAvailabilityChecker implements DaemonPortAvailabilityChecker {
  /**
   * Per-host answer to "can this address host a listener at all?", learned from
   * an ephemeral-port bind the first time a codeless bind error needs it.
   */
  private readonly hostBindable = new Map<string, boolean>();

  constructor(private readonly createListener: () => ProbeListener = createNetServer) {}

  async isPortFree(
    port: number,
    host: string,
    timeoutMs: number = DAEMON_PORT_AVAILABILITY_PROBE_TIMEOUT_MS,
  ): Promise<boolean> {
    const probeTimeoutMs = Math.min(DAEMON_PORT_AVAILABILITY_PROBE_TIMEOUT_MS, timeoutMs);
    if (probeTimeoutMs <= 0) {
      // No budget left to learn anything: report the port as bound so callers
      // fail closed rather than launching a second daemon on unverified state.
      return false;
    }
    const deadline = defaultTimer.now() + probeTimeoutMs;
    const outcome = await this.bind(port, host, probeTimeoutMs);
    if (outcome.kind !== "error") {
      return outcome.kind === "bound";
    }
    if (outcome.code !== undefined) {
      return UNBINDABLE_ADDRESS_ERROR_CODES.has(outcome.code);
    }
    // Bun's `node:net` reports an address with no loopback configured (`::1`
    // on an IPv6-less container) as a codeless error, indistinguishable from a
    // conflict on its own. An ephemeral-port bind cannot conflict, so if that
    // fails too the address cannot host any incumbent.
    return !(await this.isHostBindable(host, deadline - defaultTimer.now()));
  }

  private async isHostBindable(host: string, budgetMs: number): Promise<boolean> {
    const cached = this.hostBindable.get(host);
    if (cached !== undefined) {
      return cached;
    }
    if (budgetMs <= 0) {
      // Inconclusive: assume bindable so the codeless failure reads as occupied.
      return true;
    }
    const outcome = await this.bind(0, host, budgetMs);
    if (outcome.kind === "timeout") {
      return true;
    }
    const bindable =
      outcome.kind === "bound" ||
      (outcome.code !== undefined && !UNBINDABLE_ADDRESS_ERROR_CODES.has(outcome.code));
    if (!bindable) {
      // Safe to swallow: an ephemeral-port bind cannot be busy, so this means
      // the address itself is absent and no daemon can be listening on it.
      logger.debug(`[DaemonPortAvailability] ${host} cannot host a listener on this machine`);
    }
    this.hostBindable.set(host, bindable);
    return bindable;
  }

  private bind(port: number, host: string, timeoutMs: number): Promise<BindOutcome> {
    return new Promise((resolvePromise) => {
      const probeServer = this.createListener();
      let settled = false;
      const finish = (result: BindOutcome): void => {
        if (settled) {
          return;
        }
        settled = true;
        defaultTimer.clearTimeout(timeoutHandle);
        probeServer.close(() => resolvePromise(result));
      };
      const timeoutHandle = defaultTimer.setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
      probeServer.once("error", (bindError) => finish({ kind: "error", code: bindError.code }));
      probeServer.listen(port, host, () => finish({ kind: "bound" }));
    });
  }
}
