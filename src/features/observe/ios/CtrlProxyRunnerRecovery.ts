import type { Timer } from "../../../utils/SystemTimer";
import type { BootedDevice } from "../../../models";
import type { CtrlSocket } from "../shared/types";
import type { TimedOutRequest } from "../../../utils/RequestManager";
import {
  IOSCtrlProxyManager,
  type CtrlProxyIosManager,
} from "../../../ctrlProxy/IOSCtrlProxyManager";
import type { ForcedRestartBudget } from "../../../ctrlProxy/ForcedRestartBudget";
import { ActionableError } from "../../../models/ActionableError";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
type RestartTrigger = "connection-failures" | "observed-failure";
type RecoveryResult = "recovered" | "not_recovering" | "failed" | "timed_out";
interface RunnerRecoveryHost {
  readonly timer: Timer;
  readonly deviceId: string;
  readonly ws: CtrlSocket | null;
  readonly port: number;
  readonly closed: boolean;
  readonly transientObserver: boolean;
  readonly observerHierarchyRequestIds: Set<string>;
  consecutiveConnectionFailures: number;
  recoveryPromise: Promise<boolean> | null;
  getManager(): CtrlProxyIosManager;
  isConnected(): boolean;
  syncPortFromManager(manager: CtrlProxyIosManager): void;
  resetConnectionBudget(): void;
  connectBackgroundWebSocket(): Promise<boolean>;
  bootedDeviceLister(): Promise<BootedDevice[]>;
  startScreenshotBackoff(): void;
  startSdkEventPolling(): void;
  awaitRecovery(budgetMs: number, signal?: AbortSignal): Promise<RecoveryResult>;
}

/** Budgeted runner restart admission and replacement-socket stability. */
export class CtrlProxyRunnerRecovery {
  constructor(private readonly host: RunnerRecoveryHost) {}

  private isRequestingServiceRestart: boolean = false;

  /**
   * Bumped for every established (non-transient) connection. A restart trigger
   * records it so a trigger queued against an older socket is dropped once a
   * newer runner incarnation is connected (#11247).
   */
  private connectionIncarnation = 0;

  private lastDeniedRestartState: string | undefined;

  /**
   * Shorter command budgets (e.g. a 1 s settle-gate read) can expire on a
   * healthy runner, so only a timeout at least this long is stall evidence.
   */
  private static readonly STALL_EVIDENCE_MIN_TIMEOUT_MS = 5000;

  /** How long an unanswered ping must stay unanswered after a silent command timeout. */
  private static readonly STALL_CONFIRMATION_MS = 2000;

  /**
   * Response types of control commands whose silent timeout is stall evidence.
   * Diagnostic and read-only requests (screenshot, clipboard, capability and
   * VoiceOver state reads, storage) are deliberately absent: per #10724 they
   * never start recovery. The observe hierarchy read is admitted separately.
   */
  private static readonly STALL_EVIDENCE_CONTROL_RESPONSE_TYPES: ReadonlySet<string> = new Set([
    "tap_coordinates",
    "swipe",
    "drag",
    "pinch",
    "multi_finger_swipe_result",
    "path_gesture_result",
    "action",
    "press_key",
    "press_button",
    "press_home",
    "press_back",
    "recent_apps",
    "keyboard",
    "ime_action",
    "select_all",
    "set_text",
    "append_text",
    "clear_text",
    "rotate",
    "shake",
    "magic_tap_result",
  ]);

  /** A briefly open socket is not evidence that the runner recovered. */
  private static readonly RESTART_REARM_STABILITY_MS = 2000;

  private restartRearmTimeout: NodeJS.Timeout | null = null;

  private pendingRestartToken: number | undefined;

  private resolvePendingRestart: ((stable: boolean) => void) | undefined;

  /** Only a socket opened after forceRestart teardown may satisfy this attempt. */
  private restartAcceptsReplacement = false;

  private restartReplacementSocket: CtrlSocket | null = null;

  private restartSocketBeforeTeardown: CtrlSocket | null = null;

  private connectedSocketPort: number | null = null;

