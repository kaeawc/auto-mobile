/**
 * CtrlProxy accessibility-service recovery state machine, extracted from `AndroidCtrlProxyClient`
 * (#11846). Behaviour is unchanged: the client keeps the connection hooks and exposes the live
 * state this module needs through {@link AndroidServiceRecoveryContext}.
 */
import type { BootedDevice } from "../../../models";
import type { ProxySetupResult } from "../../../utils/interfaces/ProxyManager";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../../utils/SystemTimer";
import type { ForcedRestartBudget } from "../../../ctrlProxy/ForcedRestartBudget";
import { fixedBackoff } from "../../../utils/Backoff";
import { logger } from "../../../utils/logger";

/**
 * Narrow Android manager seam for connection-failure escalation (issue #7532),
 * analogous to `IOSCtrlProxyClient`'s `serviceManagerFactory`. Exposes only what
 * recovery needs: the binding-health probe, the crashed/unbound rebind added by
 * #7470, a wait for an existing bind, and full setup for a service that is
 * missing or not installed at all. `AndroidCtrlProxyManager` implements all four.
 */
export interface AndroidServiceRecoveryManager {
  isAccessibilityServiceHealthy(): Promise<boolean>;
  rebindIfUnhealthy?(): Promise<boolean>;
  waitForAccessibilityServiceBinding?(): Promise<"already-bound" | "recovered" | "unhealthy">;
  setup(force?: boolean, perf?: PerformanceTracker): Promise<ProxySetupResult>;
}

export type AndroidServiceManagerFactory = (device: BootedDevice) => AndroidServiceRecoveryManager;

export const OBSERVE_RECOVERY_WAIT_MS = 10_000;

type RecoveryOutcome = "healthy" | "repaired" | "unavailable" | "failed";

/** Client-backed accessors resolve live state on every use, including after awaits. */
export interface AndroidServiceRecoveryContext {
  readonly adb: Pick<AdbExecutor, "getDeviceStates">;
  readonly timer: Pick<Timer, "now" | "sleep">;
  readonly deviceId: string;
  readonly device: BootedDevice;
  readonly closed: boolean;
  readonly connectionGeneration: number;
  consecutiveConnectionFailures: number;
  /** Re-entry guard: a burst that has not settled must not start an overlapping recovery. */
  isRecoveringService: boolean;
  recoveryPromise: Promise<boolean> | null;
  readonly forcedRestartBudget: ForcedRestartBudget;
  readonly serviceManagerFactory: AndroidServiceManagerFactory;
  /** True while the post-connect stability timer is armed. */
  readonly restartRearmPending: boolean;
  /** The current socket, compared by identity when a connection proves stable. */
  readonly socket: unknown;
  isConnected(): boolean;
  resetConnectionBudget(): void;
  connectBackgroundWebSocket(): Promise<boolean>;
}

interface PendingRecoveryStability {
  token: number;
  resolve: (stable: boolean) => void;
  eligible: boolean;
  stableSocket: unknown;
}

export class AndroidServiceRecovery {
  private pendingRecoveryStability: PendingRecoveryStability | undefined;
  /** Set when recovery found the device absent; consumed by the next offline-to-online rearm. */
  private deviceSeenAbsent = false;

  constructor(private readonly context: AndroidServiceRecoveryContext) {}

  /** The device re-entered the ready state; rearm only if recovery saw it absent (#11246). */
  rearmAfterDeviceOnline(): void {
    if (!this.deviceSeenAbsent) {
      return;
    }
    this.deviceSeenAbsent = false;
    this.context.forcedRestartBudget.rearm("device back online");
  }

  /** Start a recovery for this observed transport failure if none is pending. */
  ensureStarted(autoReconnectEnabled: boolean): void {
    if (!this.context.closed && autoReconnectEnabled && !this.context.recoveryPromise) {
      this.trigger();
    }
  }

