import { errorMessage } from "../../utils/describeUnknownError";
import { BaseVisualChange } from "./BaseVisualChange";
import {
  BootedDevice,
  ImeAction,
  KeyboardResult,
  ObserveResult,
  SendTextResult,
  ViewHierarchyResult,
} from "../../models";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { readAndroidDeviceApiLevel } from "../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { AdbCommandTimeoutError } from "../../utils/android-cmdline-tools/AdbClient";
import { resolveAutoInputMode } from "./resolveAutoInputMode";
import { serverConfig } from "../../utils/ServerConfig";
import { clearTextWithKeyEvents, getFocusedTextLength, hasFocusedTextInput } from "./ClearText";
import {
  ANDROID_KEYCOMBINATION_MIN_API_LEVEL,
  asciiKeyEventNeedsKeyCombination,
  buildAsciiKeyEventPlan,
  type KeyEventPlan,
} from "./asciiKeyEvents";
import { Keyboard } from "./Keyboard";
import { TapOnElement } from "./TapOnElement";

export type InputTextMode = "a11y" | "eventLast" | "eventAll" | "eventOnly" | "append";

/** Selector variants that identify a field to focus before typing (issue #5872). */
export interface TextInputTargetSelector {
  elementId?: string;
  testTag?: string;
  text?: string;
  textAny?: string[];
}

/**
 * Focuses the field a `selector` names before {@link InputText} types into it,
 * collapsing the mandatory focus-then-type pair into one call (issue #5872 AC3).
 * Interface + fake so the focus step is unit-testable without a real tap.
 */
export interface TextInputTargetFocuser {
  focus(
    selector: TextInputTargetSelector,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; error?: string }>;
}

type TextInputTargetFocuserFactory = (device: BootedDevice) => TextInputTargetFocuser;

const defaultTargetFocuserFactory: TextInputTargetFocuserFactory = (device) => ({
  focus: async (selector, signal) => {
    const result = await new TapOnElement(device).execute(
      { ...selector, action: "focus" },
      undefined,
      signal,
    );
    return { success: result.success, error: result.error };
  },
});

const DEVICE_TIMESTAMP_SECOND_GRANULARITY_MARGIN_MS = 1000;

export type AppendKeyEventValidator = (
  timeoutMs?: number,
) => Promise<{ success: boolean; error?: string }>;

interface KeyboardCloser {
  close(signal?: AbortSignal): Promise<KeyboardResult>;
}

type KeyboardCloserFactory = (device: BootedDevice, adbFactory: AdbClientFactory) => KeyboardCloser;

const defaultKeyboardCloserFactory: KeyboardCloserFactory = (device, adbFactory) => {
  const keyboard = new Keyboard(device, adbFactory);
  return {
    close: (signal) => keyboard.execute("close", signal),
  };
};

function assertInputNotAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export class InputText extends BaseVisualChange {
  private androidInputKeyCombinationSupported: boolean | undefined;
  private targetFocuser: TextInputTargetFocuser;

  constructor(
    device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = null,
    private readonly keyboardCloserFactory: KeyboardCloserFactory = defaultKeyboardCloserFactory,
    timer: Timer = defaultTimer,
    targetFocuserFactory: TextInputTargetFocuserFactory = defaultTargetFocuserFactory,
  ) {
    super(device, adbFactoryOrExecutor, timer);
    this.device = device;
    this.targetFocuser = targetFocuserFactory(device);
  }

  async execute(
    text: string,
    imeAction?: ImeAction,
    dismissKeyboard: boolean = false,
    mode?: InputTextMode,
    signal?: AbortSignal,
    selector?: TextInputTargetSelector,
  ): Promise<SendTextResult & { method?: InputTextMode }> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("inputText");

    // Validate text input
    if (text === undefined || text === null) {
      perf.end();
      return {
        success: false,
        text: "",
        error: "No text provided",
        method: "a11y",
      };
    }

    // Resolve the Android input mode: an explicit caller-supplied mode always
    // wins; otherwise consumer-configured markers may auto-promote to
    // `eventAll` (real key events); otherwise fall back to the default `a11y`.
    // Mode is Android-only — iOS ignores it, so skip the resolution there.
    let resolvedMode: InputTextMode = mode ?? "a11y";
    if (this.device.platform === "android" && mode === undefined) {
      const autoMode = resolveAutoInputMode(text, serverConfig.getEventAllMarkers());
      if (autoMode) {
        resolvedMode = autoMode;
        logger.debug(
          "[InputText] auto-promoted a11y -> eventAll (text matched a configured event-all marker)",
        );
      }
    }

    // A selector focuses the target field first (issue #5872 AC3), so the text
    // lands where the caller means rather than in whatever happened to be focused.
    // Focus before the observedInteraction captures its baseline, so the "before"
    // snapshot already reflects the focused field. A focus failure short-circuits —
    // typing into an unknown field would be worse than reporting the miss.
    if (selector) {
      assertInputNotAborted(signal);
      const focusResult = await this.targetFocuser.focus(selector, signal);
      if (!focusResult.success) {
        perf.end();
        return {
          success: false,
          text,
          error: focusResult.error ?? "Failed to focus the target element before typing",
          method: this.device.platform === "android" ? resolvedMode : "a11y",
        };
      }
    }

    assertInputNotAborted(signal);
    const result = await this.observedInteraction(
      async (previousObserveResult) => {
        try {
          assertInputNotAborted(signal);
          // Platform-specific text input execution
          switch (this.device.platform) {
            case "android":
              return await perf.track("androidTextInput", () =>
                this.executeAndroidTextInput(
                  text,
                  imeAction,
                  dismissKeyboard,
                  resolvedMode,
                  previousObserveResult,
                  signal,
                ),
              );
            case "ios":
              // dismissKeyboard is Android-only — it works around an emulator
              // bug where the soft keyboard stays visible after setText.
              return await perf.track("iOSTextInput", () =>
                this.executeiOSTextInput(text, imeAction, signal),
              );
            default:
              perf.end();
              throw new Error(`Unsupported platform: ${this.device.platform}`);
          }
        } catch (error) {
          assertInputNotAborted(signal);
          perf.end();
          const errorMsg = errorMessage(error);
          logger.warn(`[InputText] text input failed (mode=${resolvedMode}): ${errorMsg}`, error);

          return {
            success: false,
            text,
            error: `Failed to send text input: ${errorMsg}`,
            method: this.device.platform === "android" ? resolvedMode : "a11y",
          };
        }
      },
      {
        changeExpected: true,
        tolerancePercent: 0.0,
        timeoutMs: 5000,
        perf,
        signal,
        skipUiStability: true, // Skip UI stability wait - a11y service already waits 100ms for tree update
      },
    );
    assertInputNotAborted(signal);
    return result;
  }

  /**
   * Execute Android-specific text input using accessibility service
   * @param text - Text to input
   * @param imeAction - Optional IME action
   * @returns Result with method information
   */
  private async executeAndroidTextInput(
    text: string,
    imeAction?: ImeAction,
    dismissKeyboard: boolean = false,
    mode: InputTextMode = "a11y",
    previousObserveResult?: ObserveResult,
    signal?: AbortSignal,
  ): Promise<SendTextResult & { method?: InputTextMode }> {
    assertInputNotAborted(signal);
    if (mode === "eventLast") {
      return this.executeAndroidEventLastTextInput(text, imeAction, dismissKeyboard, signal);
    }

    if (mode === "eventAll") {
      return this.executeAndroidEventAllTextInput(text, imeAction, dismissKeyboard, signal);
    }

    if (mode === "append") {
      return this.executeAndroidAppendTextInput(
        text,
        imeAction,
        dismissKeyboard,
        undefined,
        undefined,
        signal,
      );
    }

    if (mode === "eventOnly") {
      return this.executeAndroidEventOnlyTextInput(
        text,
        imeAction,
        dismissKeyboard,
        previousObserveResult,
        signal,
      );
    }

    // Use accessibility service exclusively (fastest method, ~10-30ms vs ~200-300ms for ADB)
    // It also natively supports Unicode without needing virtual keyboard.
    // Text is set WITHOUT the runner's dismissKeyboard flag: SHOW_MODE_HIDDEN
    // suppresses re-showing the keyboard but does not dismiss an already-visible
    // IME window, and combining it with the Keyboard.close() route below would
    // leave close() deciding to send Back off a cached "IME open" tree after the
    // runner had already hidden the window — navigating the app instead (#5887).
    const a11yClient = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
    const a11yResult = await a11yClient.requestSetText(text);
    assertInputNotAborted(signal);

    if (a11yResult.success) {
      logger.info(`[InputText] Text input via accessibility service: ${a11yResult.totalTimeMs}ms`);

      // Run the IME action (submit/next) BEFORE dismissing: dismissing first can
      // move focus so Enter/Tab/Search lands on the wrong target, and a dismissal
      // failure must not skip the action the caller actually asked for (#5887).
      if (imeAction) {
        await this.executeImeAction(imeAction, signal);
      }

      // Dismiss via the confirmed Keyboard.close() route (KEYCODE_BACK + state
      // poll), the same path eventOnly/append use (issue #5887).
      if (dismissKeyboard) {
        const dismissError = await this.dismissKeyboardViaCloser("a11y", signal);
        if (dismissError) {
          return {
            success: false,
            text,
            error: dismissError,
            method: "a11y",
          };
        }
      }

      return {
        success: true,
        text,
        imeAction,
        method: "a11y",
      };
    }

    // Return failure - no fallback methods. Getting past a keyguard is the job
    // of the dedicated `wakeAndUnlock` tool, not inputText (issue #4360).
    logger.warn(`[InputText] Accessibility service setText failed: ${a11yResult.error}`);
    return {
      success: false,
      text,
      error: `Accessibility service setText failed: ${a11yResult.error}`,
      method: "a11y",
    };
  }

  private async executeAndroidEventLastTextInput(
    text: string,
    imeAction?: ImeAction,
    dismissKeyboard: boolean = false,
    signal?: AbortSignal,
  ): Promise<SendTextResult & { method?: InputTextMode }> {
    assertInputNotAborted(signal);
    const split = this.findLastPrintableAsciiNonWhitespace(text);

    if (!split) {
      logger.info(
        "[InputText] eventLast requested but no printable non-whitespace ASCII character was found; using a11y",
      );
      const result = await this.executeAndroidTextInput(
        text,
        imeAction,
        dismissKeyboard,
        "a11y",
        undefined,
        signal,
      );
      return { ...result, method: "a11y" };
    }

    const { index, char } = split;
    const prefix = text.slice(0, index);
    const suffix = text.slice(index + 1);
    const keyEventPlan = await this.getAsciiKeyEventPlan(char, undefined, signal);
    assertInputNotAborted(signal);
    if (!keyEventPlan) {
      logger.info(
        `[InputText] eventLast could not map ASCII character ${JSON.stringify(char)} to a key event; using a11y`,
      );
      const result = await this.executeAndroidTextInput(
        text,
        imeAction,
        dismissKeyboard,
        "a11y",
        undefined,
        signal,
      );
      return { ...result, method: "a11y" };
    }

    const a11yClient = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);

    const prefixResult = await a11yClient.requestSetText(prefix);
    assertInputNotAborted(signal);
    if (!prefixResult.success) {
      return this.setTextFailure(
        text,
        "eventLast prefix",
        "before real key event",
        prefixResult.error,
        "eventLast",
      );
    }

    await this.executeKeyEventPlan(keyEventPlan, undefined, false, undefined, signal);

    if (suffix.length > 0) {
      const finalResult = await a11yClient.requestSetText(text);
      assertInputNotAborted(signal);
      if (!finalResult.success) {
        return this.setTextFailure(
          text,
          "eventLast final",
          "after real key event",
          finalResult.error,
          "eventLast",
        );
      }
    }

    // IME action before dismiss — see the a11y path for why (issue #5887).
    if (imeAction) {
      await this.executeImeAction(imeAction, signal);
    }

    // Dismiss via the confirmed Keyboard.close() route (issue #5887).
    if (dismissKeyboard) {
      const dismissError = await this.dismissKeyboardViaCloser("eventLast", signal);
      if (dismissError) {
        return {
          success: false,
          text,
          error: dismissError,
          method: "eventLast",
        };
      }
    }

    return {
      success: true,
      text,
      imeAction,
      method: "eventLast",
    };
  }

  private async executeAndroidEventAllTextInput(
    text: string,
    imeAction?: ImeAction,
    dismissKeyboard: boolean = false,
    signal?: AbortSignal,
  ): Promise<SendTextResult & { method?: InputTextMode }> {
    assertInputNotAborted(signal);
    const chars = Array.from(text);
    if (!(await this.hasAsciiKeyEventPlan(chars, signal))) {
      const result = await this.executeAndroidTextInput(
        text,
        imeAction,
        dismissKeyboard,
        "a11y",
        undefined,
        signal,
      );
      return { ...result, method: "a11y" };
    }

    const a11yClient = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
    const clearResult = await a11yClient.requestSetText("");
    assertInputNotAborted(signal);
    if (!clearResult.success) {
      return this.setTextFailure(
        text,
        "eventAll initial clear",
        "before eventAll input",
        clearResult.error,
        "eventAll",
      );
    }

    let targetText = "";
    for (let index = 0; index < chars.length; index++) {
      assertInputNotAborted(signal);
      const char = chars[index] ?? "";
      const keyEventPlan = await this.getAsciiKeyEventPlan(char, undefined, signal);

      if (keyEventPlan) {
        await this.executeKeyEventPlan(keyEventPlan, undefined, false, undefined, signal);
        targetText += char;
        continue;
      }

      let unsupportedRun = char;
      while (
        index + 1 < chars.length &&
        !(await this.getAsciiKeyEventPlan(chars[index + 1] ?? "", undefined, signal))
      ) {
        assertInputNotAborted(signal);
        index++;
        unsupportedRun += chars[index] ?? "";
      }

      targetText += unsupportedRun;
      const setTextResult = await a11yClient.requestSetText(targetText);
      assertInputNotAborted(signal);
      if (!setTextResult.success) {
        return this.setTextFailure(
          text,
          "eventAll unsupported text run",
          "during eventAll input",
          setTextResult.error,
          "eventAll",
        );
      }
    }

    if (dismissKeyboard) {
      const finalResult = await a11yClient.requestSetText(text);
      assertInputNotAborted(signal);
      if (!finalResult.success) {
        return this.setTextFailure(
          text,
          "eventAll final",
          "after eventAll input",
          finalResult.error,
          "eventAll",
        );
      }
    }

    // IME action before dismiss — see the a11y path for why (issue #5887).
    if (imeAction) {
      await this.executeImeAction(imeAction, signal);
    }

    // Dismiss via the confirmed Keyboard.close() route (issue #5887).
    if (dismissKeyboard) {
      const dismissError = await this.dismissKeyboardViaCloser("eventAll", signal);
      if (dismissError) {
        return {
          success: false,
          text,
          error: dismissError,
          method: "eventAll",
        };
      }
    }

    return {
      success: true,
      text,
      imeAction,
      method: "eventAll",
    };
  }

  /**
   * Public entry point for the append mode, bypassing the observe round trip
   * `execute` performs.
   *
   * An interactive client mirroring a keyboard sends one call per keystroke, so
   * a before/after observation per character would dominate the latency of
   * every key press — and the append path needs no hierarchy at all (it neither
   * clears nor measures the field). Android only; the caller checks platform.
   *
   * @param timeoutMs - Total budget for this call's OWN device operations, charged
   *   across the API-level probe and every `adb shell input ...` subprocess it spawns
   *   (each re-reads the remaining budget and bails at <= 0), so their combined
   *   elapsed cannot exceed one budget. Callers that hold a per-device queue (the
   *   daemon's `input/typeText`) MUST pass it: without a bound, one stalled adb
   *   invocation blocks both the response and every later input for that device.
   *   Omitting it leaves the subprocesses unbounded, which is only safe for a caller
   *   that owns its own lifetime.
   *
   *   `AdbClient` charges its shared ADB-path discovery against the same command
   *   deadline, so a cold or expired path cache cannot escape this request budget.
   */
  async appendText(
    text: string,
    timeoutMs?: number,
    beforeKeyEvents?: AppendKeyEventValidator,
    signal?: AbortSignal,
  ): Promise<SendTextResult & { method?: InputTextMode }> {
    return this.executeAndroidAppendTextInput(
      text,
      undefined,
      false,
      timeoutMs,
      beforeKeyEvents,
      signal,
    );
  }

  /**
   * Append `text` to the focused field using real key events only.
   *
   * Every other Android mode is REPLACE-shaped: `a11y` sends the whole string
   * through `ACTION_SET_TEXT`, and `eventAll`/`eventOnly` clear the field before
   * typing. That is right for "make this field say X" automation, but wrong for
   * an interactive client mirroring one keystroke at a time — there, each
   * keystroke would wipe the field and leave only the last character
   * (issue #3351). This mode never clears and never calls setText, so N
   * single-character calls build up the same text a human would type.
   *
   * Unmappable characters FAIL rather than falling back to `a11y`: the fallback
   * would silently replace the field's contents, which is the exact destruction
   * this mode exists to avoid. The caller sees an actionable error instead.
   *
   * Unlike `eventOnly` this needs no view hierarchy — it neither clears nor
   * measures the field — which also keeps a per-keystroke call to one round trip.
   *
   * Every device round trip — the API-level probe and each `adb shell input ...`
   * subprocess — is charged against `timeoutMs` when the caller supplies one, so a
   * stalled adb fails fast inside the caller's budget instead of parking the
   * caller's queue forever.
   */
  private async executeAndroidAppendTextInput(
    text: string,
    imeAction?: ImeAction,
    dismissKeyboard: boolean = false,
    timeoutMs?: number,
    beforeKeyEvents?: AppendKeyEventValidator,
    signal?: AbortSignal,
  ): Promise<SendTextResult & { method?: InputTextMode }> {
    assertInputNotAborted(signal);
    const remaining = this.createBudget(timeoutMs);
    const planned = await this.planAppendKeyEvents(text, remaining, timeoutMs, signal);
    if (planned.error) {
      // Planning failed before any key event was issued, so nothing landed.
      return this.appendFailure(text, planned.error, 0);
    }

    const typed = await this.typeAppendKeyEvents(
      planned.plans,
      remaining,
      timeoutMs,
      beforeKeyEvents,
      signal,
    );
    if (typed.error) {
      // A non-timeout failure leaves an exact confirmed prefix, while a timed-out
      // key event is ambiguous: Android may have accepted it before adb was killed.
      return this.appendFailure(text, typed.error, typed.charsSent);
    }

    // IME action before dismiss — see the a11y path for why (issue #5887).
    if (imeAction) {
      await this.executeImeAction(imeAction, signal);
    }

    if (dismissKeyboard) {
      const dismissError = await this.dismissKeyboardViaCloser("append", signal);
      if (dismissError) {
        // All characters landed; only the post-typing keyboard dismissal failed,
        // so the full text was sent — a retry must NOT re-append any of it.
        return this.appendFailure(text, dismissError, typed.charsSent);
      }
    }

    return {
      success: true,
      text,
      imeAction,
      method: "append",
      charsSent: typed.charsSent,
    };
  }

  /**
   * Map every character of `text` to a key-event plan.
   *
   * The API-level capability (`input keycombination`, API 31+) is needed ONLY for
   * uppercase/shifted characters, so the probe runs once for the whole batch and
   * ONLY when at least one character needs it (issue #3351). A lowercase / digit /
   * space / unshifted-punctuation append never probes: the probe is a device round
   * trip that would be pure waste there — and worse, if it consumed the remaining
   * budget the typing phase would then report exhaustion and drop a keystroke that
   * needed no capability at all. When it does probe, the probe is charged against
   * the same budget the typing uses.
   *
   * Returns an `error` instead of throwing so the caller emits one uniform append
   * failure. Nothing is sent when any character is unmappable: a partial append
   * would leave the field holding a prefix of what the user typed.
   */
  private async planAppendKeyEvents(
    text: string,
    remaining: () => number | undefined,
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<{ plans: KeyEventPlan[]; error?: string }> {
    assertInputNotAborted(signal);
    const chars = Array.from(text);
    const needsCapability = chars.some((char) => asciiKeyEventNeedsKeyCombination(char));

    let supportsKeyCombination = false;
    if (needsCapability) {
      const budget = remaining();
      if (budget !== undefined && budget <= 0) {
        return { plans: [], error: this.appendBudgetExceeded(timeoutMs, "resolving key events") };
      }
      supportsKeyCombination = await this.supportsAndroidInputKeyCombination(budget, signal);
    }

    const plans: KeyEventPlan[] = [];
    for (const char of chars) {
      const keyEventPlan = buildAsciiKeyEventPlan(char, supportsKeyCombination);
      if (!keyEventPlan) {
        return {
          plans,
          error: `append cannot type ${JSON.stringify(char)} with Android key events`,
        };
      }
      plans.push(keyEventPlan);
    }
    return { plans };
  }

  /**
   * Issue the planned key events, re-reading the remaining budget before each one so
   * a slow device cannot let N subprocesses each consume the full timeout.
   *
   * Returns how many plans (i.e. leading characters of the append) were sent, plus
   * an optional error. One plan == one character, executed in order, so `charsSent`
   * is the length of the prefix that landed on the device — a caller retrying after
   * a partial failure must re-send only `text.slice(charsSent)`, never the whole
   * string (issue #3351: re-appending "ab" after "a" landed would produce "aab").
   * An adb rejection becomes a typed failure rather than a throw: the daemon holds a
   * per-device queue across this call and needs a prompt, describable answer.
   */
  private async typeAppendKeyEvents(
    plans: KeyEventPlan[],
    remaining: () => number | undefined,
    timeoutMs: number | undefined,
    beforeKeyEvents?: AppendKeyEventValidator,
    signal?: AbortSignal,
  ): Promise<{ charsSent?: number; error?: string }> {
    let charsSent = 0;
    for (const plan of plans) {
      assertInputNotAborted(signal);
      const budget = remaining();
      if (budget !== undefined && budget <= 0) {
        return { charsSent, error: this.appendBudgetExceeded(timeoutMs, "typing") };
      }
      let validationError: string | undefined;
      const beforeDispatch =
        charsSent === 0 && beforeKeyEvents
          ? async (remainingTimeoutMs?: number) => {
              try {
                const validation = await beforeKeyEvents(remainingTimeoutMs);
                assertInputNotAborted(signal);
                if (!validation.success) {
                  validationError =
                    validation.error ??
                    "Frame context is stale or unavailable; observe a fresh frame before retrying";
                }
              } catch (error) {
                const message = errorMessage(error);
                validationError = `append frame context validation failed: ${message}`;
              }
              const budgetAfterValidation = remaining();
              if (
                validationError === undefined &&
                budgetAfterValidation !== undefined &&
                budgetAfterValidation <= 0
              ) {
                validationError = this.appendBudgetExceeded(timeoutMs, "typing");
              }
              if (validationError) {
                throw new Error(validationError);
              }
            }
          : undefined;
      try {
        // noRetry: production AdbClient retries a timed-out command up to 4 total
        // attempts, each charged the SAME budget — and runInputOperationWithTimeout
        // awaits the losing operation before releasing the per-device queue, so a
        // stalled key event would otherwise hold the queue for ~4x the request
        // deadline. A single attempt keeps this append's device operations within
        // one budget, including shared ADB-path discovery.
        await this.executeKeyEventPlan(plan, budget, true, beforeDispatch, signal);
      } catch (error) {
        assertInputNotAborted(signal);
        if (validationError) {
          return { charsSent, error: validationError };
        }
        const message = errorMessage(error);
        logger.warn(
          `[InputText] append key event failed after ${charsSent} char(s): ${message}`,
          error,
        );
        // An adb timeout kills the host child but cannot establish whether Android
        // accepted the current key event. Reporting the earlier prefix as an exact
        // retry boundary would let a caller duplicate this ambiguous character.
        return {
          ...(error instanceof AdbCommandTimeoutError ? {} : { charsSent }),
          error: `append key event failed: ${message}`,
        };
      }
      charsSent += 1;
    }
    return { charsSent };
  }

  /**
   * Dismiss the soft keyboard through the confirmed `Keyboard.close()` route
   * (KEYCODE_BACK + state-confirmation poll), returning an error message when the
   * dismissal could not be confirmed, else null.
   *
   * Every Android mode routes `dismissKeyboard:true` here rather than through the
   * runner-side `SHOW_MODE_HIDDEN`: that flag suppresses the a11y service from
   * *re-showing* the keyboard but does not dismiss an already-visible IME window,
   * leaving `SoftInputWindow` foregrounded after the call (issue #5887). setText is
   * issued WITHOUT the runner flag so the IME stays genuinely visible until the
   * closer dismisses it — otherwise the closer could decide to send Back off a
   * cached "IME open" tree after the runner had already hidden the window,
   * navigating the app instead. The closer detects the current keyboard state
   * first, so when the keyboard is already closed it short-circuits without a Back.
   *
   * @param method - The input mode label, used in the failure message.
   */
  private async dismissKeyboardViaCloser(
    method: InputTextMode,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const keyboardResult = await this.keyboardCloserFactory(this.device, this.adbFactory).close(
      signal,
    );
    assertInputNotAborted(signal);
    if (keyboardResult.success) {
      return null;
    }
    const cause = keyboardResult.error ?? keyboardResult.message ?? "unknown error";
    return `${method} input completed but keyboard dismissal failed: ${cause}`;
  }

  /**
   * Turn `timeoutMs` into a remaining-budget reader.
   *
   * `undefined` means unbounded, which is what a caller that owns its own lifetime
   * gets; every bounded caller shares one deadline across the whole append so N
   * subprocesses cannot each consume the full budget.
   */
  private createBudget(timeoutMs: number | undefined): () => number | undefined {
    if (timeoutMs === undefined) {
      return () => undefined;
    }
    const deadline = this.timer.now() + timeoutMs;
    return () => deadline - this.timer.now();
  }

  private appendBudgetExceeded(timeoutMs: number | undefined, phase: string): string {
    return `append exceeded its ${timeoutMs}ms budget while ${phase}`;
  }

  private appendFailure(
    text: string,
    error: string,
    charsSent?: number,
  ): SendTextResult & { method?: InputTextMode } {
    return {
      success: false,
      text,
      error,
      method: "append",
      ...(charsSent !== undefined ? { charsSent } : {}),
    };
  }

  private async executeAndroidEventOnlyTextInput(
    text: string,
    imeAction: ImeAction | undefined,
    dismissKeyboard: boolean,
    previousObserveResult?: ObserveResult,
    signal?: AbortSignal,
  ): Promise<SendTextResult & { method?: InputTextMode }> {
    assertInputNotAborted(signal);
    const keyEventPlans: KeyEventPlan[] = [];
    for (const char of Array.from(text)) {
      const keyEventPlan = await this.getAsciiKeyEventPlan(char, undefined, signal);
      if (!keyEventPlan) {
        return {
          success: false,
          text,
          error: `eventOnly cannot type ${JSON.stringify(char)} with Android key events`,
          method: "eventOnly",
        };
      }
      keyEventPlans.push(keyEventPlan);
    }

    const viewHierarchy = previousObserveResult?.viewHierarchy;
    if (!viewHierarchy) {
      return {
        success: false,
        text,
        error: "eventOnly requires a current view hierarchy to clear the focused field",
        method: "eventOnly",
      };
    }

    const focusedViewHierarchy = await this.refreshFocusedTextInputHierarchy(viewHierarchy, signal);
    if (!focusedViewHierarchy) {
      return {
        success: false,
        text,
        error: "eventOnly requires a focused editable field",
        method: "eventOnly",
      };
    }

    await clearTextWithKeyEvents(this.adb, getFocusedTextLength(focusedViewHierarchy), signal);
    for (const keyEventPlan of keyEventPlans) {
      await this.executeKeyEventPlan(keyEventPlan, undefined, false, undefined, signal);
    }

    // IME action before dismiss — see the a11y path for why (issue #5887).
    if (imeAction) {
      await this.executeImeAction(imeAction, signal);
    }

    if (dismissKeyboard) {
      const dismissError = await this.dismissKeyboardViaCloser("eventOnly", signal);
      if (dismissError) {
        return {
          success: false,
          text,
          error: dismissError,
          method: "eventOnly",
        };
      }
    }

    return {
      success: true,
      text,
      imeAction,
      method: "eventOnly",
    };
  }

  private async refreshFocusedTextInputHierarchy(
    viewHierarchy: ViewHierarchyResult,
    signal?: AbortSignal,
  ): Promise<ViewHierarchyResult | undefined> {
    assertInputNotAborted(signal);
    if (hasFocusedTextInput(viewHierarchy)) {
      return viewHierarchy;
    }

    // Android interprets `minTimestamp` in the device-authored hierarchy clock
    // domain. When the failed hierarchy carries an `updatedAt` we derive the
    // lower bound from it (device clock, +1 for strictly-newer). When it does
    // NOT, we must still stay in the device domain: falling back to the host
    // clock (`this.timer.now()`) lets a device clock running ahead of the host
    // accept an older cached focused hierarchy as fresh, defeating the freshness
    // guarantee (issue #4617). Derive the fallback from the device clock via
    // `getDeviceTimestampMsWithSource`, and reject degraded host-clock results.
    let minTimestamp: number;
    if (typeof viewHierarchy.updatedAt === "number") {
      minTimestamp = viewHierarchy.updatedAt + 1;
    } else {
      const timestampResult = await this.adb.getDeviceTimestampMsWithSource();
      assertInputNotAborted(signal);
      if (timestampResult.source === "host") {
        return undefined;
      }
      minTimestamp =
        timestampResult.source === "device-seconds"
          ? timestampResult.timestampMs + DEVICE_TIMESTAMP_SECOND_GRANULARITY_MARGIN_MS
          : timestampResult.timestampMs;
    }
    const refreshedObserveResult = await this.observeScreen.execute({
      skipWaitForFresh: false,
      minTimestamp,
      signal,
    });
    assertInputNotAborted(signal);
    const refreshedViewHierarchy = refreshedObserveResult.viewHierarchy;
    return refreshedObserveResult.freshness?.isFresh !== false &&
      refreshedViewHierarchy &&
      hasFocusedTextInput(refreshedViewHierarchy)
      ? refreshedViewHierarchy
      : undefined;
  }

  /**
   * Build a uniform failure result for an accessibility setText call that failed
   * partway through an event-mode input sequence.
   * @param text - The full text the caller was attempting to input
   * @param stage - Short label for which setText call failed (used in the warning log)
   * @param phase - Where in the sequence it failed, e.g. "before real key event"
   * @param cause - The underlying setText error
   * @param method - The input mode that was in effect
   */
  private setTextFailure(
    text: string,
    stage: string,
    phase: string,
    cause: string | undefined,
    method: InputTextMode,
  ): SendTextResult & { method?: InputTextMode } {
    logger.warn(`[InputText] ${stage} setText failed: ${cause}`);
    return {
      success: false,
      text,
      error: `Accessibility service setText failed ${phase}: ${cause}`,
      method,
    };
  }

  private findLastPrintableAsciiNonWhitespace(
    text: string,
  ): { index: number; char: string } | null {
    for (let index = text.length - 1; index >= 0; index--) {
      const char = text[index];
      if (!char) {
        continue;
      }

      const code = char.charCodeAt(0);
      if (code >= 0x21 && code <= 0x7e && !/\s/.test(char)) {
        return { index, char };
      }
    }

    return null;
  }

  private async hasAsciiKeyEventPlan(chars: string[], signal?: AbortSignal): Promise<boolean> {
    for (const char of chars) {
      if (await this.getAsciiKeyEventPlan(char, undefined, signal)) {
        return true;
      }
    }

    return false;
  }

  private async getAsciiKeyEventPlan(
    char: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<KeyEventPlan | null> {
    assertInputNotAborted(signal);
    const supported = await this.supportsAndroidInputKeyCombination(timeoutMs, signal);
    assertInputNotAborted(signal);
    return buildAsciiKeyEventPlan(char, supported);
  }

  private async supportsAndroidInputKeyCombination(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    assertInputNotAborted(signal);
    if (this.androidInputKeyCombinationSupported !== undefined) {
      return this.androidInputKeyCombinationSupported;
    }

    const apiLevel = await readAndroidDeviceApiLevel(this.adb, timeoutMs, this.timer);
    assertInputNotAborted(signal);
    if (apiLevel === null) {
      // Unknown is not "unsupported": a transient probe failure (or the caller's
      // budget expiring mid-probe) must not permanently disable SHIFT chords for
      // this instance — which now outlives a single request (the daemon caches
      // InputText per device). Answer conservatively but leave the cache empty
      // so the next call re-probes.
      return false;
    }
    this.androidInputKeyCombinationSupported = apiLevel >= ANDROID_KEYCOMBINATION_MIN_API_LEVEL;
    return this.androidInputKeyCombinationSupported;
  }

  private async executeKeyEventPlan(
    plan: KeyEventPlan,
    timeoutMs?: number,
    noRetry: boolean = false,
    beforeDispatch?: (remainingTimeoutMs?: number) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const [index, command] of plan.commands.entries()) {
      assertInputNotAborted(signal);
      await this.adb.execute(command.split(" "), {
        timeoutMs,
        noRetry,
        beforeDispatch: index === 0 ? beforeDispatch : undefined,
        signal,
      });
      assertInputNotAborted(signal);
    }
  }

  /**
   * Execute iOS-specific text input
   * @param text - Text to input
   * @param imeAction - Optional IME action
   * @returns Result with method information
   */
  private async executeiOSTextInput(
    text: string,
    imeAction?: ImeAction,
    signal?: AbortSignal,
  ): Promise<SendTextResult & { method?: "a11y" }> {
    assertInputNotAborted(signal);
    const startMs = Date.now();
    logger.debug(
      `[InputText] iOS begin textLength=${text.length} imeAction=${imeAction ?? "none"}`,
    );

    const client = IOSCtrlProxyClient.getInstance(this.device);
    const result = await client.requestSetText(text);
    assertInputNotAborted(signal);

    if (!result.success) {
      logger.error(
        `[InputText] CtrlProxy iOS setText failed: ${result.error} totalMs=${Date.now() - startMs}`,
      );
      return {
        success: false,
        text,
        error: result.error,
        method: "a11y",
      };
    }

    logger.debug(`[InputText] iOS setText ok totalMs=${Date.now() - startMs}`);

    // Handle IME action if specified (CtrlProxy iOS supports this)
    if (imeAction) {
      const imeResult = await client.requestImeAction(imeAction);
      assertInputNotAborted(signal);
      if (!imeResult.success) {
        logger.warn(`[InputText] CtrlProxy iOS IME action failed: ${imeResult.error}`);
      }
    }

    return {
      success: true,
      text,
      imeAction,
      method: "a11y",
    };
  }

  private async executeImeAction(imeAction: string, signal?: AbortSignal): Promise<void> {
    // Map IME actions to Android key codes
    const imeKeyCodeMap: { [key: string]: string } = {
      done: "KEYCODE_ENTER",
      next: "KEYCODE_TAB",
      search: "KEYCODE_SEARCH",
      send: "KEYCODE_ENTER",
      go: "KEYCODE_ENTER",
      previous: "KEYCODE_SHIFT_LEFT KEYCODE_TAB", // Shift+Tab for previous
    };

    const keyCode = imeKeyCodeMap[imeAction];
    if (keyCode) {
      // Small delay to ensure text input is processed
      assertInputNotAborted(signal);
      await this.timer.sleep(100);
      assertInputNotAborted(signal);

      // Execute the key event(s)
      if (keyCode.includes(" ")) {
        // Handle multiple key combinations like Shift+Tab
        const keys = keyCode.split(" ");
        for (const key of keys) {
          assertInputNotAborted(signal);
          await this.adb.executeCommand(`shell input keyevent ${key}`);
          assertInputNotAborted(signal);
        }
      } else {
        await this.adb.executeCommand(`shell input keyevent ${keyCode}`);
        assertInputNotAborted(signal);
      }
    }
  }
}
