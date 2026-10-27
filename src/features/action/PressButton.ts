import { getIosLockStateCache } from "../observe/ios/IosLockStateCacheRegistry";
import type { IosLockStateInvalidator } from "../observe/ios/CachedIosLockStateProbe";
import type { DispatchedRequestHold } from "../../daemon/dispatchedRequestHold";
import type { IOSDispatchResult } from "../observe/ios/CtrlProxyDispatch";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { ActionableError, unsupportedPlatformError } from "../../models/ActionableError";
import { typedRefusalFields } from "../../models/typedRefusalFields";
import { errorMessage } from "../../utils/describeUnknownError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  BaseVisualChange,
  ProgressCallback,
  type DisplayFenceDependencies,
} from "./BaseVisualChange";
import { BootedDevice, ObserveResult, PressButtonResult } from "../../models";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { IOSCtrlProxyClient, type IosCtrlProxy } from "../observe/ios";
import { AndroidCtrlProxyClient } from "../observe/android";
import { logger } from "../../utils/logger";
import { resolveIosHomeBackend } from "../../utils/ios-cmdline-tools/IosHomeBackend";
import { isNavigationPressButton, resolveAndroidKeyCode } from "./pressButtonPolicy";
import {
  androidSystemActionRefusal,
  isAndroidSystemActionButton,
  resolveAndroidSystemAction,
  type AndroidSystemAction,
} from "./androidSystemActions";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { HomeScreen } from "./HomeScreen";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { resolveActionCall, type ActionCall } from "./ActionCall";
import { isRotaryButton, RotaryInput, type RotaryButton } from "./RotaryInput";
import type { DeviceTraits } from "../../utils/android-cmdline-tools/deviceTraits";
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "./observedInteractionProfiles";

/** iOS hardware buttons that only some devices have, pressed via XCUIDevice.Button (#14100). */
const IOS_OPTIONAL_HARDWARE_BUTTONS: ReadonlySet<string> = new Set(["action", "camera"]);

/** Wording GesturePerformer.GestureError.notSupported puts on the wire. */
const IOS_RUNNER_NOT_SUPPORTED_PREFIX = "Feature not supported";

export function unsupportedIosButtonResult(button: string, error: string): PressButtonResult {
  return {
    success: false,
    button,
    keyCode: -1,
    code: "unsupported_button",
    retryable: false,
    error,
  };
}

/** CtrlProxy slices a button press uses; each defaults to the device's real client. */
export interface PressButtonCtrlProxyOverrides {
  iosLockStateInvalidator?: IosLockStateInvalidator;
  globalActionClient?: Pick<AndroidCtrlProxyClient, "requestGlobalAction">;
  frameContextClient?: Pick<AndroidCtrlProxyClient, "validateFrameContext">;
  /** Capability check plus global-action dispatch for the Android system actions (#14095). */
  systemActionClient?: Pick<AndroidCtrlProxyClient, "requestGlobalAction" | "supportsCommand">;
  /** Build-characteristics read the rotary gate uses (#14920). */
  deviceTraits?: DeviceTraits;
}

/** `steps` only counts rotary detents; passing it with another button is a mistake worth refusing. */
function rejectStepsOnPlainButton(button: string, call: unknown): undefined {
  const steps =
    typeof call === "object" && call !== null ? (call as PressButtonCall).steps : undefined;
  if (steps !== undefined) {
    throw new ActionableError(
      `steps applies to rotary_rotate_cw and rotary_rotate_ccw only, not ${button}.`,
    );
  }
  return undefined;
}

/** `ActionCall` for pressButton: also carries the rotary step count (#14920). */
export interface PressButtonCall extends ActionCall {
  steps?: number;
}

/** A dispatched press whose outcome was never confirmed: replaying it could apply it twice. */
function indeterminatePressResult(
  button: string,
  keyCode: number,
  reason: string | undefined,
): PressButtonResult {
  return {
    success: false,
    button,
    keyCode,
    code: "indeterminate_outcome",
    retryable: false,
    error: `Button press outcome is indeterminate: the request was dispatched but no result was confirmed (${reason ?? "unknown error"}). The press may have been applied. Do not retry automatically. Observe before retrying.`,
  };
}

