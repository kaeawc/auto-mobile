import { NoOpPerformanceTracker, type PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { BootedDevice } from "../../../models";
import type { IosHierarchyUnavailableReason } from "../../../models/ViewHierarchyResult";
import type { RetryExecutor } from "../../../utils/retry/RetryExecutor";
import {
  IOSCtrlProxyManager,
  type CtrlProxyIosManager,
  type CtrlProxyIosSetupResult,
} from "../../../ctrlProxy/IOSCtrlProxyManager";
import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import type { CtrlProxySyncedHierarchy } from "./types";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
type ConnectionFailure = { reason: IosHierarchyUnavailableReason; detail?: string };
interface ConnectionHost {
  readonly deviceId: string;
  readonly closed: boolean;
  readonly port: number;
  readonly retryExecutor: RetryExecutor;
  readonly pendingConnectJoiners: number;
  lastConnectFailure: ConnectionFailure | undefined;
  getManager(): CtrlProxyIosManager;
  hasOpenSocket(): boolean;
  isRecovering(): boolean;
  connectTransport(perf: PerformanceTracker): Promise<boolean>;
  syncPortFromManager(manager: CtrlProxyIosManager): void;
  resetConnectionBudget(): void;
  bootedDeviceLister(): Promise<BootedDevice[]>;
  acquirePendingConnectInterest(): { release(): void };
  abortPendingConnect(): void;
  connectWebSocket(perf?: PerformanceTracker, interest?: { release(): void }): Promise<boolean>;
  ensureConnected(): Promise<boolean>;
  requestHierarchySync(
    perf: PerformanceTracker | undefined,
    disableAllFiltering: boolean,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<CtrlProxySyncedHierarchy | null>;
}

/** Auto-setup and direct connection probes over the client's shared transport. */
export class CtrlProxyConnection {
  constructor(private readonly host: ConnectionHost) {}

  private isAttemptingAutoSetup: boolean = false;

  // ===========================================================================
  // Auto-setup on connection failure
  // ===========================================================================

  /**
   * Probe the WebSocket directly without entering the automatic runner setup path.
   */
  public async connectWithoutSetup(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const interest = this.host.acquirePendingConnectInterest();

    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const settle = (complete: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        interest.release();
        signal?.removeEventListener("abort", abortConnection);
        complete();
      };
      const abortConnection = (): void => {
        settle(() => {
          if (this.host.pendingConnectJoiners === 0) {
            this.host.abortPendingConnect();
          }
          reject(signal!.reason);
        });
      };

      signal?.addEventListener("abort", abortConnection, { once: true });
      void this.host.connectWebSocket(undefined, interest).then(
        (connected) => settle(() => resolve(connected)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }

  /**
   * Override ensureConnected to automatically set up CtrlProxy when
   * the WebSocket connection fails. This covers all tool calls (observe, tap, etc.).
   */
  async ensureConnected(perf: PerformanceTracker = new NoOpPerformanceTracker()): Promise<boolean> {
    this.host.lastConnectFailure = undefined;
    if (this.host.closed) {
      this.host.lastConnectFailure = { reason: "connection_lost", detail: "client closed" };
      return false;
    }
    // Direct session tools connect here without passing through the manager.
    await IOSCtrlProxyManager.awaitStartupOrphanRunnerReap();

    if (this.host.closed) {
      this.host.lastConnectFailure = { reason: "connection_lost", detail: "client closed" };
      return false;
    }

    const connected = await this.host.connectTransport(perf);
    if (connected) {
      return true;
    }

    if (this.host.isRecovering()) {
      return false;
    }

    // Prevent re-entry during auto-setup
    if (this.isAttemptingAutoSetup) {
      this.host.lastConnectFailure = {
        reason: "auto_setup_failed",
        detail: "auto-setup already running",
      };
      return false;
    }

    this.isAttemptingAutoSetup = true;
    try {
      const manager = this.host.getManager();

      // If the service is already running (health endpoint responds), the WebSocket
      // failure is transient (e.g. service just restarted by hot-reload). Skip the
      // full setup/download cycle — just reset attempts and retry the connection.
      const alreadyRunning = await manager.isRunning();
      // Diagnostic: the decisive state for why a reused session's observe fails.
      // alreadyRunning=false ⇒ the runner is gone since a prior session ⇒ a slow
      // cold setup happens inside the caller's bounded waitFor. alreadyRunning=true
      // ⇒ the runner lives and only the WebSocket needs re-opening (fast). (#2825)
      logger.info(
        `[IOSCtrlProxyClient] auto-setup decision: alreadyRunning(health)=${alreadyRunning}, ` +
          `port=${this.host.port}, hadOpenWs=${this.host.hasOpenSocket()}, device=${this.host.deviceId}`,
      );
      if (alreadyRunning) {
        logger.info(
          `[IOSCtrlProxyClient] Service is running but WebSocket failed — transient issue, retrying connection`,
        );
        this.host.syncPortFromManager(manager);
        this.host.resetConnectionBudget();
        return await this.reconnectAfterSetup(perf);
      }

      // Check if the target simulator is still booted before attempting auto-setup.
      // Without this check, xcodebuild test-without-building will re-boot the simulator
      // as a side effect, causing phantom simulators.
      try {
        const bootedDevices = await this.host.bootedDeviceLister();
        const stillBooted = bootedDevices.some((d) => d.deviceId === this.host.deviceId);
        if (!stillBooted) {
          logger.info(
            `[IOSCtrlProxyClient] Target simulator ${this.host.deviceId} is no longer booted, skipping auto-setup`,
          );
          this.stopRunnerForSimulatorShutdown(manager);
          this.host.lastConnectFailure = { reason: "simulator_not_booted" };
          return false;
        }
      } catch (error) {
        logger.warn(`[IOSCtrlProxyClient] Failed to check simulator boot state: ${error}`);
        // Proceed with auto-setup on failure to check — better to attempt than to silently skip
      }

      logger.info(
        `[IOSCtrlProxyClient] WebSocket connection failed, attempting auto-setup of CtrlProxy`,
      );
      const result = await manager.setup(true, perf);

      if (!result.success) {
        logger.warn(`[IOSCtrlProxyClient] Auto-setup failed: ${result.message}`);
        this.host.lastConnectFailure = this.autoSetupFailure(result, manager);
        return false;
      }

      this.host.syncPortFromManager(manager);

      logger.info(`[IOSCtrlProxyClient] Auto-setup succeeded, retrying WebSocket connection`);
      // Reset the connection budget to allow a fresh connection attempt
      this.host.resetConnectionBudget();
      return await this.reconnectAfterSetup(perf);
    } catch (error) {
      // A unit test reached the real WebSocket factory; surface it, never mask it as setup failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      logger.warn(`[IOSCtrlProxyClient] Auto-setup error: ${error}`);
      this.host.lastConnectFailure = { reason: "auto_setup_failed", detail: String(error) };
      return false;
    } finally {
      this.isAttemptingAutoSetup = false;
    }
  }

  private autoSetupFailure(
    result: CtrlProxyIosSetupResult,
    manager: CtrlProxyIosManager,
  ): { reason: IosHierarchyUnavailableReason; detail: string } {
    return {
      reason:
        result.recoveryInterrupted && manager.isRecoveryInFlight?.()
          ? "service_recovering"
          : "auto_setup_failed",
      detail: result.recoveryInterrupted ? (result.error ?? result.message) : result.message,
    };
  }

  private stopRunnerForSimulatorShutdown(manager: CtrlProxyIosManager): void {
    void manager
      .markSimulatorShutDownIfNotBooted?.("target simulator is no longer booted")
      .catch((error) => {
        logger.warn(
          `[IOSCtrlProxyClient] Failed to stop shut-down simulator runner: ${errorMessage(error)}`,
        );
      });
  }

  private async reconnectAfterSetup(perf: PerformanceTracker): Promise<boolean> {
    const reconnected = await this.host.connectTransport(perf);
    if (!reconnected) {
      this.host.lastConnectFailure = {
        reason: "connection_lost",
        detail: "WebSocket reconnect failed after setup",
      };
    }
    return reconnected;
  }

  // ===========================================================================
  // Service Verification
  // ===========================================================================

  public async verifyServiceReady(
    maxAttempts: number = 3,
    delayMs: number = 1000,
    timeoutMs: number = 5000,
  ): Promise<boolean> {
    // Sits on the shared RetryExecutor (issue #5460), matching how
    // DeviceServiceClient.waitForConnection and AndroidCtrlProxyClient.verifyServiceReady
    // already retry service-readiness. The two-phase probe is preserved: a failed
    // connection throws to consume an attempt without a hierarchy request, and a
    // connected-but-empty/failed hierarchy throws to retry. Any throw becomes a
    // retryable attempt with a fixed `delayMs` wait between attempts — so the loop
    // waits maxAttempts - 1 times, not once per attempt as the previous hand-rolled
    // loop did (it slept even after the final failed attempt; that trailing wait was
    // pure wasted latency on the error path).
    const result = await this.host.retryExecutor.execute(
      async () => {
        if (!(await this.host.ensureConnected())) {
          throw new Error("CtrlProxy WebSocket not connected");
        }

        const hierarchyResult = await this.host.requestHierarchySync(
          undefined,
          false,
          undefined,
          timeoutMs,
        );
        if (hierarchyResult?.hierarchy) {
          return true;
        }

        throw new Error("CtrlProxy returned no hierarchy");
      },
      {
        maxAttempts,
        delays: delayMs,
      },
    );

    return result.value ?? false;
  }
}