  onConnectionEstablished(): void {
    if (this.host.transientObserver) {
      this.connectedSocketPort = this.host.port;
      return;
    }
    // Reset failure counter on successful connection
    this.host.consecutiveConnectionFailures = 0;
    this.connectionIncarnation++;
    this.connectedSocketPort = this.host.port;
    if (this.pendingRestartToken !== undefined && this.restartAcceptsReplacement) {
      this.restartReplacementSocket = this.host.ws;
    }
    // A short stability window proves the new socket remains usable. The
    // injected timer lets a close cancel rearming without a wall-clock race.
    if (this.restartRearmTimeout) {
      this.host.timer.clearTimeout(this.restartRearmTimeout);
    }
    this.restartRearmTimeout = this.host.timer.setTimeout(() => {
      this.restartRearmTimeout = null;
      this.completeStableRestartConnection();
    }, CtrlProxyRunnerRecovery.RESTART_REARM_STABILITY_MS);
    logger.info(`[IOSCtrlProxyClient] Connection established, reset failure counter`);

    // Start polling for SDK events from the CtrlProxy HTTP endpoint
    this.host.startSdkEventPolling();

    // Resume the screenshot keepalive after a (re)connect. onConnectionClosed()
    // cancels it; without restarting here, a transient drop on a STATIC screen
    // leaves the live view frozen forever. Subscriber-gated and idempotent.
    this.host.startScreenshotBackoff();
  }

  /**
   * Trigger CtrlProxy restart through the manager.
   * Connection failures or a stalled native command observed by normal
   * hierarchy reads can require recovery even when the socket remains healthy.
   */
  triggerServiceRestart(trigger: RestartTrigger = "observed-failure"): void {
    if (
      this.host.closed ||
      IOSCtrlProxyManager.isDeviceRetired(this.host.deviceId) ||
      this.isRequestingServiceRestart
    ) {
      return;
    }

    const manager = this.host.getManager();
    const budget = manager.getForcedRestartBudget();
    if (budget.snapshot().state !== "idle") {
      this.logDeniedRestart(budget);
      return;
    }
    this.isRequestingServiceRestart = true;
    const triggeredAt = { trigger, incarnation: this.connectionIncarnation };
    const recovery = this.restartServiceIfBooted(manager, budget, triggeredAt).finally(() => {
      // An older completion must not erase a newer recovery's promise or guard.
      if (this.host.recoveryPromise === recovery) {
        this.isRequestingServiceRestart = false;
        this.host.recoveryPromise = null;
      }
    });
    this.host.recoveryPromise = recovery;
  }

  failPendingRestart(reason: string): void {
    const token = this.pendingRestartToken;
    if (token !== undefined) {
      this.pendingRestartToken = undefined;
      this.host.getManager().getForcedRestartBudget().recordFailure(reason, token);
    }
    this.restartAcceptsReplacement = false;
    this.restartReplacementSocket = null;
    this.restartSocketBeforeTeardown = null;
    this.finishPendingRestart(false);
  }

  private completeStableRestartConnection(): void {
    if (!this.host.isConnected()) {
      this.failPendingRestart("WebSocket closed before stable reconnect");
      return;
    }
    if (this.pendingRestartToken !== undefined && this.host.ws !== this.restartReplacementSocket) {
      return;
    }
    const budget = this.host.getManager().getForcedRestartBudget();
    if (budget.snapshot().state === "suspended") {
      this.failPendingRestart("Restart budget suspended before stable reconnect");
      return;
    }
    const token = this.pendingRestartToken;
    if (budget.recordSuccess(token)) {
      this.pendingRestartToken = undefined;
      this.restartAcceptsReplacement = false;
      this.restartReplacementSocket = null;
      this.restartSocketBeforeTeardown = null;
      this.lastDeniedRestartState = undefined;
      if (token !== undefined) {
        this.finishPendingRestart(true);
      }
    } else if (token !== undefined) {
      this.failPendingRestart("WebSocket reconnect was superseded before stability");
    }
  }

  private acceptEarlyRestartReplacement(): void {
    if (
      !this.host.isConnected() ||
      this.host.ws === this.restartSocketBeforeTeardown ||
      this.connectedSocketPort !== this.host.port
    ) {
      return;
    }
    this.restartReplacementSocket = this.host.ws;
    // The original stability timer may already have fired while forceRestart
    // was still polling health. Credit that completed window now.
    if (!this.restartRearmTimeout) {
      this.completeStableRestartConnection();
    }
  }

  private hasAcceptedRestartReplacement(): boolean {
    return this.pendingRestartToken === undefined || this.host.ws === this.restartReplacementSocket;
  }

