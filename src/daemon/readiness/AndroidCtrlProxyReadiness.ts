import { type TimingData, createPerformanceTracker } from "../../utils/PerformanceTracker";
import { AsyncLocalStorage } from "node:async_hooks";
import type { CtrlProxyManager } from "../../ctrlProxy/CtrlProxyManager";
import { ActionableError, BootedDevice } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { AndroidForwardReadinessConflictError } from "./AndroidForwardReadinessConflictError";
import type { DeviceClientProvider, DeviceReadyOptions } from "./DeviceReadiness";

type AndroidCtrlProxy = ReturnType<DeviceClientProvider["getAndroidCtrlProxyClient"]>;

interface AndroidCtrlProxyReadinessDependencies {
  errors: {
    DeviceOwnedByOtherDaemonError: abstract new (...args: never[]) => Error;
    CtrlProxyForwardOwnershipUnreadableError: abstract new (...args: never[]) => Error;
  };
  storeSetupTiming(deviceId: string, timing: TimingData, sessionId?: string): void;
  provider: Pick<DeviceClientProvider, "getAndroidCtrlProxyManager" | "getAndroidCtrlProxyClient">;
  checkedAndroidOwnership: AsyncLocalStorage<Set<string>>;
}

interface AndroidServiceSetupContext {
  deviceId: string;
  manager: CtrlProxyManager;
  accessibilityClient: AndroidCtrlProxy;
  perf: ReturnType<typeof createPerformanceTracker>;
  state: { didSetup: boolean; needsSetup: boolean };
  skipCtrlProxyDownload: boolean | undefined;
  options?: DeviceReadyOptions;
}

/** One Android service readiness step: its shared setup state and compatibility handling. */
interface AndroidServiceStep {
  setupState: { didSetup: boolean; needsSetup: boolean };
  skipCtrlProxyDownload: boolean | undefined;
  verifyCompatibilityWhenSkipping: () => Promise<void>;
  signal?: AbortSignal;
}

/** Android service readiness, including compatibility checks and forwarding ownership. */
export class AndroidCtrlProxyReadiness {
  constructor(private readonly dependencies: AndroidCtrlProxyReadinessDependencies) {}

  async ensureReady(
    deviceId: string,
    device: BootedDevice,
    options?: DeviceReadyOptions,
  ): Promise<void> {
    // Always track setup timing (one-time per session, valuable for debugging)
    const perf = createPerformanceTracker(true);
    perf.serial("ensureAccessibilityService");
    const state = { didSetup: false, needsSetup: false };

    try {
      await this.ensureService(device, deviceId, options, perf, state);
    } catch (error) {
      this.handleSetupFailure(error, deviceId, options);
    } finally {
      this.finishSetupTiming(deviceId, perf, state, options);
    }
  }

  skipCtrlProxyDownload(options?: DeviceReadyOptions): boolean | undefined {
    return (
      options?.skipCtrlProxyDownload ??
      options?.skipAccessibilityDownload ??
      options?.skipAccessibilitySetup
    );
  }

  private warnDeprecatedAccessibilityOptions(options?: DeviceReadyOptions): void {
    if (options?.skipAccessibilitySetup !== undefined) {
      if (options?.skipAccessibilityDownload !== undefined) {
        logger.warn(
          "[DeviceReadiness] skipAccessibilityDownload is deprecated; use skipCtrlProxyDownload instead.",
        );
      } else {
        logger.warn(
          "[DeviceReadiness] skipAccessibilitySetup is deprecated; use skipCtrlProxyDownload instead.",
        );
      }
    }
  }

  private async verifyConnectedAndroidService(
    deviceId: string,
    accessibilityClient: AndroidCtrlProxy,
    perf: ReturnType<typeof createPerformanceTracker>,
  ): Promise<boolean> {
    // WebSocket appears connected, but verify service is actually responsive
    // This catches cases where service crashed but socket wasn't properly closed
    logger.info(
      `[DeviceReadiness] WebSocket connected for ${deviceId}, verifying service is responsive`,
    );
    const isReady = await perf.track("verifyConnectedService", () =>
      accessibilityClient.verifyServiceReady(2, 200, 2000),
    );
    if (isReady) {
      logger.info(`[DeviceReadiness] Accessibility service verified responsive for ${deviceId}`);
      perf.end();
      return true;
    }
    // Service not responsive despite a connected socket: the socket itself
    // is suspect (issue #7554 — readyState stays OPEN across a half-open
    // connection to a wedged or unreachable peer). Terminate it so the
    // normal flow below reconnects with a fresh socket, rather than
    // falling through to a waitForConnection() that would just reuse the
    // same half-open one and report success immediately. Unlike close(),
    // terminateStaleConnection() does not disable auto-reconnect for the
    // rest of this client's lifetime — it drives the same was-open close
    // path a real network failure would.
    logger.warn(
      `[DeviceReadiness] WebSocket connected but service not responsive for ${deviceId}, terminating stale connection and checking status`,
    );
    accessibilityClient.terminateStaleConnection();
    return false;
  }

