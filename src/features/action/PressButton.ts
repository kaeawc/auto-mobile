import type { DispatchedRequestHold } from "../../daemon/dispatchedRequestHold";
import type { IOSDispatchResult } from "../observe/ios/CtrlProxyDispatch";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { unsupportedPlatformError } from "../../models/ActionableError";
import { typedRefusalFields } from "../../models/typedRefusalFields";
import { errorMessage } from "../../utils/describeUnknownError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { BootedDevice, PressButtonResult } from "../../models";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { IOSCtrlProxyClient } from "../observe/ios";
import { AndroidCtrlProxyClient } from "../observe/android";
import { logger } from "../../utils/logger";
import { resolveIosHomeBackend } from "../../utils/ios-cmdline-tools/IosHomeBackend";
import { isNavigationPressButton, resolveAndroidKeyCode } from "./pressButtonPolicy";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { HomeScreen } from "./HomeScreen";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { resolveActionCall, type ActionCall } from "./ActionCall";
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "./observedInteractionProfiles";

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

export class PressButton extends BaseVisualChange {
  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    timer: Timer = defaultTimer,
    private readonly simctl: Pick<SimCtl, "executeCommandArgs"> = new SimCtlClient(device),
    private readonly holdRequest?: DispatchedRequestHold,
  ) {
    super(device, adb, timer);
    this.device = device;
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

  async execute(button: string, call?: ActionCall): Promise<PressButtonResult>;
  /** @deprecated Pass an {@link ActionCall} instead of positional arguments. */
  async execute(
    button: string,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ): Promise<PressButtonResult>;
  async execute(
    button: string,
    progressOrCall?: ProgressCallback | ActionCall,
    signalArg?: AbortSignal,
  ): Promise<PressButtonResult> {
    const { progress, signal } = resolveActionCall(progressOrCall, signalArg);
    throwIfAborted(signal);
    const perf = createGlobalPerformanceTracker();
    perf.serial("pressButton");

    // Navigation buttons (back, home, recent, power) typically cause UI changes like
    // dismissing keyboard, navigating screens, or showing lock screen. We set
    // changeExpected=true so the observation waits for the hierarchy to actually change.
    // Hardware buttons (volume, menu) don't change the hierarchy.
    const isNavigationButton = isNavigationPressButton(button);

    return this.observedInteraction(
      async () => {
        return await perf.track("buttonPress", () =>
          this.press(button, undefined, undefined, signal),
        );
      },
      {
        ...OBSERVED_INTERACTION_PROFILES.noTreeResolution,
        changeExpected: isNavigationButton,
        timeoutMs: SETTLE_BUDGET_MS.navigation,
        progress,
        signal,
        perf,
      },
    );
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
    const indeterminateResult = (reason: string | undefined): PressButtonResult => ({
      success: false,
      button,
      keyCode,
      error: `Button press outcome is indeterminate: the request was dispatched but no result was confirmed (${reason ?? "unknown error"}). The press may have been applied. Do not retry automatically. Observe before retrying.`,
    });
    try {
      throwIfAborted(signal);
      const client = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
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

    const client = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
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
      if (!result.success) {
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
      return { success: true, button, keyCode: -1 };
    }

    if (normalizedButton === "menu") {
      return unsupportedIosButtonResult(button, "iOS has no menu hardware button");
    }

    return unsupportedIosButtonResult(button, `Unsupported iOS button: ${button}`);
  }

  private async executeiOSNavigationButton(
    client: IOSCtrlProxyClient,
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