/** True when an iOS Home press starts from a verified SpringBoard, so "no visual change" is fine. */
export function isIosHomePressOnSpringboard(
  platform: string,
  button: string,
  observation: ObserveResult | undefined,
): boolean {
  const hierarchy = observation?.viewHierarchy;
  return (
    platform === "ios" &&
    button.toLowerCase() === "home" &&
    hierarchy?.packageName === "com.apple.springboard" &&
    hierarchy.fallbackToSpringboard !== true &&
    !hierarchy.hierarchy?.error
  );
}

/**
 * True when the pre-press tree was SpringBoard reached through the runner's foreground fallback.
 * On the real home screen the runner always reports `fallbackToSpringboard: true` (#14954), so
 * the flag cannot veto a Home press; the post-press SpringBoard check decides instead.
 */
export function isIosSpringboardFallbackPress(
  platform: string,
  button: string,
  observation: ObserveResult | undefined,
): boolean {
  const hierarchy = observation?.viewHierarchy;
  return (
    platform === "ios" &&
    button.toLowerCase() === "home" &&
    hierarchy?.packageName === "com.apple.springboard" &&
    hierarchy.fallbackToSpringboard === true &&
    !hierarchy.hierarchy?.error
  );
}

/**
 * A Home press that began on a fallback SpringBoard and still ends on a healthy SpringBoard
 * without a visual change was already home: report success instead of "No visual change".
 */
export function acceptIosHomeAlreadyOnSpringboard(
  result: { success: boolean; error?: string; observation?: ObserveResult },
  startedOnFallbackSpringboard: boolean,
): void {
  const after = result.observation?.viewHierarchy;
  if (
    startedOnFallbackSpringboard &&
    !result.success &&
    result.error === "No visual change observed" &&
    after?.packageName === "com.apple.springboard" &&
    !after.hierarchy?.error
  ) {
    result.success = true;
    delete result.error;
  }
}

/** A successful Android Home dispatch already verified the launcher foreground (#15028). */
export function acceptAndroidHomeAlreadyOnLauncher(
  result: { success: boolean; error?: string },
  context: { platform: string; button: string; pressSucceeded: boolean },
): void {
  if (
    context.platform === "android" &&
    context.button.toLowerCase() === "home" &&
    context.pressSucceeded &&
    !result.success &&
    result.error === "No visual change observed"
  ) {
    result.success = true;
    delete result.error;
  }
}