  /** The stability timer fired: settle the pending recovery or credit the restart budget. */
  onStabilityTimerFired(): void {
    const { context } = this;
    if (!context.isConnected()) {
      if (this.pendingRecoveryStability?.eligible) {
        this.failPendingStability("WebSocket closed before stable reconnect");
      }
      return;
    }
    const pending = this.pendingRecoveryStability;
    if (pending) {
      pending.stableSocket = context.socket;
      this.completePendingStability();
    } else if (context.forcedRestartBudget.snapshot().state !== "suspended") {
      context.forcedRestartBudget.recordSuccess();
    }
  }

  /** The socket closed; `timerWasArmed` is whether the stability timer was still pending. */
  onSocketClosed(timerWasArmed: boolean): void {
    if (timerWasArmed && this.pendingRecoveryStability?.eligible) {
      this.failPendingStability("WebSocket closed before stable reconnect");
    }
    if (this.pendingRecoveryStability) {
      this.pendingRecoveryStability.stableSocket = null;
    }
  }

  failPendingStability(reason: string): void {
    const pending = this.pendingRecoveryStability;
    if (pending) {
      this.pendingRecoveryStability = undefined;
      this.context.forcedRestartBudget.recordFailure(reason, pending.token);
      pending.resolve(false);
    }
  }

  /**
   * An absent device never exercised the runner, so its attempt is given back instead of burning
   * a forced-restart slot (#11246); every other unrecovered outcome is a recorded failure.
   */
  private settleUnrecoveredAttempt(outcome: string, token: number): void {
    if (!this.context.closed && outcome === "unavailable") {
      this.releasePendingStability(token);
      return;
    }
    this.failPendingStability(`service recovery ${outcome}`);
    this.context.forcedRestartBudget.recordFailure(`service recovery ${outcome}`, token);
  }

  private releasePendingStability(token: number): void {
    const pending = this.pendingRecoveryStability;
    if (pending?.token === token) {
      this.pendingRecoveryStability = undefined;
      pending.resolve(false);
    }
    this.context.forcedRestartBudget.releaseAttempt(token);
  }

  private completePendingStability(): void {
    const pending = this.pendingRecoveryStability;
    if (
      pending?.eligible &&
      pending.stableSocket === this.context.socket &&
      this.context.isConnected()
    ) {
      this.pendingRecoveryStability = undefined;
      pending.resolve(this.context.forcedRestartBudget.recordSuccess(pending.token));
    }
  }