  private async verifyEnabledAndroidService(
    deviceId: string,
    manager: CtrlProxyManager,
    accessibilityClient: AndroidCtrlProxy,
    perf: ReturnType<typeof createPerformanceTracker>,
    step: AndroidServiceStep,
  ): Promise<boolean> {
    const { setupState, skipCtrlProxyDownload, verifyCompatibilityWhenSkipping, signal } = step;
    logger.info(
      `[DeviceReadiness] Accessibility service already enabled for ${deviceId}, verifying WebSocket connection`,
    );
    // Verify the service is actually working by checking WebSocket connection
    const connected = await perf.track("verifyConnection", () =>
      accessibilityClient.waitForConnection(3, 200),
    );
    if (connected) {
      if (skipCtrlProxyDownload) {
        await verifyCompatibilityWhenSkipping();
        return true;
      }
      logger.info(
        `[DeviceReadiness] Accessibility service enabled and connected for ${deviceId}, verifying version compatibility`,
      );
      await this.upgradeStaleInstall(deviceId, manager, setupState);
    } else {
      await this.throwAndroidForwardConflictIfPresent(
        deviceId,
        manager,
        accessibilityClient,
        signal,
      );
      // Service claims to be installed but WebSocket won't connect - cache is stale
      logger.warn(
        `[DeviceReadiness] Accessibility service cache stale for ${deviceId} - marked as installed/enabled but WebSocket failed. Resetting setup state and forcing reinstall.`,
      );
      manager.resetSetupState();
      setupState.needsSetup = true;
    }
    return false;
  }

