import type { TypingSession } from "./TypingSession";
import { ANDROID_TYPE_FOCUSED_INPUT_ERROR } from "./AndroidTypingConstants";
import type { AndroidModeTyper, AndroidModeTypeRequest } from "./AndroidModeTyper";
import type {
  SendKeysTextClient,
  SendKeysOperation,
  TextActionResult,
  ResolvedSendKeysTypingMode,
} from "../SendKeys";
import type { ObserveResult } from "../../../models";
import type { InsertTextState } from "../../observe/android/ctrlProxyProtocol";
import type { KeyEventPlan } from "../../../utils/android-cmdline-tools/asciiKeyEvents";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import { awaitWhileRequestIsLive } from "../../../utils/toolUtils";
import { CARET_UNKNOWN_WARNING } from "./AndroidTypingConstants";
import { readBackWithSettle } from "./readBackWithSettle";
/** Field text and collapsed caret expected after the eventLast prefix insert (UTF-16 units). */
interface EventLastCaretExpectation {
  text: string;
  caret: number;
}
export interface EventLastTyperHost {
  session: TypingSession;
  preExistingFieldText(
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
    operation: SendKeysOperation,
  ): string;
  markPartialAfterMutation(result: TextActionResult): TextActionResult;
  textClient: Pick<SendKeysTextClient, "replace" | "readInsertTextState">;
  timer: Timer;
  resetCaretState(): void;
  insertText(
    text: string,
    options?: Parameters<SendKeysTextClient["insert"]>[1],
    signal?: AbortSignal,
  ): Promise<TextActionResult>;
  requireFocusedAndroidInput(
    signal?: AbortSignal,
    error?: string,
    display?: string,
  ): Promise<
    | { success: true; hierarchy: NonNullable<ObserveResult["viewHierarchy"]> }
    | { success: false; error: string }
  >;
  readPrecedingState(needed: boolean): Promise<InsertTextState | undefined>;
  executeKeyEventPlanSafely(
    plan: KeyEventPlan,
    previouslyMutated: boolean,
    signal?: AbortSignal,
  ): Promise<TextActionResult | undefined>;
  withTextWarnings(result: TextActionResult, warnings: Array<string | undefined>): TextActionResult;
  verifyKeyEventLetterCase(
    text: string,
    typed: TextActionResult,
    mode: "eventAll" | "eventOnly" | "eventLast",
    signal?: AbortSignal,
    display?: string,
    before?: string,
  ): Promise<TextActionResult>;
  checkAbort(signal?: AbortSignal, error?: unknown): void;
  getKeyEventPlan(char: string, signal?: AbortSignal): Promise<KeyEventPlan | null>;
  clearForReplace(
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<{ result: TextActionResult; unchangedWarning?: string }>;
}
export class EventLastTyper implements AndroidModeTyper {
  constructor(private readonly host: EventLastTyperHost) {}
  type({
    text,
    operation,
    signal,
    display,
  }: AndroidModeTypeRequest): Promise<
    TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }
  > {
    return this.executeAndroidEventLast(text, operation, signal, display);
  }

  private async executeAndroidEventLast(
    text: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const chars = Array.from(text);
    const split = await this.findLastKeyEvent(chars, signal);
    if (!split) {
      const result =
        operation === "replace"
          ? await this.host.textClient.replace(text)
          : await this.host.insertText(text, undefined, signal);
      return { ...result, resolvedMode: "a11y" };
    }

    if (this.host.session.androidCaretUnsafe) {
      return {
        success: false,
        error:
          "eventLast requires a real tail key event, but a previous insert could not place the caret; text was not sent",
      };
    }
    const focusResult = await this.host.requireFocusedAndroidInput(
      signal,
      ANDROID_TYPE_FOCUSED_INPUT_ERROR,
      display,
    );
    if (!focusResult.success) {
      return focusResult;
    }

    // Pre-existing text must not satisfy the case read-back for the newly inserted region.
    const beforeText = this.host.preExistingFieldText(focusResult.hierarchy, operation);
    const prefix = chars.slice(0, split.index).join("");
    const suffix = chars.slice(split.index + 1).join("");
    const initialResult = await this.insertEventLastPrefix(prefix, operation, signal, display);
    if (!initialResult.success) {
      return initialResult;
    }
    const precedingState = await this.host.readPrecedingState(suffix.length > 0);
    const eventFailure = await this.host.executeKeyEventPlanSafely(
      split.plan,
      operation === "replace" || prefix.length > 0,
      signal,
    );
    if (eventFailure) {
      return this.host.withTextWarnings(eventFailure, [initialResult.warning]);
    }
    let suffixResult: TextActionResult;
    try {
      suffixResult = suffix
        ? await this.host.insertText(
            suffix,
            {
              expectedSuffix: chars[split.index],
              ...(precedingState ? { precedingState } : {}),
            },
            signal,
          )
        : { success: true };
    } catch (error) {
      logger.warn("[SendKeys] eventLast suffix insertion failed", error);
      return this.host.withTextWarnings(
        { success: false, partialApplication: true, error: errorMessage(error) },
        [initialResult.warning],
      );
    }
    const verified = await this.host.verifyKeyEventLetterCase(
      text,
      this.host.markPartialAfterMutation(suffixResult),
      "eventLast",
      signal,
      display,
      beforeText,
    );
    return this.host.withTextWarnings(verified, [initialResult.warning]);
  }