  /**
   * Trigger CtrlProxy accessibility-service recovery through the manager.
   * Called when repeated WebSocket connection failures indicate the service
   * may be crashed, unbound, or missing (issue #7532). Guarded by
   * `isRecoveringService` so a failure burst cannot start a second, overlapping
   * recovery while one is already in flight.
   */
  trigger(): void {
    const { context } = this;
    if (context.isRecoveringService) {
      return;
    }
    const token = context.forcedRestartBudget.tryBeginAttempt();
    if (token === undefined) {
      return;
    }

    context.isRecoveringService = true;
    logger.info(
      `[AndroidCtrlProxyClient] Triggering CtrlProxy recovery after ${context.consecutiveConnectionFailures} connection failures`,
    );

    // A background reconnect can stabilize while the async health probe is
    // pending. Claim its stability signal with this recovery's token now.
    const replaceStabilityWaiter = (): Promise<boolean> => {
      this.pendingRecoveryStability?.resolve(false);
      return new Promise<boolean>((resolve) => {
        this.pendingRecoveryStability = { token, resolve, eligible: false, stableSocket: null };
      });
    };
    let stableConnection = replaceStabilityWaiter();

    const generation = context.connectionGeneration;
    const recovery = this.recoverAccessibilityService(generation, () => {
      stableConnection = replaceStabilityWaiter();
    })
      .then(async (outcome) => {
        if (context.closed || outcome === "failed" || outcome === "unavailable") {
          this.settleUnrecoveredAttempt(outcome, token);
          return false;
        }
        // A repaired service may clear the foreground connection cooldown;
        // the failure counter and restart budget reset only after reconnect.
        if (outcome === "repaired") {
          // Only an actual rebind/setup or a completed in-progress bind
          // justifies resetting the foreground cooldown early — the service
          // was demonstrably broken and is now fixed. When it was already
          // healthy (#6260: WS refused for an unrelated reason), leave the
          // connection budget alone so the cooldown still gates a background
          // reconnect instead of hammering a socket unrelated to service health.
          // resetConnectionBudget() (issue #7538) also clears the cooldown
          // clock and un-pauses a paused background reconnect, not just the
          // attempt counter.
          context.resetConnectionBudget();
        }
        if (this.pendingRecoveryStability) {
          this.pendingRecoveryStability.eligible = true;
          this.completePendingStability();
        }
        logger.info(
          `[AndroidCtrlProxyClient] Recovery completed (${outcome}); reconnecting WebSocket`,
        );
        // Background reconnect respects the #7537 background-attempt cap
        // rather than consuming the caller's foreground connect budget.
        const connected =
          outcome === "repaired"
            ? await this.connectBackgroundWebSocketAfterRecovery(generation)
            : await context.connectBackgroundWebSocket();
        if (!connected) {
          logger.warn(
            `[AndroidCtrlProxyClient] WebSocket reconnect failed after CtrlProxy recovery`,
          );
        }
        if (!connected || !context.isConnected()) {
          this.failPendingStability("WebSocket reconnect failed");
          return false;
        }
        if (this.pendingRecoveryStability && !context.restartRearmPending) {
          this.failPendingStability("No stable WebSocket reconnect observed");
        }
        context.consecutiveConnectionFailures = 0;
        return await stableConnection;
      })
      .catch((error) => {
        this.failPendingStability(String(error));
        context.forcedRestartBudget.recordFailure(String(error), token);
        logger.warn(`[AndroidCtrlProxyClient] CtrlProxy recovery failed: ${error}`);
        return false;
      })
      .finally(() => {
        // A superseded recovery must not clear a newer attempt's state.
        if (context.recoveryPromise === recovery) {
          context.isRecoveringService = false;
          context.recoveryPromise = null;
        }
      });
    context.recoveryPromise = recovery;
  }

  /** Retry the post-bind socket dial while the accessibility service finishes starting its server. */
  private async connectBackgroundWebSocketAfterRecovery(generation: number): Promise<boolean> {
    const { context } = this;
    const startedAt = context.timer.now();
    const backoff = fixedBackoff(100);
    let attempt = 1;

    while (
      !context.closed &&
      generation === context.connectionGeneration &&
      context.timer.now() - startedAt < OBSERVE_RECOVERY_WAIT_MS
    ) {
      const connected = await context.connectBackgroundWebSocket();
      if (connected) {
        return (
          !context.closed &&
          generation === context.connectionGeneration &&
          context.timer.now() - startedAt <= OBSERVE_RECOVERY_WAIT_MS
        );
      }

      const remainingMs = OBSERVE_RECOVERY_WAIT_MS - (context.timer.now() - startedAt);
      if (context.closed || generation !== context.connectionGeneration || remainingMs <= 0) {
        break;
      }
      await context.timer.sleep(Math.min(backoff.delayForAttempt(attempt), remainingMs));
      attempt++;
    }

    return false;
  }

