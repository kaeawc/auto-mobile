import { logger } from "./logger";
import type { PortAvailabilityChecker } from "./PortManager";

type BunTcpServer = {
  stop(force?: boolean): void;
};

export type BunRuntime = {
  listen(options: {
    hostname: string;
    port: number;
    socket: {
      open(socket: unknown): void;
      data(socket: unknown, data: unknown): void;
      drain(socket: unknown): void;
      close(socket: unknown): void;
      error(socket: unknown, error: Error): void;
    };
  }): BunTcpServer;
};

const noopSocketHandler = {
  open(): void {},
  data(): void {},
  drain(): void {},
  close(): void {},
  error(): void {},
};

/**
 * Errno codes that mean "the address family itself isn't available on this
 * host" (no IPv6 loopback configured, etc.). Only these (or a codeless error)
 * on the one-time ::1 ephemeral-port probe mark IPv6 as absent — anything
 * else (including resource errors like `EMFILE`) must not be read as
 * "family unavailable, so allocate".
 */
const FAMILY_UNAVAILABLE_CODES = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

function errnoCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Bind-probe based `PortAvailabilityChecker`. Takes the `BunRuntime` as a
 * constructor seam (defaulting to `globalThis.Bun`) so tests can inject a
 * fake runtime instead of mutating the process-global `Bun.listen`.
 */
export class BunPortAvailabilityChecker implements PortAvailabilityChecker {
  /**
   * Whether this host has an IPv6 loopback at all, decided once per checker
   * by an ephemeral-port bind (see `hasIpv6Loopback`). `undefined` until a
   * probe gives a conclusive answer.
   */
  private ipv6LoopbackAvailable: boolean | undefined;

  public constructor(
    private readonly bun: BunRuntime | undefined = (globalThis as { Bun?: BunRuntime }).Bun,
  ) {}

  public isPortAvailable(port: number): boolean {
    const bun = this.bun;
    if (!bun) {
      return true;
    }

    // Clients always dial 127.0.0.1 (AndroidCtrlProxyClient.getWebSocketUrl,
    // PortManager.getWebSocketUrl), so IPv4 is REQUIRED: any bind failure
    // here — busy or otherwise — means the port isn't usable and must fail
    // closed. IPv6 is best-effort: a host with no IPv6 loopback configured
    // (Docker with IPv6 disabled, some CI runners) fails every ::1 bind,
    // which is "that family is unavailable here", not "the port is busy".
    // That is decided once per host (not per port), so a busy ::1 port on a
    // host that DOES have IPv6 still fails closed.
    if (!this.probeRequired(bun, "127.0.0.1", port)) {
      return false;
    }
    if (!this.hasIpv6Loopback(bun)) {
      return true;
    }
    return this.probeRequired(bun, "::1", port);
  }

  /** Any bind failure means the port cannot be used on `hostname`, full stop. */
  private probeRequired(bun: BunRuntime, hostname: string, port: number): boolean {
    let server: BunTcpServer | undefined;
    try {
      server = bun.listen({ hostname, port, socket: noopSocketHandler });
      return true;
    } catch (error) {
      logger.debug(`[PortManager] Port ${port} is not available on ${hostname}: ${error}`);
      return false;
    } finally {
      server?.stop(true);
    }
  }

  /**
   * Binds ::1 on port 0 (ephemeral, so it can never be "busy") to learn
   * whether the IPv6 loopback family exists on this host. A recognized
   * family-unavailable errno, or a codeless error (Bun throws a bare
   * `Error("Failed to listen at ::1")` with no `code` when ::1 is not
   * configured), means IPv6 loopback is absent and the answer is cached.
   * Any other errno (e.g. `EMFILE`) is inconclusive: treat IPv6 as present
   * so the per-port probe fails closed, and re-probe on the next call.
   */
  private hasIpv6Loopback(bun: BunRuntime): boolean {
    if (this.ipv6LoopbackAvailable !== undefined) {
      return this.ipv6LoopbackAvailable;
    }
    let server: BunTcpServer | undefined;
    try {
      server = bun.listen({ hostname: "::1", port: 0, socket: noopSocketHandler });
      this.ipv6LoopbackAvailable = true;
      return true;
    } catch (error) {
      const code = errnoCode(error);
      if (code === undefined || FAMILY_UNAVAILABLE_CODES.has(code)) {
        // Safe to swallow: an ephemeral-port bind cannot be busy, so this
        // failure means the host has no IPv6 loopback; 127.0.0.1 is still
        // probed strictly for every port.
        logger.debug(`[PortManager] ::1 unavailable on this host, skipping IPv6 probes: ${error}`);
        this.ipv6LoopbackAvailable = false;
        return false;
      }
      logger.debug(`[PortManager] ::1 family probe inconclusive, probing per port: ${error}`);
      return true;
    } finally {
      server?.stop(true);
    }
  }
}
