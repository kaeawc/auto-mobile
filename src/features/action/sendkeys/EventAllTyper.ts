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
import { segmentGraphemes } from "./AndroidTypingConstants";
import {
  buildAndroidInputTextCommand,
  canJoinAndroidInputText,
} from "../../../utils/android-cmdline-tools/asciiKeyEvents";

import { passwordTextPlaceholder } from "../imeFailureDiagnostics";
interface AndroidEventAllProgress {
  mutated: boolean;
  committedGraphemes: number;
  pendingKeyText: string;
  precedingState?: InsertTextState;
  warnings: string[];
  lastInsert?: TextActionResult;
  sinceLastInsertEvents: boolean;
}
export interface EventAllTyperHost {
  session: TypingSession;
  hasFocusedPasswordField(hierarchy: NonNullable<ObserveResult["viewHierarchy"]>): boolean;
  graphemeCodePoints(graphemes: string[]): string;
  markPartialAfterPriorMutation(
    result: TextActionResult,
    previouslyMutated: boolean,
  ): TextActionResult;
  textClient: Pick<SendKeysTextClient, "replace">;
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
  getEventAllKeyEventPlan(grapheme: string): Promise<KeyEventPlan | null>;
  clearForReplace(
    operation: SendKeysOperation,
    signal?: AbortSignal,
    display?: string,
  ): Promise<{ result: TextActionResult; unchangedWarning?: string }>;
  readFocusedText(observation: ObserveResult): string | undefined;
  readFreshObservation(signal?: AbortSignal, display?: string): Promise<ObserveResult>;
}
export class EventAllTyper implements AndroidModeTyper {
  constructor(private readonly host: EventAllTyperHost) {}
  type({
    text,
    operation,
    signal,
    display,
    focusedInputVerified,
  }: AndroidModeTypeRequest): Promise<
    TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }
  > {
    return this.executeAndroidEventAll(text, operation, signal, focusedInputVerified, display);
  }

  private async executeAndroidEventAll(
    text: string,
    operation: SendKeysOperation,
    signal?: AbortSignal,
    focusedInputVerified = false,
    display?: string,
  ): Promise<TextActionResult & { resolvedMode?: ResolvedSendKeysTypingMode }> {
    const graphemes = segmentGraphemes(text);
    if (this.host.session.androidCaretUnsafe || !(await this.hasAndroidKeyEvent(graphemes))) {
      const result =
        operation === "replace"
          ? await this.host.textClient.replace(text)
          : await this.insertGraphemeRun(graphemes, 0, false, undefined, signal);
      return { ...result, resolvedMode: "a11y" };
    }

    if (!focusedInputVerified) {
      const focusResult = await this.host.requireFocusedAndroidInput(
        signal,
        ANDROID_TYPE_FOCUSED_INPUT_ERROR,
        display,
      );
      if (!focusResult.success) {
        return focusResult;
      }
      // An explicit eventAll skips auto routing's password check; keep a password's text out of
      // batched adb command lines and error messages all the same.
      this.host.session.typingPasswordField ||
        (this.host.session.typingPasswordField = this.host.hasFocusedPasswordField(
          focusResult.hierarchy,
        ));
    }

    const { result: clearResult, unchangedWarning } = await this.host.clearForReplace(
      operation,
      signal,
      display,
    );
    if (!clearResult.success) {
      return clearResult;
    }
    const typed = await this.executeAndroidEventAllCharacters(
      graphemes,
      operation === "replace",
      operation === "replace",
      signal,
    );
    if (!typed.success) {
      return typed;
    }
    const confirmed = unchangedWarning
      ? await this.confirmReplaceAfterUnchangedClear(text, unchangedWarning, typed, signal, display)
      : typed;
    return this.host.verifyKeyEventLetterCase(text, confirmed, "eventAll", signal, display);
  }

  /**
   * The replace's clear left the pre-clear text showing, so the typed text may have landed after
   * it: old text + new text. One read after typing: a field that now equals the requested text
   * was just slow to apply the clear; anything else keeps the unchanged-clear warning, naming the
   * field content. A permanent prefix or mask legitimately gives "prefix + text", which cannot be
   * told from a refused clear by text alone, so this stays a warning rather than a failure.
   */
  private async confirmReplaceAfterUnchangedClear(
    text: string,
    unchangedWarning: string,
    typed: TextActionResult,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    let field: string | undefined;
    try {
      field = this.host.readFocusedText(await this.host.readFreshObservation(signal, display));
    } catch (error) {
      this.host.checkAbort(signal, error);
      logger.warn(`[SendKeys] Replace read-back unavailable: ${errorMessage(error)}`, error);
    }
    if (field === text) {
      return typed;
    }
    const observed =
      field === undefined
        ? "The field could not be read after typing."
        : `After typing, the field holds ${JSON.stringify(field)}, not just the requested text: it is either a permanent prefix or mask, or the field refused the clear and now contains both the old and the new text.`;
    return this.host.withTextWarnings(typed, [`${unchangedWarning} ${observed}`]);
  }

  private async executeAndroidEventAllCharacters(
    graphemes: string[],
    previouslyMutated: boolean,
    replacing: boolean,
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    const progress: AndroidEventAllProgress = {
      mutated: previouslyMutated,
      committedGraphemes: 0,
      pendingKeyText: "",
      warnings: [],
      sinceLastInsertEvents: false,
    };
    for (let index = 0; index < graphemes.length; index++) {
      signal?.throwIfAborted();
      const plan = await this.host.getEventAllKeyEventPlan(graphemes[index] ?? "");
      if (plan) {
        await this.captureEventAllBaseline(graphemes, index, progress);
        const run = graphemes.slice(
          index,
          (await this.eventAllKeyEventRunEnd(graphemes, index)) + 1,
        );
        const eventFailure = await this.executeEventAllKeyRunSafely(
          run,
          plan,
          progress.mutated,
          signal,
        );
        if (eventFailure) {
          return this.host.withTextWarnings(
            {
              ...eventFailure,
              error: `eventAll could not deliver grapheme${run.length > 1 ? "s" : ""} ${this.describeGraphemes(run)}: ${eventFailure.error ?? "unknown error"}`,
              committedGraphemes: progress.committedGraphemes,
            },
            progress.warnings,
          );
        }
        progress.mutated = true;
        progress.committedGraphemes += run.length;
        progress.pendingKeyText += run.join("");
        progress.sinceLastInsertEvents = true;
        index += run.length - 1;
        continue;
      }
      const runStart = index;
      index = await this.eventAllInsertRunEnd(graphemes, index);
      const insertResult = await this.insertEventAllRun(
        graphemes.slice(runStart, index + 1),
        progress,
        signal,
      );
      if (!insertResult.success) {
        return insertResult;
      }
      // An unknown caret prohibits further key events until an explicit caret reset.
      if (insertResult.caretPlaced === false) {
        const remainder = await this.insertEventAllRemainder(
          graphemes.slice(index + 1),
          progress,
          signal,
        );
        if (!remainder.success) {
          return remainder;
        }
        break;
      }
    }
    return this.finishEventAll(graphemes, replacing, progress);
  }

  private async captureEventAllBaseline(
    graphemes: string[],
    index: number,
    progress: AndroidEventAllProgress,
  ): Promise<void> {
    if (progress.pendingKeyText) {
      return;
    }
    // Each run gets its own pre-dispatch snapshot, including runs after a service insert.
    progress.precedingState = await this.host.readPrecedingState(
      await this.hasFollowingEventAllInsert(graphemes, index),
    );
  }

  private async hasFollowingEventAllInsert(graphemes: string[], index: number): Promise<boolean> {
    for (const grapheme of graphemes.slice(index + 1)) {
      if (!(await this.host.getEventAllKeyEventPlan(grapheme))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Last index of the key-event run starting at `index`. Consecutive printable ASCII goes to
   * the device in one `input text` process: one process per character let the keyboard
   * re-capitalise letters after a space (#9888). A password field keeps one key event per
   * character, so its text never appears in a single adb command line, log or error.
   */
  private async eventAllKeyEventRunEnd(graphemes: string[], index: number): Promise<number> {
    if (this.host.session.typingPasswordField) {
      return index;
    }
    while (
      index + 1 < graphemes.length &&
      canJoinAndroidInputText(graphemes[index] ?? "", graphemes[index + 1] ?? "") &&
      (await this.host.getEventAllKeyEventPlan(graphemes[index + 1] ?? ""))
    ) {
      index++;
    }
    return index;
  }

  private async executeEventAllKeyRunSafely(
    run: string[],
    plan: KeyEventPlan,
    previouslyMutated: boolean,
    signal?: AbortSignal,
  ): Promise<TextActionResult | undefined> {
    if (run.length === 1) {
      return this.host.executeKeyEventPlanSafely(plan, previouslyMutated, signal);
    }
    // The process may have typed part of the run before failing, so any failure is partial.
    return this.host.executeKeyEventPlanSafely(
      { commands: [buildAndroidInputTextCommand(run.join(""))], textLength: run.join("").length },
      true,
      signal,
    );
  }

  private async eventAllInsertRunEnd(graphemes: string[], index: number): Promise<number> {
    while (
      index + 1 < graphemes.length &&
      !(await this.host.getEventAllKeyEventPlan(graphemes[index + 1] ?? ""))
    ) {
      index++;
    }
    return index;
  }

  private async insertEventAllRun(
    run: string[],
    progress: AndroidEventAllProgress,
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    const result = await this.insertGraphemeRun(
      run,
      progress.committedGraphemes,
      progress.mutated,
      progress.pendingKeyText
        ? {
            expectedSuffix: progress.pendingKeyText,
            ...(progress.precedingState ? { precedingState: progress.precedingState } : {}),
          }
        : undefined,
      signal,
    );
    if (result.success) {
      progress.mutated = true;
      progress.committedGraphemes += run.length;
      progress.pendingKeyText = "";
      progress.precedingState = undefined;
      progress.sinceLastInsertEvents = false;
      progress.lastInsert = result;
      if (result.warning) {
        progress.warnings.push(result.warning);
      }
    }
    return result.success ? result : this.host.withTextWarnings(result, progress.warnings);
  }

  private async insertEventAllRemainder(
    rest: string[],
    progress: AndroidEventAllProgress,
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    if (!rest.length) {
      return { success: true };
    }
    signal?.throwIfAborted();
    // insertEventAllRun reset pendingKeyText; the service supplies the remembered caret.
    return this.insertEventAllRun(rest, progress, signal);
  }

  private finishEventAll(
    graphemes: string[],
    replacing: boolean,
    progress: AndroidEventAllProgress,
  ): TextActionResult {
    // Planned length only: insert has an unknown prefix, and later key events are unobserved.
    // Old APKs omit the length. Other typing modes do not use this check.
    if (
      replacing &&
      !progress.sinceLastInsertEvents &&
      progress.lastInsert?.resultingTextLength !== undefined
    ) {
      const expected = graphemes.reduce((length, grapheme) => length + grapheme.length, 0);
      const actual = progress.lastInsert.resultingTextLength;
      if (actual !== expected) {
        progress.warnings.push(
          `eventAll finished with ${actual} UTF-16 units in the field, expected ${expected}; some input may have been lost or overwritten`,
        );
      }
    }
    return {
      success: true,
      ...(progress.warnings.length ? { warning: progress.warnings.join(" ") } : {}),
    };
  }

  private describeGraphemes(graphemes: string[]): string {
    return this.host.session.typingPasswordField
      ? passwordTextPlaceholder(graphemes.join(""))
      : this.host.graphemeCodePoints(graphemes);
  }

  private async insertGraphemeRun(
    run: string[],
    committedGraphemes: number,
    previouslyMutated: boolean,
    options?: Parameters<SendKeysTextClient["insert"]>[1],
    signal?: AbortSignal,
  ): Promise<TextActionResult> {
    const text = run.join("");
    const codePoints = this.describeGraphemes(run);
    try {
      const result = await this.host.insertText(text, options, signal);
      if (result.success) {
        return result;
      }
      logger.warn(`[SendKeys] Android text insertion failed: ${result.error ?? "unknown error"}`);
      return this.host.markPartialAfterPriorMutation(
        {
          ...result,
          error: `eventAll could not insert grapheme(s) ${codePoints}: ${result.error ?? "unknown error"}`,
          committedGraphemes,
        },
        previouslyMutated,
      );
    } catch (error) {
      logger.warn("[SendKeys] Android text insertion failed", error);
      return {
        success: false,
        error: `eventAll could not insert grapheme(s) ${codePoints}: ${errorMessage(error)}`,
        committedGraphemes,
        partialApplication: true,
      };
    }
  }

  private async hasAndroidKeyEvent(graphemes: string[]): Promise<boolean> {
    for (const grapheme of graphemes) {
      if (await this.host.getEventAllKeyEventPlan(grapheme)) {
        return true;
      }
    }
    return false;
  }
}