  private async insertEventLastPrefix(
    prefix: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    // The expectation needs the field as it was BEFORE the insert, so it is read up front.
    const expected = await this.expectEventLastCaret(prefix, operation, signal);
    return this.confirmEventLastCaret(
      await this.prepareEventLastPrefix(prefix, operation, signal, display),
      expected,
      signal,
    );
  }

  private async expectEventLastCaret(
    prefix: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
  ): Promise<EventLastCaretExpectation | undefined> {
    if (operation === "replace") {
      return { text: prefix, caret: prefix.length };
    }
    if (!prefix || !this.host.textClient.readInsertTextState) {
      return undefined;
    }
    try {
      const before = await this.readInsertTextStateWhileLive(signal);
      const expected = before && expectedStateAfterInsert(before, prefix);
      if (!expected) {
        logger.warn(
          `[SendKeys] eventLast cannot prove the caret: pre-insert state is ${describeInsertState(before)}`,
        );
      }
      return expected;
    } catch (error) {
      this.host.checkAbort(signal, error);
      logger.warn(
        `[SendKeys] eventLast pre-insert read unavailable: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  /** The client read takes no signal; stop waiting on a cancelled call (the read may finish later). */
  private async readInsertTextStateWhileLive(
    signal?: AbortSignal,
  ): Promise<InsertTextState | undefined> {
    const read = this.host.textClient.readInsertTextState?.();
    return read && (await awaitWhileRequestIsLive(read, signal));
  }

  /** Turn a `caretPlaced: false` prefix result into a failure unless the caret is proven (#9887). */
  private async confirmEventLastCaret(
    result: TextActionResult,
    expected: EventLastCaretExpectation | undefined,
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    if (!result.success || result.caretPlaced !== false) {
      return result;
    }
    // Compose fields report "not placed" even when the caret sits after the prefix.
    if (!expected || !(await this.isCaretProvenAfterPrefix(expected, signal))) {
      return this.host.markPartialAfterMutation({
        ...result,
        success: false,
        error:
          "eventLast requires a real tail key event, but the prefix insert could not place the caret; remaining text was not sent",
      });
    }
    this.host.resetCaretState();
    return this.withoutCaretUnknownWarning(result);
  }

  /** Read the insert state back (bounded) and require exactly the expected text and caret. */
  private isCaretProvenAfterPrefix(
    expected: EventLastCaretExpectation,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return readBackWithSettle(
      () => this.readInsertTextStateWhileLive(signal),
      (state) => !!state && stateMatchesExpectation(state, expected),
      {
        timer: this.host.timer,
        finish: (_state, accepted) => accepted,
        beforeRead: () => this.host.checkAbort(signal),
        onReadError: (error) => {
          this.host.checkAbort(signal, error);
          logger.warn(
            `[SendKeys] eventLast caret read-back unavailable: ${errorMessage(error)}`,
            error,
          );
        },
      },
    );
  }

  private withoutCaretUnknownWarning(result: TextActionResult): TextActionResult {
    const { warning, ...rest } = result;
    const remaining = warning?.replace(CARET_UNKNOWN_WARNING, "").trim();
    return { ...rest, ...(remaining ? { warning: remaining } : {}) };
  }

  private async findLastKeyEvent(
    chars: string[],
    signal?: AbortSignal,
  ): Promise<{ index: number; plan: KeyEventPlan } | undefined> {
    for (let index = chars.length - 1; index >= 0; index--) {
      const char = chars[index];
      if (!char || /\s/.test(char)) {
        continue;
      }
      const plan = await this.host.getKeyEventPlan(char, signal);
      if (plan) {
        return { index, plan };
      }
    }
    return undefined;
  }

  private async prepareEventLastPrefix(
    prefix: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    if (operation === "replace") {
      // A bare tail key event follows an empty prefix, so the clear must be visible first (#9940).
      if (prefix) {
        return await this.host.textClient.replace(prefix);
      }
      const { result, unchangedWarning } = await this.host.clearForReplace(
        operation,
        signal,
        display,
      );
      return this.host.withTextWarnings(result, [unchangedWarning]);
    }
    return prefix ? this.host.insertText(prefix, undefined, signal) : { success: true };
  }
}
/** Where the prefix insert leaves the field, from the state read before it; undefined if unprovable. */
function expectedStateAfterInsert(
  before: InsertTextState,
  prefix: string,
): EventLastCaretExpectation | undefined {
  // A hint is placeholder text, not content, and an empty Compose field reports no text and an
  // unset (-1/-1) selection: either way the field is empty with the caret at 0 (#9948). Any
  // selection on empty text is meaningless; the insert lands at 0.
  const text = before.isShowingHintText ? "" : (before.text ?? "");
  const emptyField = text.length === 0;
  const start = emptyField ? 0 : Math.min(before.selectionStart, before.selectionEnd);
  const end = emptyField ? 0 : Math.max(before.selectionStart, before.selectionEnd);
  if (start < 0 || end > text.length) {
    return undefined;
  }
  return { text: text.slice(0, start) + prefix + text.slice(end), caret: start + prefix.length };
}

function describeInsertState(state: InsertTextState | undefined): string {
  return state
    ? `text length ${state.text?.length ?? "none"}, hint ${state.isShowingHintText}, selection ${state.selectionStart}/${state.selectionEnd}`
    : "unreadable";
}

function stateMatchesExpectation(
  state: InsertTextState,
  expected: EventLastCaretExpectation,
): boolean {
  return (
    !state.isShowingHintText &&
    state.text === expected.text &&
    state.selectionStart === expected.caret &&
    state.selectionEnd === expected.caret
  );
}
