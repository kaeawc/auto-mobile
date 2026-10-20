import { CtrlProxyRunnerExitedDuringStartupError } from "./CtrlProxyRunnerExitedDuringStartupError";
import { CtrlProxyLaunchTimeoutError } from "./CtrlProxyLaunchTimeoutError";
import type { IosCtrlProxyRuntime } from "./IosCtrlProxyRuntime";
import { CtrlProxyStartupRecoveryInterruptedError } from "./CtrlProxyStartupRecoveryInterruptedError";
import { errorMessage } from "../../utils/describeUnknownError";
import { trackAmbient } from "../../utils/PerfContext";
import { logger } from "../../utils/logger";
import { NoOpPerformanceTracker, type PerformanceTracker } from "../../utils/PerformanceTracker";
import { IosCtrlProxyBuilder, type CtrlProxyIosBuildResult } from "../IosCtrlProxyBuilder";
import { resolvePinnedVersion } from "../../constants/release";
import {
  CtrlProxyIosSetupResult,
  CtrlProxyStartOptions,
  CtrlProxyIosCapabilities,
  IOS_CTRL_PROXY_STATUS_CACHE_TTL,
  IOS_CTRL_PROXY_BUNDLE_ID,
} from "./IosCtrlProxyContracts";

interface IosCtrlProxySetupHost {
  isAvailable(): Promise<boolean>;
  isRunning(): Promise<boolean>;
  useRemoteRunner(): boolean;
  start(options?: CtrlProxyStartOptions): Promise<void>;
  isSimulator(): boolean;
  checkHealthEndpoint(): Promise<boolean>;
  isInstalled(): Promise<boolean>;
}

/** Checks installation and prepares the runner bundle before starting the service. */
export class IosCtrlProxySetup {
  constructor(
    private readonly state: Pick<
      IosCtrlProxyRuntime,
      | "steps"
      | "attemptedSetup"
      | "builder"
      | "cachedInstalled"
      | "timer"
      | "remoteRunner"
      | "device"
      | "processExecutor"
      | "cachedRunning"
    >,
    private readonly host: IosCtrlProxySetupHost,
  ) {}

  /**
   * Complete setup process for CtrlProxy
   * Includes automatic build detection and prefetch integration
   */
  async setup(
    force: boolean = false,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
    minimumHealthPollDurationMs?: number,
  ): Promise<CtrlProxyIosSetupResult> {
    perf.serial("xcTestServiceSetup");

    // Fail closed before any reuse/short-circuit (already-running, already-attempted)
    // can serve an unverifiable pinned runner (#2746).
    if (IosCtrlProxyBuilder.isPinnedVersionUnverifiable()) {
      perf.end();
      return {
        success: false,
        message:
          `AUTOMOBILE_VERSION=${resolvePinnedVersion()} is not in the AutoMobile release ` +
          `checksum registry, so the CtrlProxy bundle cannot be integrity-verified. ` +
          `Pin a released version, or vendor a trusted bundle via AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH.`,
        perfTiming: perf.getTimings(),
      };
    }

    await this.state.steps.uninstallLegacyAppIfPresent();

    if (this.state.attemptedSetup && !force) {
      const isAvail = await this.host.isAvailable();
      return this.previousSetupResult(isAvail, perf);
    }

    try {
      this.state.attemptedSetup = true;

      // Check if already running
      const isRunning = await perf.track("checkRunning", () => this.host.isRunning());
      if (this.canReuseRunningSetup(force, isRunning)) {
        perf.end();
        return {
          success: true,
          message: "CtrlProxy was already running",
          perfTiming: perf.getTimings(),
        };
      }

      // Check if build is needed
      const needsBuild = this.host.useRemoteRunner()
        ? false
        : await perf.track("checkBuild", () => this.needsSetupBundleRebuild());

      let buildResult: CtrlProxyIosBuildResult | null = null;
      if (needsBuild) {
        // Check for prefetched result first
        const prefetchedResult = IosCtrlProxyBuilder.getPrefetchedResult();
        let failedBuild = false;
        if (this.isSuccessfulPrefetchedBuild(prefetchedResult)) {
          logger.info("[IOSCtrlProxy] Using prefetched build result");
          buildResult = prefetchedResult;
        } else {
          const selection = await this.waitForOrBuildSetupBundle(perf);
          buildResult = selection.buildResult;
          failedBuild = selection.failed;
        }
        if (failedBuild) {
          this.state.attemptedSetup = false; // Allow retry on next call
          perf.end();
          return {
            success: false,
            message: buildResult.message,
            error: buildResult.error,
            buildResult,
            perfTiming: perf.getTimings(),
          };
        }
      }

      // Start the service
      await perf.track("startService", () =>
        this.host.start({ minimumHealthPollDurationMs, signal }),
      );

      perf.end();
      return this.setupSuccessResult(needsBuild, buildResult, perf);
    } catch (error) {
      this.state.attemptedSetup = false; // Allow retry on next call
      const errorMsg = errorMessage(error);
      logger.warn(`[IOSCtrlProxy] Setup failed: ${errorMessage(error)}`);
      perf.end();
      return {
        success: false,
        message: "Failed to setup CtrlProxy",
        error: errorMsg,
        recoveryInterrupted: error instanceof CtrlProxyStartupRecoveryInterruptedError,
        ...startupFailureClassification(error),
        perfTiming: perf.getTimings(),
      };
    }
  }