  /**
   * A connected service says nothing about which build is running: compare the installed APK's
   * content (SHA-256, cached per manager) with the expected one, so a same-versionName build or
   * a local APK override reaches the device (#15007). A swapped APK restarts the service, so
   * setup follows to reconnect; a failed or skipped check keeps the running service.
   */
  private async upgradeStaleInstall(
    deviceId: string,
    manager: CtrlProxyManager,
    setupState: { didSetup: boolean; needsSetup: boolean },
  ): Promise<void> {
    try {
      const compatibility = await manager.ensureCompatibleVersion();
      if (
        compatibility.status === "upgraded" ||
        compatibility.status === "installed" ||
        compatibility.status === "reinstalled"
      ) {
        logger.info(
          `[DeviceReadiness] CtrlProxy APK on ${deviceId} was ${compatibility.status}; reconnecting`,
        );
        setupState.needsSetup = true;
      }
    } catch (error) {
      if (error instanceof this.dependencies.errors.DeviceOwnedByOtherDaemonError) {
        throw error;
      }
      // A failed content check must not take down a service that is already answering.
      logger.warn(
        `[DeviceReadiness] CtrlProxy APK check failed on ${deviceId}: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private async enableInstalledAndroidService(
    deviceId: string,
    manager: CtrlProxyManager,
    accessibilityClient: AndroidCtrlProxy,
    perf: ReturnType<typeof createPerformanceTracker>,
    step: AndroidServiceStep,
  ): Promise<boolean> {
    const { DeviceOwnedByOtherDaemonError } = this.dependencies.errors;
    const { setupState, skipCtrlProxyDownload, verifyCompatibilityWhenSkipping, signal } = step;
    logger.info(
      `[DeviceReadiness] Accessibility service installed but not enabled for ${deviceId}, enabling now`,
    );
    try {
      await perf.track("enableService", () => manager.enable());
      setupState.didSetup = true;
      // enable() just changed the endpoint's state; failures recorded
      // before this point must not cool down the connect that follows
      // (issue #7538).
      accessibilityClient.resetConnectionBudget();
      // Wait for WebSocket to be ready after enabling
      logger.info(
        `[DeviceReadiness] Waiting for accessibility WebSocket connection for ${deviceId}`,
      );
      const enableConnected = await perf.track("waitForConnection", () =>
        accessibilityClient.waitForConnection(),
      );
      if (!enableConnected) {
        await this.throwAndroidForwardConflictIfPresent(
          deviceId,
          manager,
          accessibilityClient,
          signal,
        );
        logger.warn(
          `[DeviceReadiness] WebSocket connection failed after enabling for ${deviceId}, will attempt full setup`,
        );
        manager.resetSetupState();
        setupState.needsSetup = true;
      } else {
        if (skipCtrlProxyDownload) {
          await verifyCompatibilityWhenSkipping();
          return true;
        }
        logger.info(
          `[DeviceReadiness] Accessibility service enabled for ${deviceId}, verifying version compatibility`,
        );
      }
    } catch (error) {
      if (
        error instanceof DeviceOwnedByOtherDaemonError ||
        accessibilityClient.isLastConnectionFailureForwardingLeaseConflict?.()
      ) {
        throw error;
      }
      const errorMsg = errorMessage(error);
      logger.warn(`[DeviceReadiness] Failed to enable accessibility service: ${errorMsg}`);
      if (skipCtrlProxyDownload) {
        return true;
      }
      setupState.needsSetup = true;
    }
    return false;
  }

  private async setupAndroidService(
    deviceId: string,
    manager: CtrlProxyManager,
    accessibilityClient: AndroidCtrlProxy,
    perf: ReturnType<typeof createPerformanceTracker>,
    { state, signal }: { state: { didSetup: boolean }; signal?: AbortSignal },
  ): Promise<void> {
    const { DeviceOwnedByOtherDaemonError, CtrlProxyForwardOwnershipUnreadableError } =
      this.dependencies.errors;
    const setup = await manager.setup(false, perf);
    if (!setup.success) {
      if (
        setup.cause instanceof DeviceOwnedByOtherDaemonError ||
        setup.cause instanceof CtrlProxyForwardOwnershipUnreadableError
      ) {
        throw setup.cause;
      }
      throw new ActionableError(setup.error ?? setup.message);
    }
    state.didSetup = true;
    // setup() just changed the endpoint's state (fresh install/enable);
    // failures recorded before this point must not cool down the connect
    // that follows (issue #7538).
    accessibilityClient.resetConnectionBudget();
    // Wait for WebSocket to be ready after setup (install + enable)
    logger.info(
      `[DeviceReadiness] Waiting for accessibility WebSocket connection after setup for ${deviceId}`,
    );
    const connected = await perf.track("waitForConnection", () =>
      accessibilityClient.waitForConnection(),
    );
    if (!connected) {
      await this.throwAndroidForwardConflictIfPresent(
        deviceId,
        manager,
        accessibilityClient,
        signal,
      );
    }
    if (connected) {
      // Verify service is actually ready to respond (not just WebSocket connected)
      logger.info(
        `[DeviceReadiness] Verifying accessibility service is responsive for ${deviceId}`,
      );
      const ready = await perf.track("verifyServiceReady", () =>
        accessibilityClient.verifyServiceReady(5, 500, 3000),
      );
      if (!ready) {
        logger.warn(
          `[DeviceReadiness] Accessibility service not responsive after setup for ${deviceId}, observe may fall back to UIAutomator`,
        );
      }
    }
  }

  private async throwAndroidForwardConflictIfPresent(
    deviceId: string,
    manager: CtrlProxyManager,
    client: AndroidCtrlProxy,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!client.isLastConnectionFailureForwardingLeaseConflict?.()) {
      return;
    }
    await manager.assertNotDrivenByOtherDaemon?.(signal);
    signal?.throwIfAborted();
    throw new AndroidForwardReadinessConflictError(
      client.getLastConnectionFailureMessage?.() ??
        `CtrlProxy forwarding lease conflict for Android device ${deviceId}`,
    );
  }
  private async prepareService(context: AndroidServiceSetupContext): Promise<void> {
    const { deviceId, manager, accessibilityClient, perf, state, skipCtrlProxyDownload, options } =
      context;
    const verifyCompatibilityWhenSkipping = async (): Promise<void> => {
      const isCompatible = await manager.isVersionCompatible();
      if (isCompatible) {
        logger.info(`[DeviceReadiness] Accessibility service version compatible for ${deviceId}`);
        return;
      }
      const errorMsg =
        "Accessibility service version mismatch detected. Run without skipCtrlProxyDownload to install a compatible version.";
      logger.warn(`[DeviceReadiness] ${errorMsg} Device: ${deviceId}`);
      throw new ActionableError(errorMsg);
    };

    const [isInstalled, isEnabled] = await perf.track("checkStatus", () =>
      Promise.all([manager.isInstalled(), manager.isEnabled()]),
    );
    // Enabling or installing CtrlProxy mutates the device; a cancelled call stops here (#10905).
    options?.signal?.throwIfAborted();

    state.needsSetup = false;

    if (
      await this.useInstalledService(
        context,
        isInstalled,
        isEnabled,
        verifyCompatibilityWhenSkipping,
      )
    ) {
      return;
    }

    if (skipCtrlProxyDownload && !state.needsSetup) {
      logger.info(
        `[DeviceReadiness] Skipping accessibility service download/install for ${deviceId}`,
      );
      return;
    }

    if (state.needsSetup || !isInstalled) {
      options?.signal?.throwIfAborted();
      await this.setupAndroidService(deviceId, manager, accessibilityClient, perf, {
        state,
        signal: options?.signal,
      });
    }
  }
  private async ensureService(
    device: BootedDevice,
    deviceId: string,
    options: DeviceReadyOptions | undefined,
    perf: ReturnType<typeof createPerformanceTracker>,
    state: { didSetup: boolean; needsSetup: boolean },
  ): Promise<void> {
    const skipCtrlProxyDownload = this.skipCtrlProxyDownload(options);
    this.warnDeprecatedAccessibilityOptions(options);

    const manager = this.dependencies.provider.getAndroidCtrlProxyManager(device);
    const accessibilityClient = this.dependencies.provider.getAndroidCtrlProxyClient(device);
    if (accessibilityClient.isConnected()) {
      if (await this.verifyConnectedAndroidService(deviceId, accessibilityClient, perf)) {
        options?.signal?.throwIfAborted();
        // This process already drives the responsive socket; no readiness write is needed.
        this.dependencies.checkedAndroidOwnership.getStore()?.add(deviceId);
        return;
      }
    }

    await manager.assertNotDrivenByOtherDaemon?.(options?.signal);
    options?.signal?.throwIfAborted();
    this.dependencies.checkedAndroidOwnership.getStore()?.add(deviceId);

    await this.prepareService({
      deviceId,
      manager,
      accessibilityClient,
      perf,
      state,
      skipCtrlProxyDownload,
      options,
    });
  }
  private finishSetupTiming(
    deviceId: string,
    perf: ReturnType<typeof createPerformanceTracker>,
    state: { didSetup: boolean },
    options?: DeviceReadyOptions,
  ): void {
    perf.end();
    // Store timing if we actually did setup work
    if (state.didSetup) {
      const timings = perf.getTimings();
      if (timings) {
        this.dependencies.storeSetupTiming(deviceId, timings, options?.sessionId);
      }
    }
  }
  private async useInstalledService(
    context: AndroidServiceSetupContext,
    isInstalled: boolean,
    isEnabled: boolean,
    verifyCompatibilityWhenSkipping: () => Promise<void>,
  ): Promise<boolean> {
    const { deviceId, manager, accessibilityClient, perf, state, skipCtrlProxyDownload, options } =
      context;
    if (isInstalled && isEnabled) {
      if (
        await this.verifyEnabledAndroidService(deviceId, manager, accessibilityClient, perf, {
          setupState: state,
          skipCtrlProxyDownload,
          verifyCompatibilityWhenSkipping,
          signal: options?.signal,
        })
      ) {
        return true;
      }
    }

    if (!isInstalled && skipCtrlProxyDownload) {
      logger.info(
        `[DeviceReadiness] Accessibility service not installed for ${deviceId}, skipping download/install`,
      );
      return true;
    }

    if (isInstalled && !isEnabled && !state.needsSetup) {
      if (
        await this.enableInstalledAndroidService(deviceId, manager, accessibilityClient, perf, {
          setupState: state,
          skipCtrlProxyDownload,
          verifyCompatibilityWhenSkipping,
          signal: options?.signal,
        })
      ) {
        return true;
      }
    }

    return false;
  }

  private handleSetupFailure(error: unknown, deviceId: string, options?: DeviceReadyOptions): void {
    const { DeviceOwnedByOtherDaemonError, CtrlProxyForwardOwnershipUnreadableError } =
      this.dependencies.errors;
    options?.signal?.throwIfAborted();
    const errorMsg = errorMessage(error);
    if (
      options?.intent === "read" &&
      (error instanceof DeviceOwnedByOtherDaemonError ||
        error instanceof CtrlProxyForwardOwnershipUnreadableError ||
        error instanceof AndroidForwardReadinessConflictError)
    ) {
      logger.warn(
        `[DeviceReadiness] Skipping CtrlProxy readiness for read on ${deviceId}: ${errorMsg}`,
      );
      return;
    }
    logger.error(`[DeviceReadiness] Failed to setup accessibility service: ${errorMsg}`);
    // Rethrow ActionableErrors to preserve their specific error messages, and cancellation so
    // readiness does not go on to pin and configure the device (#10905).
    if (error instanceof ActionableError || options?.signal?.aborted) {
      throw error;
    }
  }
}
