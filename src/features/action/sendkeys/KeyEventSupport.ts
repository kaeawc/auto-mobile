import type { SendKeysOperation, SendKeysObserver, TextActionResult } from "../SendKeys";
import type { TypingSession } from "./TypingSession";
import type { ObserveResult } from "../../../models";
import type { HierarchyLayer } from "../../../models/HierarchyLayer";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../../utils/SystemTimer";
import {
  ANDROID_KEYCOMBINATION_MIN_API_LEVEL,
  asciiKeyEventNeedsKeyCombination,
  buildAsciiKeyEventPlan,
  type KeyEventPlan,
} from "../../../utils/android-cmdline-tools/asciiKeyEvents";
import { readAndroidDeviceApiLevel } from "../../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { executeAndroidInputText } from "../../../utils/android-cmdline-tools/AndroidInputText";
import { awaitWhileRequestIsLive } from "../../../utils/toolUtils";
import { toActionableError } from "../../../models/ActionableError";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import { hasFocusedTextInput } from "../ClearText";
import {
  ANDROID_READ_BACK_ATTEMPTS,
  IME_COMMIT_READ_BACK_SETTLE_MS,
  KEY_EVENT_FORMAT_MARKERS,
  ANDROID_FOCUSED_INPUT_ERROR,
  ANDROID_TYPE_FOCUSED_INPUT_ERROR,
  isPrintableAscii,
} from "./AndroidTypingConstants";

export interface KeyEventSupportHost {
  adb: AdbExecutor;
  timer: Timer;
  session: TypingSession;
  observer: Pick<SendKeysObserver, "execute">;
  getTargetLayer(): HierarchyLayer | undefined;
  getKeyEventPlan(char: string, signal?: AbortSignal): Promise<KeyEventPlan | null>;
  supportsAndroidKeyCombination(signal?: AbortSignal): Promise<boolean>;
  getAndroidApiLevel(signal?: AbortSignal): Promise<number | null>;
  executeKeyEventPlan(plan: KeyEventPlan, signal?: AbortSignal): Promise<void>;
  keyEventFailureMessage(error: unknown): string;
  readFocusedText(observation: ObserveResult): string | undefined;
  readFreshObservation(signal?: AbortSignal, display?: string): Promise<ObserveResult>;
  withTextWarnings(result: TextActionResult, warnings: Array<string | undefined>): TextActionResult;
  checkAbort(signal?: AbortSignal, error?: unknown): void;
  clearAndVerifyAndroid(
    signal?: AbortSignal,
    display?: string,
  ): Promise<{ result: TextActionResult; unchangedWarning?: string }>;
  markPartialAfterMutation(result: TextActionResult): TextActionResult;
}

export class KeyEventSupport {
  private androidApiLevel: Promise<number | null> | undefined;
  constructor(private readonly host: KeyEventSupportHost) {}