  private async waitForOrBuildSetupBundle(
    perf: PerformanceTracker,
  ): Promise<{ buildResult: CtrlProxyIosBuildResult; failed: boolean }> {
    // Wait for prefetch if in progress
    const waitedResult = await perf.track("waitForPrefetch", () =>
      IosCtrlProxyBuilder.waitForPrefetch(),
    );
    if (waitedResult && waitedResult.success) {
      logger.info("[IOSCtrlProxy] Using completed prefetch build result");
      return { buildResult: waitedResult, failed: false };
    }

    // Build synchronously
    logger.info("[IOSCtrlProxy] Downloading CtrlProxy bundle");
    const buildResult = await perf.track("build", () =>
      this.state.builder.build(this.host.isSimulator() ? "simulator" : "device", perf),
    );
    return { buildResult, failed: !buildResult.success };
  }

  private canReuseRunningSetup(force: boolean, isRunning: boolean): boolean {
    return !force && isRunning;
  }

  private previousSetupResult(isAvail: boolean, perf: PerformanceTracker): CtrlProxyIosSetupResult {
    if (isAvail) {
      perf.end();
      return {
        success: true,
        message: "CtrlProxy was already running",
        perfTiming: perf.getTimings(),
      };
    }
    perf.end();
    return {
      success: false,
      message: "Setup already attempted",
      perfTiming: perf.getTimings(),
    };
  }

  private needsSetupBundleRebuild(): Promise<boolean> {
    return this.state.builder.needsRebuild(this.host.isSimulator() ? "simulator" : "device");
  }

  private setupSuccessResult(
    needsBuild: boolean,
    buildResult: CtrlProxyIosBuildResult | null,
    perf: PerformanceTracker,
  ): CtrlProxyIosSetupResult {
    return {
      success: true,
      message: needsBuild
        ? "CtrlProxy downloaded and started successfully"
        : "CtrlProxy started successfully",
      buildResult: buildResult || undefined,
      perfTiming: perf.getTimings(),
    };
  }

  private isSuccessfulPrefetchedBuild(
    result: CtrlProxyIosBuildResult | null,
  ): result is CtrlProxyIosBuildResult {
    return !!result && result.success;
  }