  private finishPendingRestart(stable: boolean): void {
    const resolve = this.resolvePendingRestart;
    this.resolvePendingRestart = undefined;
    resolve?.(stable);
  }

  silentTimeoutConfirmationMs(request: TimedOutRequest): number | undefined {
    if (
      this.host.transientObserver ||
      request.timeoutMs < CtrlProxyRunnerRecovery.STALL_EVIDENCE_MIN_TIMEOUT_MS ||
      !this.isStallEvidenceRequest(request)
    ) {
      return undefined;
    }
    return CtrlProxyRunnerRecovery.STALL_CONFIRMATION_MS;
  }

  /**
   * Control commands and the observe hierarchy read only. An observer-mode
   * hierarchy read is a diagnostic read (doctor, observation stream) on
   * whichever connection it uses, and must not start recovery (#10724).
   */
  private isStallEvidenceRequest(request: TimedOutRequest): boolean {
    if (request.type === "hierarchy") {
      return !this.host.observerHierarchyRequestIds.has(request.id);
    }
    return CtrlProxyRunnerRecovery.STALL_EVIDENCE_CONTROL_RESPONSE_TYPES.has(request.type);
  }

  async awaitRecovery(
    budgetMs: number,
    signal?: AbortSignal,
  ): Promise<"recovered" | "not_recovering" | "failed" | "timed_out"> {
    const budget = this.host.getManager().getForcedRestartBudget();
    const throwIfExhausted = (): void => {
      const snapshot = budget.snapshot();
      if (snapshot.state === "exhausted") {
        throw new ActionableError(
          `Automatic iOS CtrlProxy recovery exhausted for ${this.host.deviceId} ` +
            `after ${snapshot.attempts} attempts: ${snapshot.lastFailureReason ?? "runner remained unavailable"}. ` +
            "Restart the simulator to rearm recovery.",
        );
      }
    };
    throwIfExhausted();
    const remainingMs = budget.timeRemainingMs();
    const result = await this.host.awaitRecovery(
      remainingMs === undefined ? budgetMs : Math.min(budgetMs, remainingMs),
      signal,
    );
    throwIfExhausted();
    return result;
  }

  /** Logs a denied restart once per non-idle budget state. */
  private logDeniedRestart(budget: ForcedRestartBudget): void {
    const snapshot = budget.snapshot();
    if (snapshot.state === "idle") {
      return;
    }
    if (snapshot.state !== this.lastDeniedRestartState) {
      logger.warn(
        `[IOSCtrlProxyClient] Automatic CtrlProxy restart ${snapshot.state} for ${this.host.deviceId}` +
          (snapshot.lastFailureReason ? `: ${snapshot.lastFailureReason}` : ""),
      );
      this.lastDeniedRestartState = snapshot.state;
    }
  }

  /** Rechecks boot and retirement before admission; only a failure for this attempt token consumes budget. */
  async restartServiceIfBooted(
    manager: CtrlProxyIosManager,
    budget: ForcedRestartBudget,
    triggeredAt: { trigger: RestartTrigger; incarnation: number },
  ): Promise<boolean> {
    if (!(await this.isTargetStillBooted())) {
      return false;
    }
    if (this.host.closed || IOSCtrlProxyManager.isDeviceRetired(this.host.deviceId)) {
      return false;
    }
    const superseded = this.restartTriggerSupersededBy(triggeredAt);
    if (superseded !== undefined) {
      logger.info(`[IOSCtrlProxyClient] Dropping stale CtrlProxy restart trigger: ${superseded}`);
      return this.host.isConnected();
    }
    const token = budget.tryBeginAttempt();
    if (token === undefined) {
      this.logDeniedRestart(budget);
      return false;
    }
    this.pendingRestartToken = token;
    this.restartAcceptsReplacement = false;
    this.restartReplacementSocket = null;
    this.restartSocketBeforeTeardown = this.host.ws;
    const stableConnection = new Promise<boolean>((resolve) => {
      this.resolvePendingRestart = resolve;
    });
    this.lastDeniedRestartState = undefined;
    logger.info(
      `[IOSCtrlProxyClient] Triggering CtrlProxy restart (consecutive connection failures: ${this.host.consecutiveConnectionFailures})`,
    );
    try {
      const withinRecoveryBudget = <T>(operation: Promise<T>, phase: string): Promise<T> =>
        raceWithDeadline(operation, {
          timer: this.host.timer,
          timeoutMs: budget.timeRemainingMs(),
          label: `iOS CtrlProxy ${phase} for ${this.host.deviceId}`,
        });
      // Transport failures and command stalls can coexist with a healthy /health response.
      await withinRecoveryBudget(manager.forceRestart({ joinInFlightStart: true }), "restart");
      this.restartAcceptsReplacement = true;
      this.host.syncPortFromManager(manager);
      this.acceptEarlyRestartReplacement();
      this.host.resetConnectionBudget();
      logger.info(`[IOSCtrlProxyClient] CtrlProxy restart completed; reconnecting WebSocket`);
      const connected = await withinRecoveryBudget(
        this.host.connectBackgroundWebSocket(),
        "reconnect",
      );
      if (!connected || !this.host.isConnected()) {
        this.failPendingRestart("WebSocket reconnect failed after CtrlProxy restart");
        logger.warn(`[IOSCtrlProxyClient] WebSocket reconnect failed after CtrlProxy restart`);
        return false;
      }
      if (!this.hasAcceptedRestartReplacement()) {
        this.failPendingRestart("No replacement WebSocket opened after CtrlProxy restart");
        return false;
      }
      if (this.pendingRestartToken !== undefined && !this.restartRearmTimeout) {
        this.failPendingRestart("No stable WebSocket reconnect observed");
      }
      return await withinRecoveryBudget(stableConnection, "stable reconnect");
    } catch (error) {
      this.failPendingRestart(errorMessage(error));
      logger.warn(`[IOSCtrlProxyClient] CtrlProxy restart failed: ${errorMessage(error)}`);
      return false;
    }
  }