export class PressButton extends BaseVisualChange {
  private readonly globalActionClient?: PressButtonCtrlProxyOverrides["globalActionClient"];
  private readonly frameContextClient?: PressButtonCtrlProxyOverrides["frameContextClient"];
  private readonly systemActionClient?: PressButtonCtrlProxyOverrides["systemActionClient"];
  private readonly deviceTraits?: DeviceTraits;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    timer: Timer = defaultTimer,
    private readonly simctl: Pick<SimCtl, "executeCommandArgs"> = new SimCtlClient(device),
    private readonly holdRequest?: DispatchedRequestHold,
    collaborators: DisplayFenceDependencies & PressButtonCtrlProxyOverrides = {},
  ) {
    super(device, adb, timer, undefined, collaborators);
    this.device = device;
    this.iosLockStateInvalidator = collaborators.iosLockStateInvalidator;
    this.globalActionClient = collaborators.globalActionClient;
    this.frameContextClient = collaborators.frameContextClient;
    this.systemActionClient = collaborators.systemActionClient;
    this.deviceTraits = collaborators.deviceTraits;
  }

  private iosLockStateInvalidator?: IosLockStateInvalidator;

  private defaultCtrlProxyClient(): ReturnType<typeof AndroidCtrlProxyClient.getInstance> {
    return AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
  }

  private systemActionTransport(): NonNullable<
    PressButtonCtrlProxyOverrides["systemActionClient"]
  > {
    return this.systemActionClient ?? this.defaultCtrlProxyClient();
  }

  private globalActionTransport(): Pick<AndroidCtrlProxyClient, "requestGlobalAction"> {
    return this.globalActionClient ?? this.defaultCtrlProxyClient();
  }

  private frameContextTransport(): Pick<AndroidCtrlProxyClient, "validateFrameContext"> {
    return this.frameContextClient ?? this.defaultCtrlProxyClient();
  }

  /** Typed test view so tests can drive the deadline gate and the per-platform dispatch without a full press. */
  get testHooks(): {
    verifyAndroidHomeForeground: (
      options?: Parameters<BaseVisualChange["verifyAndroidHomeForeground"]>[0],
    ) => Promise<boolean>;
    executeAndroidButtonPress: PressButton["press"];
    executeiOSButtonPress: PressButton["press"];
  } {
    return {
      verifyAndroidHomeForeground: (options = {}) => this.verifyAndroidHomeForeground(options),
      executeAndroidButtonPress: (...args) => this.executeAndroidButtonPress(...args),
      executeiOSButtonPress: (...args) => this.executeiOSButtonPress(...args),
    };
  }

  private assertHeldRequestLive(signal?: AbortSignal): void {
    if (this.holdRequest) {
      throwIfAborted(signal);
    }
  }

  private awaitDispatchedRequest<T>(
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    send: (fenced: AbortSignal | undefined, onDispatch: () => void) => Promise<T>,
    onDispatch?: () => void,
    liveWait = false,
  ): Promise<T> {
    if (this.holdRequest) {
      return this.holdRequest(signal, timeoutMs, send, onDispatch);
    }
    const request = send(signal, () => onDispatch?.());
    return liveWait ? awaitWhileRequestIsLive(request, signal) : request;
  }

  async execute(button: string, call?: PressButtonCall): Promise<PressButtonResult>;
  /** @deprecated Pass an {@link ActionCall} instead of positional arguments. */
  async execute(
    button: string,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<PressButtonResult>;
  async execute(
    button: string,
    progressOrCall?: ProgressCallback | PressButtonCall,
    signalArg?: AbortSignal,
  ): Promise<PressButtonResult> {
    const { progress, signal } = resolveActionCall(progressOrCall, signalArg);
    const rotary = isRotaryButton(button) ? this.rotaryInput() : undefined;
    // Refuse a bad rotary call before observing; `steps` means nothing on any other button.
    const rotarySteps = isRotaryButton(button)
      ? await rotary?.prepare(
          button,
          typeof progressOrCall === "object" ? progressOrCall?.steps : undefined,
        )
      : rejectStepsOnPlainButton(button, progressOrCall);
    throwIfAborted(signal);
    const perf = createGlobalPerformanceTracker();
    perf.serial("pressButton");

    // Navigation buttons (back, home, recent, power) typically cause UI changes like
    // dismissing keyboard, navigating screens, or showing lock screen. We set
    // changeExpected=true so the observation waits for the hierarchy to actually change.
    // Hardware buttons (volume, menu) don't change the hierarchy.
    const isNavigationButton = isNavigationPressButton(button);

    const options = {
      ...OBSERVED_INTERACTION_PROFILES.noTreeResolution,
      changeExpected: isNavigationButton,
      timeoutMs: SETTLE_BUDGET_MS.navigation,
      progress,
      signal,
      perf,
    };
    let startedOnFallbackSpringboard = false;
    let pressSucceeded = false;
    const result = await this.observedInteraction(async (previousObservation) => {
      // A Home press on SpringBoard may change nothing (#14954); that is a no-op success.
      if (isIosHomePressOnSpringboard(this.device.platform, button, previousObservation)) {
        options.changeExpected = false;
      }
      startedOnFallbackSpringboard = isIosSpringboardFallbackPress(
        this.device.platform,
        button,
        previousObservation,
      );
      const pressed = await perf.track("buttonPress", () =>
        rotary && isRotaryButton(button)
          ? this.pressRotary(rotary, button, rotarySteps ?? 1, signal)
          : this.press(button, undefined, undefined, signal),
      );
      pressSucceeded = pressed.success;
      return pressed;
    }, options);
    acceptIosHomeAlreadyOnSpringboard(result, startedOnFallbackSpringboard);
    acceptAndroidHomeAlreadyOnLauncher(result, {
      platform: this.device.platform,
      button,
      pressSucceeded,
    });
    return result;
  }

  private async pressRotary(
    rotary: RotaryInput,
    button: RotaryButton,
    steps: number,
    signal?: AbortSignal,
  ): Promise<PressButtonResult> {
    try {
      return await rotary.press(button, steps, signal);
    } finally {
      if (isNavigationPressButton(button)) {
        this.windowCacheInvalidator.invalidate(this.device, true);
      }
    }
  }

  private rotaryInput(): RotaryInput {
    return new RotaryInput(this.device, this.adb, this.deviceTraits);
  }

  /**
   * Press a hardware/navigation button.
   *
   * @param button - Button name to press
   * @param timeoutMs - Optional deadline budget (e.g. the socket request's
   *   remaining time). When provided it is threaded into every underlying
   *   runner/ADB call so the caller's timeout is honored instead of the
   *   per-transport hard-coded defaults. When omitted, the existing defaults
   *   apply.
   * @param frameContext - Optional frame-context token to validate before the
   *   ADB fallback dispatch.
   * @param signal - Optional cancellation signal. Threaded into the Android ADB
   *   keyevent dispatch and the home-foreground verification reads (a `home`
   *   press verifies end-to-end) so a cancelled caller — e.g. Explore's
   *   AbortSignal forwarded through `resetToHome` — actually aborts the device
   *   work rather than only shrinking a timeout budget.
   */
  async press(
    button: string,
    timeoutMs?: number,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<PressButtonResult> {
    throwIfAborted(signal);
    let dispatched = false;
    const markDispatch = () => {
      if (!dispatched) {
        dispatched = true;
        onDispatch?.();
      }
    };
    try {
      switch (this.device.platform) {
        case "android":
          return await this.executeAndroidButtonPress(
            button,
            timeoutMs,
            frameContext,
            signal,
            markDispatch,
          );
        case "ios":
          return await this.executeiOSButtonPress(
            button,
            timeoutMs,
            frameContext,
            signal,
            markDispatch,
          );
        default:
          throw unsupportedPlatformError(this.device.platform, "press buttons");
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`Failed to press ${button}: ${errorMessage(error)}`, error);
      const refusal = typedRefusalFields(error);
      return {
        success: false,
        button,
        keyCode: -1,
        ...(refusal
          ? { code: refusal.code, retryable: refusal.retryable }
          : { code: "press_failed", retryable: false }),
        error: `Failed to press button: ${errorMessage(error)}`,
      };
    } finally {
      if (this.device.platform === "ios") {
        (this.iosLockStateInvalidator ?? getIosLockStateCache()).invalidate(this.device.deviceId);
      }
      if (isNavigationPressButton(button)) {
        this.windowCacheInvalidator.invalidate(this.device, true);
      }
    }
  }

  // Buttons that can be handled via accessibility service global actions
  private static readonly GLOBAL_ACTION_BUTTONS = new Set(["back", "home", "recent"]);
  static readonly IOS_NAVIGATION_BUTTONS: ReadonlySet<string> = new Set(["home", "back", "recent"]);
  static readonly IOS_HARDWARE_BUTTONS: ReadonlySet<string> = new Set([
    "volume_up",
    "volume_down",
    "power",
    ...IOS_OPTIONAL_HARDWARE_BUTTONS,
  ]);

  /**
   * Execute Android-specific button press.
   * Uses accessibility service global actions for back/home/recent (faster),
   * falls back to ADB keyevent for all buttons.
   */
  // Default fast-fail budget for the accessibility-service global-action path
  // before we fall back to ADB keyevent.
  private static readonly GLOBAL_ACTION_TIMEOUT_MS = 3000;

  private async executeAndroidButtonPress(
    button: string,
    timeoutMs?: number,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<PressButtonResult> {
    const normalized = button.toLowerCase();
    if (IOS_OPTIONAL_HARDWARE_BUTTONS.has(normalized)) {
      return unsupportedIosButtonResult(
        button,
        `"${normalized}" is an iOS-only hardware button (Action button / Camera Control); Android has no equivalent in pressButton.`,
      );
    }
    const systemAction = resolveAndroidSystemAction(normalized);
    if (systemAction) {
      return this.executeAndroidSystemAction(
        button,
        systemAction,
        timeoutMs,
        frameContext,
        signal,
        onDispatch,
      );
    }
    const keyCode = resolveAndroidKeyCode(normalized);
    if (keyCode === undefined) {
      return {
        success: false,
        button,
        keyCode: -1,
        error: `Unsupported button: ${button}`,
      };
    }

    // When a budget is supplied, honor it as an absolute deadline shared across
    // the (optional) global-action attempt and the ADB fallback so the caller's
    // timeout is not exceeded by the sum of the two per-transport defaults.
    const deadlineMs = timeoutMs !== undefined ? this.timer.now() + timeoutMs : undefined;
    const globalActionResult = await this.tryAndroidGlobalAction(
      button,
      normalized,
      keyCode,
      deadlineMs,
      frameContext,
      { signal, onDispatch },
    );
    if (globalActionResult) {
      return globalActionResult;
    }

    // Fail fast if the (optional) deadline was fully consumed by the global-action
    // attempt or frame-context validation above. Passing 0 to executeCommand would arm NO timeout (the
    // `if (timeoutMs)` check treats 0 as falsy), leaving the ADB keyevent
    // unbounded — the exact overrun this budget threading exists to prevent.
    const adbBudget = this.remainingMs(deadlineMs);
    if (adbBudget !== undefined && adbBudget <= 0) {
      return {
        success: false,
        button,
        keyCode: -1,
        error: `Button press deadline exhausted before ADB keyevent for ${button}`,
      };
    }

    // Combine the forwarded signal with the ambient request signal so BOTH can
    // cancel the ADB keyevent fallback: passing `signal` alone would replace the
    // ambient signal AdbClient.executeArgsImpl would otherwise pick up, dropping
    // MCP request cancellation on this fallback dispatch (issue #6289).
    throwIfAborted(signal);
    const dispatchSignal = combineWithAmbientAbort(signal);
    let validationFailure: PressButtonResult | undefined;
    try {
      await this.awaitDispatchedRequest(
        signal,
        adbBudget,
        (fenced, dispatched) =>
          Promise.resolve().then(() =>
            this.adb.execute(["shell", "input", "keyevent", String(keyCode)], {
              timeoutMs: adbBudget,
              noRetry: true,
              signal: combineWithAmbientAbort(fenced),
              beforeDispatch: async () => {
                throwIfAborted(dispatchSignal);
                validationFailure = await this.validateFrameContextBeforeAdb(
                  button,
                  keyCode,
                  deadlineMs,
                  frameContext,
                  signal,
                );
                throwIfAborted(dispatchSignal);
                if (validationFailure) {
                  throw new Error(validationFailure.error);
                }
                const remainingMs = this.remainingMs(deadlineMs);
                if (remainingMs !== undefined && remainingMs <= 0) {
                  validationFailure = {
                    success: false,
                    button,
                    keyCode: -1,
                    error: `Button press deadline exhausted before ADB keyevent for ${button}`,
                  };
                  throw new Error(validationFailure.error);
                }
                fenced?.throwIfAborted();
                dispatched();
              },
            }),
          ),
        onDispatch,
        true,
      );
      this.assertHeldRequestLive(signal);
    } catch (error) {
      if (validationFailure) {
        return validationFailure;
      }
      throw error;
    }

    // "home" is verified end-to-end (issue #6147): neither the accessibility
    // global action above nor this ADB keyevent are trustworthy on their own
    // self-reported success, on API 28 specifically. Other buttons (back,
    // recent, hardware) have no equivalently cheap ground truth to check
    // against and keep their existing dispatch-is-success behavior.
    // Verify within the REMAINING budget, not a fresh full timeout: the ADB
    // keyevent above already spent part of the caller's deadline, so re-derive
    // the leftover and hand it to verification (which shares it across getActive,
    // launcher lookup, and retries) rather than letting getActive fall back to
    // its 5s default and overrun the keyed device-input op (issue #6289).
    if (
      normalized === "home" &&
      !(await this.verifyAndroidHomeForeground({
        signal,
        timeoutMs: this.remainingMs(deadlineMs),
      }))
    ) {
      return {
        success: false,
        button,
        keyCode: -1,
        error:
          "Home press did not background the foreground app: the ADB KEYCODE_HOME keyevent did not produce a launcher foreground window",
      };
    }
    return { success: true, button, keyCode };
  }

  /**
   * Android system actions (#14095): lock, power dialog, Quick Settings, screenshot, split screen
   * and notification-shade dismissal. They exist only as CtrlProxy global actions, so a missing
   * capability is a typed refusal and there is no ADB fallback.
   */
  private async executeAndroidSystemAction(
    button: string,
    action: AndroidSystemAction,
    timeoutMs: number | undefined,
    frameContext: string | undefined,
    signal: AbortSignal | undefined,
    onDispatch: (() => void) | undefined,
  ): Promise<PressButtonResult> {
    throwIfAborted(signal);
    const client = this.systemActionTransport();
    if (!(await client.supportsCommand(action.capability))) {
      return {
        success: false,
        button,
        keyCode: -1,
        code: "unsupported_system_action",
        retryable: false,
        error: androidSystemActionRefusal(button, action),
      };
    }
    const budget = timeoutMs ?? PressButton.GLOBAL_ACTION_TIMEOUT_MS;
    let dispatched = false;
    try {
      const result = await this.awaitDispatchedRequest(
        signal,
        budget,
        (fenced, markDispatch) =>
          client.requestGlobalAction(
            action.wireAction,
            budget,
            undefined,
            frameContext,
            fenced,
            markDispatch,
          ),
        () => {
          dispatched = true;
          onDispatch?.();
        },
        true,
      );
      throwIfAborted(signal);
      if (result.success) {
        return {
          success: true,
          button,
          keyCode: -1,
          ...(action.successWarning ? { warnings: [action.successWarning] } : {}),
        };
      }
      if (dispatched && !result.acknowledged) {
        return indeterminatePressResult(button, -1, result.error);
      }
      return {
        success: false,
        button,
        keyCode: -1,
        code: "system_action_failed",
        retryable: false,
        error: `The device refused ${button}: ${result.error ?? "unknown error"}`,
      };
    } catch (error) {
      throwIfAborted(signal);
      if (dispatched) {
        logger.warn(`[PRESS_BUTTON] System action ${button} threw after dispatch`, error);
        return indeterminatePressResult(button, -1, errorMessage(error));
      }
      // Nothing was sent, so the shared press_failed result built by execute() is accurate.
      throw error;
    }
  }

  private async tryAndroidGlobalAction(
    button: string,
    normalized: string,
    keyCode: number,
    deadlineMs: number | undefined,
    frameContext: string | undefined,
    options: { signal?: AbortSignal; onDispatch?: () => void },
  ): Promise<PressButtonResult | undefined> {
    const { signal, onDispatch } = options;
    if (!PressButton.GLOBAL_ACTION_BUTTONS.has(normalized)) {
      return undefined;
    }
    const budget = this.remainingMs(deadlineMs);
    if (budget !== undefined && budget <= 0) {
      return undefined;
    }
    const globalActionTimeout =
      budget === undefined
        ? PressButton.GLOBAL_ACTION_TIMEOUT_MS
        : Math.min(PressButton.GLOBAL_ACTION_TIMEOUT_MS, budget);
    let dispatched = false;
    const indeterminateResult = (reason: string | undefined): PressButtonResult =>
      indeterminatePressResult(button, keyCode, reason);
    try {
      throwIfAborted(signal);
      const client = this.globalActionTransport();
      const result = await this.awaitDispatchedRequest(
        signal,
        globalActionTimeout,
        (fenced, markDispatch) =>
          client.requestGlobalAction(
            normalized,
            globalActionTimeout,
            undefined,
            frameContext,
            fenced,
            markDispatch,
          ),
        () => {
          // HOME is idempotent; only latch presses that must not be replayed.
          dispatched = normalized !== "home";
          onDispatch?.();
        },
        true,
      );
      throwIfAborted(signal);
      if (result.success) {
        // "home" specifically can self-report success while leaving the
        // foreground app unchanged on API 28 (issue #6147). Confirm the
        // foreground actually became the launcher before trusting it; other
        // global-action buttons (back, recent) keep the prior behavior.
        if (
          normalized !== "home" ||
          (await this.verifyAndroidHomeForeground({
            signal,
            timeoutMs: this.remainingMs(deadlineMs),
          }))
        ) {
          logger.debug(`[PRESS_BUTTON] Used accessibility service for ${button}`);
          return { success: true, button, keyCode };
        }
        logger.debug(
          `[PRESS_BUTTON] Global action for ${button} reported success but foreground app did not change to the launcher; falling back to ADB`,
        );
      } else {
        if (dispatched && !result.acknowledged) {
          return indeterminateResult(result.error);
        }
        logger.debug(`[PRESS_BUTTON] Global action failed (${result.error}), falling back to ADB`);
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[PRESS_BUTTON] Global action threw for ${button}`, error);
      if (dispatched) {
        return indeterminateResult(errorMessage(error));
      }
    }
    return undefined;
  }

  private async validateFrameContextBeforeAdb(
    button: string,
    keyCode: number,
    deadlineMs: number | undefined,
    frameContext: string | undefined,
    signal?: AbortSignal,
  ): Promise<PressButtonResult | undefined> {
    if (frameContext === undefined) {
      return undefined;
    }
    const validationBudget = this.remainingMs(deadlineMs);
    if (validationBudget !== undefined && validationBudget <= 0) {
      return {
        success: false,
        button,
        keyCode: -1,
        error: `Button press deadline exhausted before frame context validation for ${button}`,
      };
    }

    const client = this.frameContextTransport();
    const validation = await client.validateFrameContext(frameContext, validationBudget, signal);
    if (validation.success) {
      return undefined;
    }
    return {
      success: false,
      button,
      keyCode: -1,
      error:
        validation.error ??
        "Frame context is stale or unavailable; observe a fresh frame before retrying",
    };
  }

  private remainingMs(deadlineMs: number | undefined): number | undefined {
    return deadlineMs === undefined ? undefined : deadlineMs - this.timer.now();
  }

  /**
   * Execute iOS-specific button press
   * @param button - Button name to press
   * @returns Result of the button press operation
   */
  private async executeiOSButtonPress(
    button: string,
    timeoutMs?: number,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<PressButtonResult> {
    throwIfAborted(signal);
    const normalizedButton = button.toLowerCase();
    if (
      PressButton.IOS_NAVIGATION_BUTTONS.has(normalizedButton) ||
      PressButton.IOS_HARDWARE_BUTTONS.has(normalizedButton)
    ) {
      const client = IOSCtrlProxyClient.getInstance(this.device);
      const result = PressButton.IOS_NAVIGATION_BUTTONS.has(normalizedButton)
        ? await this.executeiOSNavigationButton(
            client,
            normalizedButton,
            timeoutMs,
            frameContext,
            signal,
            onDispatch,
          )
        : await this.awaitDispatchedRequest(
            signal,
            timeoutMs,
            (fenced, dispatch) =>
              client.requestPressButton(
                normalizedButton,
                timeoutMs,
                undefined,
                frameContext,
                fenced,
                dispatch,
              ),
            onDispatch,
          );
      this.assertHeldRequestLive(signal);
      return result.success
        ? { success: true, button, keyCode: -1 }
        : iosPressFailureResult(button, normalizedButton, result);
    }

    if (normalizedButton === "menu") {
      return unsupportedIosButtonResult(button, "iOS has no menu hardware button");
    }
    if (isAndroidSystemActionButton(normalizedButton)) {
      return unsupportedIosButtonResult(
        button,
        `"${normalizedButton}" is an Android-only system action; iOS has no equivalent in pressButton.`,
      );
    }

    return unsupportedIosButtonResult(button, `Unsupported iOS button: ${button}`);
  }

  private async executeiOSNavigationButton(
    client: IosCtrlProxy,
    button: string,
    timeoutMs?: number,
    frameContext?: string,
    signal?: AbortSignal,
    onDispatch?: () => void,
  ): Promise<IOSDispatchResult<{ success: boolean; error?: string }>> {
    throwIfAborted(signal);
    switch (button) {
      case "home":
        if (
          resolveIosHomeBackend(this.device.deviceId, { simctl: this.simctl }).kind === "simulator"
        ) {
          if (!this.holdRequest) {
            await awaitWhileRequestIsLive(
              new HomeScreen(this.device, null, this.timer, this.simctl).executeIosHomeNavigation(
                undefined,
                frameContext,
                timeoutMs,
                signal,
                onDispatch,
              ),
              signal,
            );
            return { success: true };
          }
          let launch: ReturnType<SimCtl["executeCommandArgs"]> | undefined;
          const simctl: Pick<SimCtl, "executeCommandArgs"> = {
            executeCommandArgs: (args, options) => {
              launch = this.awaitDispatchedRequest(
                signal,
                timeoutMs,
                (fenced, dispatch) => {
                  throwIfAborted(fenced);
                  dispatch();
                  return this.simctl.executeCommandArgs(args, options);
                },
                onDispatch,
              );
              return launch;
            },
          };
          try {
            // Verification uses the caller signal; only the launch wait is fenced.
            await new HomeScreen(this.device, null, this.timer, simctl).executeIosHomeNavigation(
              undefined,
              frameContext,
              timeoutMs,
              signal,
            );
          } finally {
            // HomeScreen can stop on cancellation before simctl settles; retain the key until then.
            await launch;
          }
          return { success: true };
        }
        const result = await this.awaitDispatchedRequest(
          signal,
          timeoutMs,
          (fenced, dispatch) =>
            client.requestPressHome(timeoutMs, undefined, frameContext, fenced, dispatch),
          onDispatch,
        );
        throwIfAborted(signal);
        return result;
      case "back":
        return await this.awaitDispatchedRequest(
          signal,
          timeoutMs,
          (fenced, dispatch) =>
            client.requestPressBack(timeoutMs, undefined, frameContext, fenced, dispatch),
          onDispatch,
        );
      case "recent":
        return await this.awaitDispatchedRequest(
          signal,
          timeoutMs,
          (fenced, dispatch) =>
            client.requestRecentApps(timeoutMs, undefined, frameContext, fenced, dispatch),
          onDispatch,
        );
      default:
        return { success: false, error: `Unsupported iOS button: ${button}` };
    }
  }
}

/** Map a failed iOS runner press to a typed result: unsupported, indeterminate, or failed. */
function iosPressFailureResult(
  button: string,
  normalizedButton: string,
  result: { error?: string; dispatched?: boolean; acknowledged?: boolean },
): PressButtonResult {
  if (
    IOS_OPTIONAL_HARDWARE_BUTTONS.has(normalizedButton) &&
    result.error?.startsWith(IOS_RUNNER_NOT_SUPPORTED_PREFIX)
  ) {
    return unsupportedIosButtonResult(
      button,
      `${result.error}. The ${normalizedButton} button needs a device that has it (hasHardwareButton) and a CtrlProxy runner built with Xcode 16.3 or later.`,
    );
  }
  if (normalizedButton !== "home" && result.dispatched && result.acknowledged === false) {
    return {
      success: false,
      button,
      keyCode: -1,
      code: "indeterminate_outcome",
      retryable: false,
      error: `Button press outcome is indeterminate: the request was dispatched but no result was confirmed (${result.error ?? "unknown error"}). The press may have been applied. Do not retry automatically. Observe before retrying.`,
    };
  }
  return {
    success: false,
    button,
    keyCode: -1,
    code: "press_failed",
    retryable: false,
    error:
      result.error ??
      (PressButton.IOS_HARDWARE_BUTTONS.has(normalizedButton)
        ? `iOS hardware button "${button}" is not supported on this device`
        : `Failed to press iOS ${normalizedButton} button`),
  };
}