  /**
   * Check if CtrlProxy is installed on the device
   * For simulators, this checks if the test bundle can be found
   */
  async isInstalled(): Promise<boolean> {
    // Check cache first
    if (this.state.cachedInstalled) {
      const cacheAge = this.state.timer.now() - this.state.cachedInstalled.timestamp;
      if (cacheAge < IOS_CTRL_PROXY_STATUS_CACHE_TTL) {
        return this.state.cachedInstalled.isInstalled;
      }
    }

    try {
      logger.debug("[IOSCtrlProxy] Checking if CtrlProxy is installed");

      // Check if we're on a simulator
      if (this.host.isSimulator()) {
        // For simulators, check if we can find the test bundle
        // The test bundle would be installed via xcodebuild test
        // For now, we assume it's available if we can communicate with it
        this.state.cachedInstalled = { isInstalled: true, timestamp: this.state.timer.now() };
        return true;
      }

      // For physical devices, check if the test app is installed
      if (this.host.useRemoteRunner()) {
        const result = await this.state.remoteRunner.runIdeviceInstaller([
          "-u",
          this.state.device.deviceId,
          "-l",
        ]);
        if (!result.success || !result.data) {
          this.state.cachedInstalled = { isInstalled: false, timestamp: this.state.timer.now() };
          return false;
        }
        const installed = result.data.stdout.includes(IOS_CTRL_PROXY_BUNDLE_ID);
        this.state.cachedInstalled = { isInstalled: installed, timestamp: this.state.timer.now() };
        return installed;
      }

      // Direct physical-device command (not through an instrumented client
      // funnel); give it its own ambient leaf (see PerfContext).
      const { stdout } = await trackAmbient("ideviceinstaller -l", () =>
        this.state.processExecutor.executeCommand("ideviceinstaller", [
          "-u",
          this.state.device.deviceId,
          "-l",
        ]),
      );
      const installed = stdout.includes(IOS_CTRL_PROXY_BUNDLE_ID);
      this.state.cachedInstalled = { isInstalled: installed, timestamp: this.state.timer.now() };
      return installed;
    } catch (error) {
      logger.warn(`[IOSCtrlProxy] Error checking installation: ${error}`);
      return false;
    }
  }

  /**
   * Check if CtrlProxy is currently running
   */
  async isRunning(): Promise<boolean> {
    // Check cache first
    if (this.state.cachedRunning) {
      const cacheAge = this.state.timer.now() - this.state.cachedRunning.timestamp;
      if (cacheAge < IOS_CTRL_PROXY_STATUS_CACHE_TTL) {
        return this.state.cachedRunning.isRunning;
      }
    }

    try {
      logger.info("[IOSCtrlProxy] Checking if CtrlProxy is running");

      // Check if the WebSocket server is responding
      const isRunning = await this.host.checkHealthEndpoint();

      // Cache the result
      this.state.cachedRunning = {
        isRunning,
        timestamp: this.state.timer.now(),
      };

      return isRunning;
    } catch (error) {
      logger.warn(`[IOSCtrlProxy] Error checking running status: ${error}`);
      return false;
    }
  }

  /**
   * Check if the service is available (installed and running).
   *
   * Delegates directly to isInstalled()/isRunning() rather than layering its
   * own cache on top: isRunning() already carries the 30s STATUS_CACHE_TTL,
   * which is the only freshness the setup() gate's comment above assumes. A
   * separate hour-long positive cache here let a runner that died without a
   * local child-exit event (killed externally, simulator erased, wedged but
   * still answering /health) report "already running" for up to an hour
   * (#6416).
   */
  async isAvailable(): Promise<boolean> {
    const [installed, running] = await Promise.all([
      this.host.isInstalled(),
      this.host.isRunning(),
    ]);
    return installed && running;
  }

  /**
   * Get device capabilities for CtrlProxy
   */
  async getCapabilities(): Promise<CtrlProxyIosCapabilities> {
    const isSimulator = this.host.isSimulator();

    return {
      supportsXCTest: true, // XCUITest is available on all iOS devices
      deviceType: isSimulator ? "simulator" : "physical",
      iosVersion: null, // iOS version is not sourced from device info.
    };
  }
}

/** Keep terminal setup result shapes unchanged; only typed launch failures opt into retry. */
function startupFailureClassification(
  error: unknown,
): Pick<CtrlProxyIosSetupResult, "retryableStartupFailure"> {
  return error instanceof CtrlProxyRunnerExitedDuringStartupError ||
    error instanceof CtrlProxyLaunchTimeoutError
    ? { retryableStartupFailure: true }
    : {};
}