  /** Fails closed: an unknown boot state never starts a restart that could re-boot the simulator. */
  private async isTargetStillBooted(): Promise<boolean> {
    try {
      const booted = await this.host.bootedDeviceLister();
      if (!booted.some((device) => device.deviceId === this.host.deviceId)) {
        logger.info(
          `[IOSCtrlProxyClient] Target simulator ${this.host.deviceId} is no longer booted, skipping restart`,
        );
        void this.host
          .getManager()
          .markSimulatorShutDownIfNotBooted?.("target simulator is no longer booted")
          .catch((error) => {
            logger.warn(
              `[IOSCtrlProxyClient] Failed to stop shut-down simulator runner: ${errorMessage(error)}`,
            );
          });
        return false;
      }
      return true;
    } catch (error) {
      logger.warn(
        `[IOSCtrlProxyClient] Failed to check simulator boot state: ${errorMessage(error)}`,
      );
      return false;
    }
  }

  /**
   * The boot check above is asynchronous, so a trigger can outlive the failure
   * that raised it. A connection established since then is a newer runner
   * incarnation; restarting it would only kill a healthy runner (#11247).
   */
  private restartTriggerSupersededBy(triggeredAt: {
    trigger: RestartTrigger;
    incarnation: number;
  }): string | undefined {
    if (this.connectionIncarnation !== triggeredAt.incarnation && this.host.isConnected()) {
      return "a newer runner connection is healthy";
    }
    if (
      triggeredAt.trigger === "connection-failures" &&
      this.host.consecutiveConnectionFailures === 0
    ) {
      return "no consecutive connection failures remain";
    }
    return undefined;
  }

  close(): void {
    this.cancelStabilityTimer();
    this.failPendingRestart("Client closed before stable reconnect");
  }
  connectionClosed(): void {
    this.cancelStabilityTimer();
    if (this.restartReplacementSocket !== null || this.pendingRestartToken === undefined) {
      this.failPendingRestart("WebSocket closed before stable reconnect");
    }
  }
  private cancelStabilityTimer(): void {
    if (this.restartRearmTimeout) {
      this.host.timer.clearTimeout(this.restartRearmTimeout);
      this.restartRearmTimeout = null;
    }
  }
  diagnostics() {
    return {
      pendingRestartToken: this.pendingRestartToken,
      restartRearmTimeout: this.restartRearmTimeout,
      restartReplacementSocket: this.restartReplacementSocket,
      connectionIncarnation: this.connectionIncarnation,
      isRequestingServiceRestart: this.isRequestingServiceRestart,
    };
  }
  /** Models an older attempt being replaced while its boot probe is still pending. */
  resetInFlightForTesting(): void {
    this.isRequestingServiceRestart = false;
    this.host.recoveryPromise = null;
  }
}