  async verifyKeyEventLetterCase(
    text: string,
    typed: TextActionResult,
    mode: "eventAll" | "eventOnly" | "eventLast",
    signal?: AbortSignal,
    display?: string,
    before = "",
  ): Promise<TextActionResult> {
    // A password's text and read-back must never reach a warning or log.
    if (
      !typed.success ||
      this.host.session.typingPasswordField ||
      text.toLowerCase() === text.toUpperCase()
    ) {
      return typed;
    }
    try {
      for (let attempt = 0; attempt < ANDROID_READ_BACK_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          await this.host.timer.sleep(IME_COMMIT_READ_BACK_SETTLE_MS);
        }
        const field = this.host.readFocusedText(
          await this.host.readFreshObservation(signal, display),
        );
        if (field === undefined || keyEventLetterCase(field, text, before) !== "changed") {
          return typed;
        }
        if (attempt === ANDROID_READ_BACK_ATTEMPTS - 1) {
          // The app may intend the other case (all-caps, auto-capitalise). The text was typed,
          // so stay successful: a failed result invites a retry that would duplicate it.
          const warning = `${mode} typed ${JSON.stringify(text)} but the focused field holds ${JSON.stringify(field)}: the keyboard or field changed the letter case (possibly intended). Use mode "ime" or "a11y" for exact case.`;
          logger.warn(`[SendKeys] ${warning}`);
          return this.host.withTextWarnings(typed, [warning]);
        }
      }
    } catch (error) {
      this.host.checkAbort(signal, error);
      logger.warn(`[SendKeys] ${mode} case read-back unavailable: ${errorMessage(error)}`, error);
    }
    return typed;
  }

  async executeKeyEventPlanSafely(
    plan: KeyEventPlan,
    previouslyMutated: boolean,
    signal?: AbortSignal,
  ): Promise<TextActionResult | undefined> {
    try {
      await this.host.executeKeyEventPlan(plan, signal);
      return undefined;
    } catch (error) {
      signal?.throwIfAborted();
      const failure = { success: false, error: this.host.keyEventFailureMessage(error) };
      return previouslyMutated ? this.host.markPartialAfterMutation(failure) : failure;
    }
  }

  keyEventFailureMessage(error: unknown): string {
    if (!this.host.session.typingPasswordField) {
      logger.warn("[SendKeys] Android key event dispatch failed", error);
      return errorMessage(error);
    }
    const kind = error instanceof Error ? error.name : typeof error;
    const message = `Android key event dispatch failed for a password field (${kind}; details withheld)`;
    logger.warn(`[SendKeys] ${message}`);
    return message;
  }

  async clearForReplace(
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<{ result: TextActionResult; unchangedWarning?: string }> {
    if (operation !== "replace") {
      return { result: { success: true } };
    }
    return this.host.clearAndVerifyAndroid(signal, display);
  }

  async requireFocusedAndroidInput(
    signal?: AbortSignal,
    error: string = ANDROID_FOCUSED_INPUT_ERROR,
    display?: string,
  ): Promise<
    | { success: true; hierarchy: NonNullable<ObserveResult["viewHierarchy"]> }
    | { success: false; error: string }
  > {
    const observation = await this.host.observer.execute({
      signal,
      freshness: "fresh",
      ...(display === undefined ? {} : { display }),
      skipScreenshot: true,
    });
    const hierarchy = observation.viewHierarchy;
    if (this.host.getTargetLayer() === "prototype" && error === ANDROID_TYPE_FOCUSED_INPUT_ERROR) {
      return { success: true, hierarchy: hierarchy ?? { hierarchy: {} } };
    }
    if (!hierarchy || !hasFocusedTextInput(hierarchy)) {
      return {
        success: false,
        error,
      };
    }
    return { success: true, hierarchy };
  }

  async getEventAllKeyEventPlan(grapheme: string): Promise<KeyEventPlan | null> {
    return grapheme.length === 1 && isPrintableAscii(grapheme)
      ? this.host.getKeyEventPlan(grapheme)
      : null;
  }

  async getKeyEventPlan(char: string, signal?: AbortSignal): Promise<KeyEventPlan | null> {
    let supportsKeyCombination = false;
    if (asciiKeyEventNeedsKeyCombination(char)) {
      supportsKeyCombination = await this.host.supportsAndroidKeyCombination(signal);
    }
    return buildAsciiKeyEventPlan(char, supportsKeyCombination);
  }

  async supportsAndroidKeyCombination(signal?: AbortSignal): Promise<boolean> {
    const apiLevel = await this.host.getAndroidApiLevel(signal);
    return apiLevel !== null && apiLevel >= ANDROID_KEYCOMBINATION_MIN_API_LEVEL;
  }

  async getAndroidApiLevel(signal?: AbortSignal): Promise<number | null> {
    this.androidApiLevel ??= readAndroidDeviceApiLevel(this.host.adb, 1000, this.host.timer).catch(
      (error) => {
        // Unexpected probe rejection must allow the next request to retry.
        this.androidApiLevel = undefined;
        throw toActionableError(error, "Failed to read Android key-combination capability");
      },
    );
    return awaitWhileRequestIsLive(this.androidApiLevel, signal);
  }

  async executeKeyEventPlan(plan: KeyEventPlan, signal?: AbortSignal): Promise<void> {
    for (const command of plan.commands) {
      signal?.throwIfAborted();
      if (command.startsWith("shell input text ")) {
        await executeAndroidInputText(this.host.adb, this.host.timer, command, {
          signal,
          apiLevel: await this.host.getAndroidApiLevel(signal),
          textLength: plan.textLength ?? 1,
          ...(this.host.session.typingPasswordField
            ? { logLabel: "shell input <password key event>" }
            : {}),
        });
      } else if (this.host.session.typingPasswordField && command.startsWith("shell ")) {
        // The command names the key code typed; adb logs and errors show only the label.
        await this.host.adb.execute(["shell", command.slice("shell ".length)], {
          signal,
          logLabel: "shell input <password key event>",
        });
      } else {
        await this.host.adb.executeCommand(command, { signal });
      }
    }
  }
}

/**
 * Whether the field holds the typed text, holds it only in a different letter case, or neither.
 * Rich-text editors may consume formatting markers, so a marker-free view is compared too.
 */
function keyEventLetterCase(
  field: string,
  text: string,
  before = "",
): "exact" | "changed" | "other" {
  const occurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1;
  const strip = (value: string): string => value.replace(KEY_EVENT_FORMAT_MARKERS, "");
  const views = [
    { field, text, before },
    { field: strip(field), text: strip(text), before: strip(before) },
  ].filter((view) => view.text.length > 0);
  // A match that was already in the field before typing says nothing about the new region.
  const grew = (fold: (value: string) => string): boolean =>
    views.some(
      (view) =>
        occurrences(fold(view.field), fold(view.text)) >
        occurrences(fold(view.before), fold(view.text)),
    );
  if (grew((value) => value)) {
    return "exact";
  }
  return grew((value) => value.toLowerCase()) ? "changed" : "other";
}