  /**
   * Check device presence, then the accessibility service's health. A healthy
   * service is left untouched — no rebind, no setup — the caller only
   * reconnects in the background without resetting the foreground cooldown
   * (issue #6260). An unhealthy service is rebound per #7470 (force-stop,
   * re-add, bounded health poll), falling back to a full `setup()` when the
   * rebind alone does not restore health (e.g. CtrlProxy is missing from
   * `enabled_accessibility_services` or not installed at all).
   */
  private async recoverAccessibilityService(
    generation: number,
    onEscalation: () => void,
  ): Promise<RecoveryOutcome> {
    const { context } = this;
    if (context.closed) {
      return "failed";
    }
    const present = await this.isDevicePresent();
    if (generation !== context.connectionGeneration) {
      return "failed";
    }
    if (!present) {
      this.deviceSeenAbsent = true;
      logger.info(
        `[AndroidCtrlProxyClient] Device ${context.deviceId} is offline or missing; skipping recovery`,
      );
      return "unavailable";
    }

    const manager = context.serviceManagerFactory(context.device);
    const healthy = await manager.isAccessibilityServiceHealthy();
    if (generation !== context.connectionGeneration) {
      return "failed";
    }
    if (healthy) {
      logger.info(
        `[AndroidCtrlProxyClient] Accessibility service already healthy; skipping rebind`,
      );
      return "healthy";
    }

    onEscalation();
    logger.info(`[AndroidCtrlProxyClient] Accessibility service unhealthy; attempting rebind`);
    const rebound = (await manager.rebindIfUnhealthy?.()) ?? false;
    if (generation !== context.connectionGeneration) {
      return "failed";
    }
    const rebindOutcome = await this.rebindRecoveryOutcome(manager, rebound);
    if (generation !== context.connectionGeneration) {
      return "failed";
    }
    if (rebindOutcome) {
      return rebindOutcome;
    }

    onEscalation();
    logger.info(`[AndroidCtrlProxyClient] Rebind did not restore health; running full setup`);
    return this.setupRecoveryService(manager, generation);
  }

  private async rebindRecoveryOutcome(
    manager: AndroidServiceRecoveryManager,
    rebound: boolean,
  ): Promise<"repaired" | "healthy" | null> {
    if (rebound) {
      return (await manager.isAccessibilityServiceHealthy()) ? "repaired" : null;
    }
    // A no-op rebind can mean the service was already binding. Let that bind
    // finish before escalating to setup, which would force-stop it again.
    const binding = await manager.waitForAccessibilityServiceBinding?.();
    return binding === "recovered" ? "repaired" : binding === "already-bound" ? "healthy" : null;
  }

  private async setupRecoveryService(
    manager: AndroidServiceRecoveryManager,
    generation: number,
  ): Promise<"repaired" | "failed"> {
    const { context } = this;
    const result = await manager.setup(true);
    if (generation !== context.connectionGeneration) {
      return "failed";
    }
    if (!result.success) {
      logger.warn(
        `[AndroidCtrlProxyClient] CtrlProxy setup failed during recovery: ${result.message}`,
      );
      return "failed";
    }
    const healthy = await manager.isAccessibilityServiceHealthy();
    if (generation !== context.connectionGeneration) {
      return "failed";
    }
    if (!healthy) {
      logger.warn(`[AndroidCtrlProxyClient] Accessibility service remained unhealthy after setup`);
      return "failed";
    }
    return "repaired";
  }

  /**
   * Whether adb still reports this device as present and online. Recovery must
   * not touch a stopped or disconnected device (issue #7532), mirroring the
   * `bootedDeviceLister` check `IOSCtrlProxyClient.ensureConnected` runs before
   * its own auto-setup.
   */
  private async isDevicePresent(): Promise<boolean> {
    const { adb, deviceId } = this.context;
    const getDeviceStates = adb.getDeviceStates?.bind(adb);
    if (!getDeviceStates) {
      // The executor cannot report raw device states; fail open rather than
      // block recovery on a capability the executor doesn't provide.
      return true;
    }
    try {
      const states = await getDeviceStates();
      const match = states.find((state) => state.deviceId === deviceId);
      // "unauthorized" is not a state recovery can act on either — adb cannot
      // run shell commands against it, so it is not meaningfully "present".
      return match !== undefined && match.state !== "offline" && match.state !== "unauthorized";
    } catch (error) {
      // Diagnostic failure only: do not block recovery on it.
      logger.warn(
        `[AndroidCtrlProxyClient] Failed to check device state during recovery: ${error}`,
      );
      return true;
    }
  }
}
