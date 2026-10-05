import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { toActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { ActionableError, BootedDevice, HomeScreenResult, ViewHierarchyResult } from "../../models";
import { createGlobalPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";
import { IOSCtrlProxyClient } from "../observe/ios";
import { AndroidCtrlProxyClient } from "../observe/android";
import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { deriveIosScreenIdentity } from "../observe/ios/IosScreenIdentity";
import type { CtrlProxyHierarchy } from "../observe/ios/types";
import { resolveIosHomeBackend } from "../../utils/ios-cmdline-tools/IosHomeBackend";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { sequenceBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { DefaultElementFinder } from "../utility/ElementFinder";

/**
 * Navigates to the home screen using the accessibility service global action
 * (preferred) or hardware home button keyevent (fallback). Verifies the
 * foreground app actually became the launcher before reporting success
 * (issue #6147) rather than trusting either dispatch method's self-reported
 * result.
 */
export class HomeScreen extends BaseVisualChange {
  /**
   * Deadline for the ADB `KEYCODE_HOME` fallback keyevent. Without a bound a
   * wedged adb could hang the whole home navigation well past the enclosing
   * observedInteraction budget; the fallback is also cancellable via the ambient
   * request signal (issue #6289).
   */
  private static readonly HOME_KEYEVENT_TIMEOUT_MS = 3000;
  private static readonly IOS_HOME_VERIFICATION_TIMEOUT_MS = 4000;
  private static readonly IOS_HOME_HIERARCHY_READ_TIMEOUT_MS = 1000;
  private static readonly IOS_HOME_RETRY_DELAYS_MS: readonly number[] = [300, 600, 900];
  private static readonly IOS_SIMULATOR_RETRY_DELAYS_MS: readonly number[] = [100, 200, 400, 500];
  private static readonly IOS_SIMULATOR_READ_TIMEOUT_MS = 1500;
  private static readonly IOS_SIMCTL_LAUNCH_TIMEOUT_MS = 1000;

  constructor(
    device: BootedDevice,
    adb: AdbClient | null = null,
    timer: Timer = defaultTimer,
    private readonly simctl: Pick<SimCtl, "executeCommandArgs"> = new SimCtlClient(device),
  ) {
    super(device, adb, timer);
    this.device = device;
  }

  async execute(progress?: ProgressCallback, signal?: AbortSignal): Promise<HomeScreenResult> {
    throwIfAborted(signal);
    const perf = createGlobalPerformanceTracker();
    perf.serial("homeScreen");
    const options = {
      changeExpected: true,
      foregroundAppMayChange: true,
      usesObservationForResolution: false,
      timeoutMs: 5000,
      progress,
      perf,
      signal,
    };

    return await this.observedInteraction(async (previousObservation) => {
      const previousHierarchy = previousObservation?.viewHierarchy;
      let alreadyOnHome = false;
      switch (this.device.platform) {
        case "android": {
          const launcherPackage = await perf.track("homeNavigation", () =>
            this.executeAndroidHome(signal),
          );
          alreadyOnHome = this.isAndroidHomeSurface(previousHierarchy, launcherPackage);
          break;
        }
        case "ios":
          await perf.track("iOSHomeNavigation", () =>
            this.executeIosHomeNavigation(perf, undefined, undefined, signal),
          );
          alreadyOnHome =
            previousHierarchy?.packageName === "com.apple.springboard" &&
            previousHierarchy.fallbackToSpringboard !== true;
          break;
        default:
          throw unsupportedPlatformError(this.device.platform, "return to the home screen");
      }

      alreadyOnHome = alreadyOnHome && !previousHierarchy?.hierarchy?.error;
      options.changeExpected = !alreadyOnHome;

      return {
        success: true,
        navigationMethod: "hardware",
        ...(alreadyOnHome ? { message: "Already on the home screen" } : {}),
      };
    }, options);
  }

  private isAndroidHomeSurface(
    viewHierarchy: ViewHierarchyResult | undefined,
    launcherPackage: string | undefined,
  ): boolean {
    if (launcherPackage === undefined || viewHierarchy?.packageName !== launcherPackage) {
      return false;
    }
    // Quickstep launchers also render Recents under the launcher package.
    // Exclude overview markers from the pre-action tree without another device read.
    const finder = new DefaultElementFinder();
    return !["overview_panel", "task_view_single"].some((marker) =>
      finder.hasContainerElement(viewHierarchy, { elementId: `${launcherPackage}:id/${marker}` }),
    );
  }

  private async executeAndroidHome(requestSignal?: AbortSignal): Promise<string | undefined> {
    // Combine (never replace) with the ambient MCP request signal so a cancelled
    // request aborts the ADB keyevent fallback and the verification reads. Passing
    // only a private signal would drop the ambient one AdbClient would otherwise
    // pick up (issue #6289).
    const signal = combineWithAmbientAbort(requestSignal);
    let launcherPackage: string | undefined;
    const verificationOptions = {
      signal,
      onVerifiedForeground: (appId: string) => {
        launcherPackage = appId;
      },
    };

    let globalActionSucceeded = false;
    try {
      const client = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
      const result = await client.requestGlobalAction("home", 3000);
      globalActionSucceeded = result.success;
      if (!globalActionSucceeded) {
        logger.debug(`[HOME] Global action failed (${result.error}), falling back to ADB keyevent`);
      }
    } catch (error) {
      // CtrlProxy is optional; the ADB keyevent fallback still navigates home.
      logger.debug(`[HOME] Global action unavailable: ${errorMessage(error)}`);
    }

    if (globalActionSucceeded) {
      if (await this.verifyAndroidHomeForeground(verificationOptions)) {
        logger.debug("[HOME] Used accessibility service global action");
        return launcherPackage;
      }
      // The global action self-reported success but the foreground app never
      // became the launcher (issue #6147 -- observed on API 28). Do not trust
      // the report; fall back to the ADB keyevent path known to work.
      logger.debug(
        "[HOME] Global action reported success but foreground app did not change to the launcher; falling back to ADB keyevent",
      );
    }

    await this.adb.executeCommand(
      "shell input keyevent 3",
      HomeScreen.HOME_KEYEVENT_TIMEOUT_MS,
      undefined,
      true,
      signal,
    );

    if (!(await this.verifyAndroidHomeForeground(verificationOptions))) {
      throw new ActionableError(
        "Home press did not background the foreground app: neither the accessibility global action nor the ADB KEYCODE_HOME keyevent produced a launcher foreground window",
      );
    }
    return launcherPackage;
  }

  async executeIosHomeNavigation(
    perf?: PerformanceTracker,
    frameContext?: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const backend = resolveIosHomeBackend(this.device.deviceId, { simctl: this.simctl });
    if (backend.kind === "physical") {
      const client = IOSCtrlProxyClient.getInstance(this.device);
      const pressError = await awaitWhileRequestIsLive(
        this.tryIosRunnerHome(client, 5000, perf, frameContext),
        signal,
      );
      if (pressError) {
        throw new ActionableError(pressError);
      }
      await this.verifyIosHomeForeground(client, perf, undefined, undefined, undefined, { signal });
      return;
    }

    const deadline = this.timer.now() + (timeoutMs ?? 5000);
    try {
      throwIfAborted(signal);
      await awaitWhileRequestIsLive(
        backend.launchSpringboard({
          timeoutMs: Math.min(
            HomeScreen.IOS_SIMCTL_LAUNCH_TIMEOUT_MS,
            this.iosHomeRemainingMs(deadline),
          ),
        }),
        signal,
      );
    } catch (error) {
      throwIfAborted(signal);
      throw toActionableError(error, "Failed to launch SpringBoard with simctl");
    }

    try {
      const client = IOSCtrlProxyClient.getInstance(this.device);
      await this.verifyIosHomeForeground(
        client,
        perf,
        HomeScreen.IOS_SIMULATOR_RETRY_DELAYS_MS,
        this.iosHomeRemainingMs(deadline),
        HomeScreen.IOS_SIMULATOR_READ_TIMEOUT_MS,
        { pollUntilDeadline: true, signal },
      );
    } catch (error) {
      throwIfAborted(signal);
      throw new ActionableError(
        `simctl launched SpringBoard, but foreground verification failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async tryIosRunnerHome(
    client: IOSCtrlProxyClient,
    timeoutMs: number,
    perf: PerformanceTracker | undefined,
    frameContext: string | undefined,
  ): Promise<string | undefined> {
    try {
      const result = await client.requestPressHome(timeoutMs, perf, frameContext);
      if (frameContext && result.error?.includes("Stale frame context")) {
        throw new ActionableError(result.error);
      }
      return result.success ? undefined : (result.error ?? "Runner failed to press Home");
    } catch (error) {
      if (errorMessage(error).includes("Stale frame context")) {
        throw toActionableError(error, "Home press rejected a stale frame context");
      }
      throw toActionableError(error, "Failed to press iOS home button");
    }
  }

  private iosHomeRemainingMs(deadline: number): number {
    const remaining = deadline - this.timer.now();
    if (remaining <= 0) {
      throw new ActionableError("iOS Home deadline exhausted before SpringBoard could be verified");
    }
    return remaining;
  }

  private async verifyIosHomeForeground(
    client: IOSCtrlProxyClient,
    perf?: PerformanceTracker,
    retryDelaysMs: readonly number[] = HomeScreen.IOS_HOME_RETRY_DELAYS_MS,
    timeoutMs: number = HomeScreen.IOS_HOME_VERIFICATION_TIMEOUT_MS,
    readTimeoutMs: number = HomeScreen.IOS_HOME_HIERARCHY_READ_TIMEOUT_MS,
    options: { pollUntilDeadline?: boolean; signal?: AbortSignal } = {},
  ): Promise<void> {
    const pollUntilDeadline = options.pollUntilDeadline === true;
    const signal = options.signal;
    throwIfAborted(signal);
    const deadline = this.timer.now() + timeoutMs;
    const backoff = sequenceBackoff(retryDelaysMs);
    let lastHierarchy: CtrlProxyHierarchy | undefined;

    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      const remainingMs = deadline - this.timer.now();
      if (remainingMs <= 0) {
        break;
      }
      const hierarchy = await this.readIosHomeForeground(
        client,
        perf,
        Math.min(remainingMs, readTimeoutMs),
        signal,
      );
      if (hierarchy) {
        lastHierarchy = hierarchy;
      }
      if (hierarchy?.packageName === "com.apple.springboard" && this.timer.now() <= deadline) {
        return;
      }

      if (
        !(await this.waitForIosHomeRetry(
          attempt,
          retryDelaysMs.length,
          backoff,
          deadline,
          pollUntilDeadline,
          signal,
        ))
      ) {
        break;
      }
    }

    this.throwIosHomeNotForeground(client, lastHierarchy);
  }

  private async waitForIosHomeRetry(
    attempt: number,
    retryLimit: number,
    backoff: BackoffPolicy,
    deadline: number,
    pollUntilDeadline: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> {
    throwIfAborted(signal);
    if (!pollUntilDeadline && attempt >= retryLimit) {
      return false;
    }
    const delayMs = backoff.delayForAttempt(attempt + 1);
    if (!pollUntilDeadline && this.timer.now() + delayMs >= deadline) {
      return false;
    }
    throwIfAborted(signal);
    await awaitWhileRequestIsLive(
      this.timer.sleep(Math.min(delayMs, deadline - this.timer.now())),
      signal,
    );
    return true;
  }

  private async readIosHomeForeground(
    client: IOSCtrlProxyClient,
    perf: PerformanceTracker | undefined,
    remainingMs: number,
    signal?: AbortSignal,
  ): Promise<CtrlProxyHierarchy | undefined> {
    throwIfAborted(signal);
    try {
      // Request a fresh foreground hierarchy after Home navigation. A cached
      // earlier hierarchy cannot establish the Home postcondition.
      throwIfAborted(signal);
      const response = await awaitWhileRequestIsLive(
        client.requestHierarchySync(perf, true, undefined, remainingMs),
        signal,
      );
      return response?.hierarchy;
    } catch (error) {
      throwIfAborted(signal);
      throw toActionableError(
        error,
        "Failed to verify the iOS foreground app after Home navigation",
      );
    }
  }

  private throwIosHomeNotForeground(
    client: IOSCtrlProxyClient,
    lastHierarchy: CtrlProxyHierarchy | undefined,
  ): never {
    const foregroundApp = lastHierarchy?.packageName ?? "unknown app";
    const modal = lastHierarchy
      ? deriveIosScreenIdentity(client.convertToViewHierarchyResult(lastHierarchy))?.components
      : undefined;
    const alert = modal?.modalClass
      ? `: a system alert (${modal.modalClass}${modal.modalTitle ? ` '${modal.modalTitle}'` : ""}) is blocking Home; dismiss it first`
      : "; the home screen did not become foreground";
    if (foregroundApp === "unknown app") {
      throw new ActionableError("Home press did not bring SpringBoard to the foreground");
    }
    throw new ActionableError(`Home press did not background ${foregroundApp}${alert}`);
  }
}
