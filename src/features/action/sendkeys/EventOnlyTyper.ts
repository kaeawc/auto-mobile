import type { TypingSession } from "./TypingSession";
import type { AndroidModeTyper, AndroidModeTypeRequest } from "./AndroidModeTyper";
import type { SendKeysObserver, SendKeysOperation, TextActionResult } from "../SendKeys";
import type { KeyEventPlan } from "../../../utils/android-cmdline-tools/asciiKeyEvents";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { ObserveResult } from "../../../models";
import { clearTextWithKeyEvents, getFocusedTextLength, verifyKeyEventClear } from "../ClearText";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";

type InputHierarchy = NonNullable<ObserveResult["viewHierarchy"]>;
export interface EventOnlyTyperHost {
  session: TypingSession;
  adb: AdbExecutor;
  observer: Pick<SendKeysObserver, "execute">;
  getKeyEventPlan(char: string, signal?: AbortSignal): Promise<KeyEventPlan | null>;
  requireFocusedAndroidInput(
    signal?: AbortSignal,
    display?: string,
  ): Promise<{ success: true; hierarchy: InputHierarchy } | { success: false; error: string }>;
  executeKeyEventPlanSafely(
    plan: KeyEventPlan,
    mutated: boolean,
    signal?: AbortSignal,
  ): Promise<TextActionResult | undefined>;
  verifyKeyEventLetterCase(
    text: string,
    typed: TextActionResult,
    signal?: AbortSignal,
    display?: string,
    before?: string,
  ): Promise<TextActionResult>;
  supportsAndroidKeyCombination(signal?: AbortSignal): Promise<boolean>;
  preExistingFieldText(hierarchy: InputHierarchy, operation: SendKeysOperation): string;
  markPartialAfterMutation(result: TextActionResult): TextActionResult;
}

export class EventOnlyTyper implements AndroidModeTyper {
  constructor(private readonly host: EventOnlyTyperHost) {}

  async type({
    text,
    operation,
    signal,
    display,
  }: AndroidModeTypeRequest): Promise<TextActionResult> {
    const plans: KeyEventPlan[] = [];
    const chars = Array.from(text);
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index] ?? "";
      const plan = await this.host.getKeyEventPlan(char, signal);
      if (!plan) {
        return {
          success: false,
          error: `eventOnly cannot type the character at index ${index} with Android key events`,
        };
      }
      plans.push(plan);
    }

    const focusResult = await this.host.requireFocusedAndroidInput(signal, display);
    if (!focusResult.success) {
      return focusResult;
    }

    if (operation === "replace") {
      const textLength = getFocusedTextLength(focusResult.hierarchy, undefined, true);
      if (textLength === undefined) {
        return {
          success: false,
          error:
            "eventOnly replacement requires a known focused text length; use a11y replacement instead",
        };
      }
      const clearResult = await this.clearEventOnlyForReplace(textLength, signal, display);
      if (!clearResult.success) {
        return clearResult;
      }
    }

    // Pre-existing text must not satisfy the case read-back for the newly inserted region.
    const beforeText = this.host.preExistingFieldText(focusResult.hierarchy, operation);
    let mutated = operation === "replace";
    if (this.host.session.androidCaretUnsafe) {
      return {
        success: false,
        error: "eventOnly requires a known caret; use eventAll insertion or move the caret first",
      };
    }
    for (const plan of plans) {
      const eventFailure = await this.host.executeKeyEventPlanSafely(plan, mutated, signal);
      if (eventFailure) {
        return eventFailure;
      }
      mutated = true;
    }
    return this.host.verifyKeyEventLetterCase(text, { success: true }, signal, display, beforeText);
  }

  async clearEventOnlyForReplace(
    count: number,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    let deleted = false;
    try {
      const supportsKeyCombination = await this.host.supportsAndroidKeyCombination(signal);
      await clearTextWithKeyEvents(
        this.host.adb,
        count,
        signal,
        () => {
          deleted = true;
        },
        supportsKeyCombination,
      );
      const verification = await verifyKeyEventClear(
        () =>
          this.host.observer.execute({
            signal,
            freshness: "fresh",
            minTimestamp: 0,
            ...(display === undefined ? {} : { display }),
            skipScreenshot: true,
          }),
        signal,
      );
      return deleted ? this.host.markPartialAfterMutation(verification) : verification;
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn("[SendKeys] Android replacement clearing failed", error);
      const failure = { success: false, error: errorMessage(error) };
      return deleted ? this.host.markPartialAfterMutation(failure) : failure;
    }
  }
}
