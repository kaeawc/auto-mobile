import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { toActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  BaseVisualChange,
  ProgressCallback,
  type DisplayFenceDependencies,
} from "./BaseVisualChange";
import {
  ActionableError,
  BootedDevice,
  HomeScreenResult,
  ObserveResult,
  ViewHierarchyResult,
} from "../../models";
import { createGlobalPerformanceTracker, PerformanceTracker } from "../../utils/PerformanceTracker";
import { IOSCtrlProxyClient, type IosCtrlProxy } from "../observe/ios";
import { AndroidCtrlProxyClient } from "../observe/android";
import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { deriveIosScreenIdentity } from "../observe/ios/IosScreenIdentity";
import { hierarchyChanged } from "../../utils/hierarchyFingerprint";
import type { CtrlProxyHierarchy } from "../observe/ios/types";
import {
  resolveIosHomeBackend,
  type IosHomeBackend,
} from "../../utils/ios-cmdline-tools/IosHomeBackend";
import { SimctlCommandTimeoutError } from "../../utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { IosHomeLaunchTimeoutError } from "../../models/IosHomeLaunchTimeoutError";
import { IosHomeNotForegroundError } from "../../models/IosHomeNotForegroundError";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { sequenceBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";
import {
  wasHierarchyReadDuringCall,
  withObservationReadScope,
} from "../observe/observationReadScope";
import { isForegroundLauncher } from "../observe/androidLauncherPackages";
import { deviceIncarnationToken } from "../../utils/deviceIncarnation";
import { resolveActionCall, type ActionCall } from "./ActionCall";
import { SETTLE_BUDGET_MS } from "./observedInteractionProfiles";

// Overlay ids come from the Pixel Launcher captures under test/fixtures/android-launcher/.
const ANDROID_LAUNCHER_OVERLAY_MARKERS = [
  "overview_panel",
  "task_view_single",
  "apps_view",
  "search_container_all_apps",
  "primary_widgets_list_view",
  "folder_content",
] as const;

/**
 * Navigates to the home screen using the accessibility service global action
 * (preferred) or hardware home button keyevent (fallback). Verifies the
 * foreground app actually became the launcher before reporting success
 * (issue #6147) rather than trusting either dispatch method's self-reported
 * result.
 */
const SPOTLIGHT_BUNDLE_ID = "com.apple.Spotlight";

/** The runner's one-shot foreground check failure; keep in sync with CommandHandler+TextInput.swift. */
const RUNNER_HOME_NOT_FOREGROUND_ERROR = "Home press did not bring SpringBoard to the foreground";

/** Named inputs for `HomeScreen.executeIosHomeNavigation`; replaces its positional tail (#11835). */
export interface IosHomeNavigationOptions {
  perf?: PerformanceTracker;
  frameContext?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onDispatch?: () => void;
}

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
  // Busy simulator hosts can take over 1s just to run an xcrun child (#11946).
  private static readonly IOS_SIMCTL_LAUNCH_ATTEMPT_TIMEOUT_MS = 2500;
  // SpringBoard launch is idempotent; retry timeouts briefly within the Home budget (#11946).
  private static readonly IOS_SIMCTL_LAUNCH_RETRY_DELAYS_MS: readonly number[] = [100, 200, 400];

  private readonly globalActionClient?: Pick<AndroidCtrlProxyClient, "requestGlobalAction">;

  private readonly simctl: Pick<SimCtl, "executeCommandArgs">;

  constructor(
    device: BootedDevice,
    {
      adb = null,
      timer = defaultTimer,
      simctl = new SimCtlClient(device),
      collaborators = {},
    }: {
      adb?: AdbExecutor | null;
      timer?: Timer;
      simctl?: Pick<SimCtl, "executeCommandArgs">;
      collaborators?: DisplayFenceDependencies & {
        /** Defaults to the device's real CtrlProxy client. */
        globalActionClient?: Pick<AndroidCtrlProxyClient, "requestGlobalAction">;
      };
    } = {},
  ) {
    super(device, adb, timer, undefined, collaborators);
    this.simctl = simctl;
    this.device = device;
    this.globalActionClient = collaborators.globalActionClient;
  }

  async execute(call?: ActionCall): Promise<HomeScreenResult>;
  /** @deprecated Pass an {@link ActionCall} instead of positional arguments. */
  async execute(progress?: ProgressCallback, signal?: AbortSignal): Promise<HomeScreenResult>;
  async execute(
    progressOrCall?: ProgressCallback | ActionCall,
    signalArg?: AbortSignal,
  ): Promise<HomeScreenResult> {
    const { progress, signal } = resolveActionCall(progressOrCall, signalArg);
    return withObservationReadScope(() => this.executeWithReadScope(progress, signal));
  }

  private async executeWithReadScope(
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<HomeScreenResult> {
    throwIfAborted(signal);
    const perf = createGlobalPerformanceTracker();
    perf.serial("homeScreen");
    const options = {
      changeExpected: true,
      foregroundAppMayChange: true,
      usesObservationForResolution: false,
      timeoutMs: SETTLE_BUDGET_MS.lifecycle,
      progress,
      perf,
      signal,
    };

    let possiblyAlreadyHome: ViewHierarchyResult | undefined;
    const result = await this.observedInteraction<HomeScreenResult>(async (previousObservation) => {
      const previousHierarchy = await this.readHomeHierarchy(
        previousObservation,
        perf,
        options.timeoutMs,
        signal,
      );
      let alreadyOnHome = false;
      switch (this.device.platform) {
        case "android": {
          alreadyOnHome = await this.isAndroidHomeSurface(previousHierarchy, signal);
          await perf.track("homeNavigation", () => this.executeAndroidHome(signal));
          break;
        }
        case "ios":
          await perf.track("iOSHomeNavigation", () =>
            this.executeIosHomeNavigation({ perf, signal }),
          );
          // A fallback can also be the real home screen. Navigation above verifies
          // SpringBoard foreground; compare the final tree before calling it already home.
          if (
            previousHierarchy?.packageName === "com.apple.springboard" &&
            !previousHierarchy.hierarchy?.error
          ) {
            alreadyOnHome = previousHierarchy.fallbackToSpringboard !== true;
            possiblyAlreadyHome = alreadyOnHome ? undefined : previousHierarchy;
          }
          break;
        default:
          throw unsupportedPlatformError(this.device.platform, "return to the home screen");
      }

      options.changeExpected = !alreadyOnHome && !possiblyAlreadyHome;

      return {
        success: true,
        navigationMethod: "hardware",
        ...(alreadyOnHome ? { message: "Already on the home screen" } : {}),
      };
    }, options);
    if (
      result.success &&
      possiblyAlreadyHome &&
      hierarchyChanged(possiblyAlreadyHome, result.observation?.viewHierarchy) === false
    ) {
      result.message = "Already on the home screen";
    }
    return result;
  }

  private async readHomeHierarchy(
    previousObservation: ObserveResult,
    perf: PerformanceTracker,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ViewHierarchyResult | undefined> {
    if (this.device.platform === "android") {
      const readSignal = combineWithAmbientAbort(signal);
      throwIfAborted(readSignal);
      let currentObservation = previousObservation;
      if (
        !previousObservation.viewHierarchy ||
        !wasHierarchyReadDuringCall(previousObservation.viewHierarchy)
      ) {
        try {
          currentObservation = await perf.track("refreshHomeObservation", () =>
            this.observeScreen.execute({
              freshness: "fresh",
              requireFreshExtraction: true,
              timeoutMs,
              skipScreenshot: true,
              skipAccessibilityAudit: true,
              skipPerformanceAudit: true,
              skipRecompositionTracking: true,
              skipBackStack: true,
              skipCache: true,
              skipStaleWindowRecovery: true,
              perf,
              signal: readSignal,
            }),
          );
        } catch (error) {
          throwIfAborted(readSignal);
          logger.warn(`[HOME] Pre-dispatch hierarchy read failed: ${errorMessage(error)}`, error);
          // Retain the required envelope metadata, without cached surface evidence.
          currentObservation = {
            observationId: previousObservation.observationId,
            display: previousObservation.display,
            updatedAt: previousObservation.updatedAt,
            screenSize: { width: 0, height: 0 },
            systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
          };
        }
      }
      throwIfAborted(readSignal);
      if (currentObservation.viewHierarchy?.hierarchy?.error) {
        currentObservation = { ...currentObservation, viewHierarchy: undefined };
      }
      if (currentObservation !== previousObservation) {
        // Keep the shared baseline object's identity, but replace all its fields.
        // Unknown reads must not compare a stale Home tree with post-dispatch Home.
        for (const key of Object.keys(previousObservation)) {
          Reflect.deleteProperty(previousObservation, key);
        }
        for (const [key, value] of Object.entries(currentObservation)) {
          Reflect.set(previousObservation, key, value);
        }
      }
    }
    return previousObservation.viewHierarchy;
  }

  private async isAndroidHomeSurface(
    viewHierarchy: ViewHierarchyResult | undefined,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const launcherPackage = viewHierarchy?.packageName;
    if (!launcherPackage || viewHierarchy?.hierarchy?.error) {
      return false;
    }
    if (
      !(await isForegroundLauncher(launcherPackage, this.adb, this.device.deviceId, this.timer, {
        formFactor: this.device.formFactor,
        incarnationToken: deviceIncarnationToken(this.device.deviceId),
        signal,
        timeoutMs: 5000,
      }))
    ) {
      return false;
    }
    const selector = new ResolverElementSelector();
    // Overlays outrank a workspace that remains visible underneath (#9762).
    if (
      ANDROID_LAUNCHER_OVERLAY_MARKERS.some((marker) =>
        selector.hasContainer(viewHierarchy, { elementId: `${launcherPackage}:id/${marker}` }),
      )
    ) {
      return false;
    }
    const workspace = selector.resolveContainerMatch(viewHierarchy, {
      elementId: `${launcherPackage}:id/workspace`,
    });
    // Partial occlusion is normal on Home (system bars), so do not exclude it.
    if (workspace?.visibleToUser === true) {
      return true;
    }
    // Preserve already-home handling for launchers with a different vocabulary.
    // An existing but hidden workspace still requires a visual change (#9762).
    return workspace === undefined;
  }

  /** @internal Typed view of private execution paths for unit tests; not part of the public API. */
  get testHooks() {
    return { executeAndroidHome: this.executeAndroidHome.bind(this) };
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
      const client =
        this.globalActionClient ?? AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
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

    await this.adb.executeCommand("shell input keyevent 3", {
      timeoutMs: HomeScreen.HOME_KEYEVENT_TIMEOUT_MS,
      noRetry: true,
      signal,
    });

    if (!(await this.verifyAndroidHomeForeground(verificationOptions))) {
      throw new ActionableError(
        "Home press did not background the foreground app: neither the accessibility global action nor the ADB KEYCODE_HOME keyevent produced a launcher foreground window",
      );
    }
    return launcherPackage;
  }

  async executeIosHomeNavigation(options: IosHomeNavigationOptions = {}): Promise<void> {
    const { perf, frameContext, timeoutMs, signal, onDispatch } = options;
    throwIfAborted(signal);
    const backend = resolveIosHomeBackend(this.device.deviceId, { simctl: this.simctl });
    if (backend.kind === "physical") {
      const client = this.iosClient();
      const pressError = await awaitWhileRequestIsLive(
        this.tryIosRunnerHome(client, 5000, { perf, frameContext, signal, onDispatch }),
        signal,
      );
      if (pressError) {
        throw new ActionableError(pressError);
      }
      await this.verifyIosHomeForeground(client, { perf, signal });
      return;
    }

    const budgetMs = timeoutMs ?? 5000;
    const deadline = this.timer.now() + budgetMs;
    const attempts = await this.launchIosSpringboard(backend, deadline, budgetMs, {
      signal,
      onDispatch,
    });
    throwIfAborted(signal);
    if (deadline - this.timer.now() <= 0) {
      throw new IosHomeLaunchTimeoutError(
        `SpringBoard launch used the whole Home budget after ${attempts} attempt(s) (${budgetMs}ms), so the foreground could not be verified. The simulator host may be busy; the call can be retried.`,
      );
    }

    try {
      const client = this.iosClient();
      try {
        await this.verifyIosHomeForeground(client, {
          perf,
          retryDelaysMs: HomeScreen.IOS_SIMULATOR_RETRY_DELAYS_MS,
          timeoutMs: this.iosHomeRemainingMs(deadline),
          readTimeoutMs: HomeScreen.IOS_SIMULATOR_READ_TIMEOUT_MS,
          pollUntilDeadline: true,
          signal,
        });
      } catch (error) {
        // simctl's SpringBoard launch does not dismiss Spotlight on iOS 27 (#14827); the runner's
        // hardware Home press does, so retry once through it and verify again.
        if (
          !(error instanceof IosHomeNotForegroundError) ||
          error.foregroundApp !== SPOTLIGHT_BUNDLE_ID
        ) {
          throw error;
        }
        await this.pressRunnerHomeThenVerify(client, perf, signal, onDispatch);
      }
    } catch (error) {
      throwIfAborted(signal);
      throw new ActionableError(
        `simctl launched SpringBoard, but foreground verification failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private async pressRunnerHomeThenVerify(
    client: IosCtrlProxy,
    perf: PerformanceTracker | undefined,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<void> {
    const pressError = await awaitWhileRequestIsLive(
      this.tryIosRunnerHome(client, 5000, { perf, signal, onDispatch }),
      signal,
    );
    // The runner checks the foreground once, right after the press, and SpringBoard can take
    // about a second to settle after Spotlight (#14827). That error means "sent, unverified", so
    // fall through to the polling check instead of failing before it runs.
    if (pressError && pressError !== RUNNER_HOME_NOT_FOREGROUND_ERROR) {
      throw new ActionableError(pressError);
    }
    await this.verifyIosHomeForeground(client, {
      perf,
      retryDelaysMs: HomeScreen.IOS_SIMULATOR_RETRY_DELAYS_MS,
      readTimeoutMs: HomeScreen.IOS_SIMULATOR_READ_TIMEOUT_MS,
      pollUntilDeadline: true,
      signal,
    });
  }

  /** The device's runner client, resolved at each use so a retired client is never reused. */
  private iosClient(): IosCtrlProxy {
    return IOSCtrlProxyClient.getInstance(this.device);
  }

  private async launchIosSpringboard(
    backend: IosHomeBackend,
    deadline: number,
    budgetMs: number,
    { signal, onDispatch }: { signal?: AbortSignal; onDispatch?: () => void },
  ): Promise<number> {
    const backoff = sequenceBackoff(HomeScreen.IOS_SIMCTL_LAUNCH_RETRY_DELAYS_MS);
    let attempts = 0;
    let lastTimeout: SimctlCommandTimeoutError | undefined;
    for (;;) {
      throwIfAborted(signal);
      const remainingMs = deadline - this.timer.now();
      if (remainingMs <= 0) {
        throw new IosHomeLaunchTimeoutError(
          `SpringBoard could not be launched with simctl within the Home budget after ${attempts} attempt(s) (${budgetMs}ms). The simulator host may be busy; the call can be retried.`,
          { cause: lastTimeout },
        );
      }
      attempts++;
      try {
        if (attempts === 1) {
          onDispatch?.();
        }
        throwIfAborted(signal);
        await awaitWhileRequestIsLive(
          backend.launchSpringboard({
            timeoutMs: Math.min(HomeScreen.IOS_SIMCTL_LAUNCH_ATTEMPT_TIMEOUT_MS, remainingMs),
          }),
          signal,
        );
        throwIfAborted(signal);
        return attempts;
      } catch (error) {
        throwIfAborted(signal);
        if (!(error instanceof SimctlCommandTimeoutError)) {
          throw toActionableError(error, "Failed to launch SpringBoard with simctl");
        }
        lastTimeout = error;
        // A busy host timeout is safe to retry because SpringBoard launch is idempotent.
        logger.debug(`[HOME] SpringBoard launch attempt ${attempts} timed out`, error);
      }
      const delayMs = Math.min(backoff.delayForAttempt(attempts), deadline - this.timer.now());
      if (delayMs > 0) {
        await awaitWhileRequestIsLive(this.timer.sleep(delayMs), signal);
      }
      throwIfAborted(signal);
    }
  }

  private async tryIosRunnerHome(
    client: IosCtrlProxy,
    timeoutMs: number,
    options: Omit<IosHomeNavigationOptions, "timeoutMs"> = {},
  ): Promise<string | undefined> {
    const { perf, frameContext } = options;
    try {
      const result = await client.requestPressHome(
        timeoutMs,
        perf,
        frameContext,
        options.signal,
        options.onDispatch,
      );
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
    client: IosCtrlProxy,
    options: {
      perf?: PerformanceTracker;
      retryDelaysMs?: readonly number[];
      timeoutMs?: number;
      readTimeoutMs?: number;
      pollUntilDeadline?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const {
      perf,
      retryDelaysMs = HomeScreen.IOS_HOME_RETRY_DELAYS_MS,
      timeoutMs = HomeScreen.IOS_HOME_VERIFICATION_TIMEOUT_MS,
      readTimeoutMs = HomeScreen.IOS_HOME_HIERARCHY_READ_TIMEOUT_MS,
      signal,
    } = options;
    const pollUntilDeadline = options.pollUntilDeadline === true;
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
          { retryLimit: retryDelaysMs.length, backoff, deadline, pollUntilDeadline },
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
    policy: {
      retryLimit: number;
      backoff: BackoffPolicy;
      deadline: number;
      pollUntilDeadline: boolean;
    },
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { retryLimit, backoff, deadline, pollUntilDeadline } = policy;
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
    client: IosCtrlProxy,
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
    client: IosCtrlProxy,
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
    throw new IosHomeNotForegroundError(
      `Home press did not background ${foregroundApp}${alert}`,
      foregroundApp,
    );
  }
}
