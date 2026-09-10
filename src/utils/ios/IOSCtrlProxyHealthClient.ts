import { DefaultHostCommandExecutor, type HostCommandExecutor } from "../HostCommandExecutor";
import type { Timer } from "../SystemTimer";
import { logger } from "../logger";

/**
 * Single source of truth for "is this a usable TCP port number".
 * Shared by the health client and {@link IOSCtrlProxyManager}.
 */
export function isValidCtrlProxyPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}

/**
 * Host/transport context the health client needs to reach a runner. Supplied by
 * {@link IOSCtrlProxyManager} so the client stays agnostic of remote gating
 * and device identity.
 */
export interface CtrlProxyHealthContext {
  /** true when reaching the runner through the remote daemon (Docker). */
  useRemoteRunner(): boolean;
  /** Host to probe when {@link useRemoteRunner} is true. */
  getHost(): string;
  /** The device this manager owns; used to reject cross-device runners. */
  readonly deviceId: string;
}

/**
 * Reads and interprets the CtrlProxy iOS runner `/health` endpoint.
 *
 * Extracted from {@link IOSCtrlProxyManager} (issue #3218) so runner-readiness /
 * health-poll decisions live in one focused, injectable collaborator. Behavior is
 * unchanged: local probes go through `curl` on the injected {@link HostCommandExecutor}
 * and remote probes use `fetch` with a timer-driven abort, exactly as before.
 */
export class IOSCtrlProxyHealthClient {
  private static readonly FETCH_TIMEOUT_MS = 2000;

  public constructor(
    private readonly processExecutor: HostCommandExecutor = new DefaultHostCommandExecutor(),
    private readonly timer: Timer,
    private readonly context: CtrlProxyHealthContext,
  ) {}

  /**
   * Loose liveness check: the runner answered `/health` with an "ok"/"healthy"
   * body. Does not require device identity — used to gate spawn/restart on any
   * responding runner on the port.
   */
  public async checkHealthEndpointOnPort(port: number, timeoutMs?: number): Promise<boolean> {
    const body = await this.readHealthEndpointBodyOnPort(port, timeoutMs);
    return body !== null && (body.includes("ok") || body.includes("healthy"));
  }

  /**
   * Device-identity-aware `/health` check: the runner answered with
   * `status === "ok"` and its reported `deviceId` is compatible with the
   * requested `deviceId`, per `options.requireDeviceId`:
   *
   * - **compat (`requireDeviceId: false`)** — a MISSING `deviceId`
   *   still counts as a match (an older runner build, or the env-injection
   *   fallback #2731 that can drop the device-id var along with the port).
   *   Used by the primary liveness gate (`isRunning`/`waitForHealthEndpoint`
   *   in {@link IOSCtrlProxyManager}) so those older/degraded runners are not
   *   spuriously treated as down.
   * - **strict (default)** — a MISSING `deviceId` is rejected;
   *   only an exact match counts. Used by ownership/forced-teardown decisions
   *   (issue #6415 follow-up) where adopting a foreign responder that omits
   *   `deviceId` — a sibling simulator's runner, or another process entirely —
   *   could mistake it for this device's runner.
   *
   * Both modes reject a payload whose `deviceId` is PRESENT but different — a
   * sibling simulator's runner or the Android runner answering the same/default
   * port (whose plain-text `OK` body also fails the JSON parse below). This is
   * the one place that decides "what counts as our runner" (issue #6415);
   * callers must not re-derive identity themselves.
   */
  public async checkHealthEndpointOnPortForDevice(
    port: number,
    deviceId: string,
    timeoutMs?: number,
    options?: { requireDeviceId?: boolean },
  ): Promise<boolean> {
    const body = await this.readHealthEndpointBodyOnPort(port, timeoutMs);
    if (body === null) {
      return false;
    }

    try {
      const health = JSON.parse(body) as { status?: unknown; deviceId?: unknown };
      if (health.status !== "ok") {
        return false;
      }
      if (options?.requireDeviceId !== false) {
        return health.deviceId === deviceId;
      }
      return health.deviceId === undefined || health.deviceId === deviceId;
    } catch (error) {
      // Malformed/non-JSON health body means we can't trust this runner's identity; treat it as not matching.
      logger.debug(`src/utils/ios/IOSCtrlProxyHealthClient.ts fallback failed: ${error}`, error);
      return false;
    }
  }

  /**
   * The port the runner self-reports in its `/health` payload, or null. Only
   * accepted when `status === "ok"` and the reported `deviceId` matches this
   * manager's device, so a cross-device runner is never adopted.
   */
  public async readReportedPortFromHealth(port: number): Promise<number | null> {
    const body = await this.readHealthEndpointBodyOnPort(port);
    if (body === null) {
      return null;
    }
    try {
      const health = JSON.parse(body) as { status?: unknown; deviceId?: unknown; port?: unknown };
      if (health.status !== "ok") {
        return null;
      }
      if (health.deviceId !== this.context.deviceId) {
        return null;
      }
      return isValidCtrlProxyPort(health.port) ? health.port : null;
    } catch (error) {
      // Malformed/non-JSON health body means we can't confirm the reported port belongs to this device; null it out.
      logger.debug(`src/utils/ios/IOSCtrlProxyHealthClient.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  /**
   * Raw `/health` body, or null when the runner does not answer. Local probes use
   * `curl` (bounded by `--max-time`); remote probes use `fetch` bounded by a
   * timer-driven `AbortController`.
   */
  public async readHealthEndpointBodyOnPort(
    port: number,
    timeoutMs?: number,
  ): Promise<string | null> {
    try {
      const requestTimeoutMs = Math.min(
        IOSCtrlProxyHealthClient.FETCH_TIMEOUT_MS,
        Math.max(1, timeoutMs ?? IOSCtrlProxyHealthClient.FETCH_TIMEOUT_MS),
      );
      const host = this.context.useRemoteRunner() ? this.context.getHost() : "localhost";
      if (this.context.useRemoteRunner()) {
        const controller = new AbortController();
        const timeoutId = this.timer.setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const response = await fetch(`http://${host}:${port}/health`, {
            signal: controller.signal,
          });
          return await response.text();
        } finally {
          this.timer.clearTimeout(timeoutId);
        }
      }

      // Use curl to check the health endpoint locally
      const { stdout } = await this.processExecutor.executeCommand(
        "curl",
        ["-s", "--max-time", String(requestTimeoutMs / 1000), `http://${host}:${port}/health`],
        { timeoutMs: requestTimeoutMs },
      );
      return stdout;
    } catch (error) {
      // No runner listening on this port (connection refused/timeout) is the expected case; null means "not up yet".
      logger.debug(`src/utils/ios/IOSCtrlProxyHealthClient.ts fallback failed: ${error}`, error);
      return null;
    }
  }
}
