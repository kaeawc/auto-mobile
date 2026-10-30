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
  buildAndroidInputTextPlan,
  splitAndroidInputText,
  canJoinAndroidInputText,
} from "../../../utils/android-cmdline-tools/asciiKeyEvents";

import { readBackWithSettle } from "./readBackWithSettle";
import { ANDROID_KEYCOMBINATION_MIN_API_LEVEL } from "../../../utils/android-cmdline-tools/asciiKeyEvents";
import type { Timer } from "../../../utils/SystemTimer";
import { passwordTextPlaceholder } from "../imeFailureDiagnostics";
import type { KeyEventLetterCaseCheck } from "./KeyEventSupport";
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
  timer: Timer;
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
    check: KeyEventLetterCaseCheck,
  ): Promise<TextActionResult>;
  checkAbort(signal?: AbortSignal, error?: unknown): void;
  getEventAllKeyEventPlan(grapheme: string): Promise<KeyEventPlan | null>;
  getAndroidApiLevel(signal?: AbortSignal): Promise<number | null>;
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
    const outcome = { batchedKeyRun: false };
    const typed = await this.executeAndroidEventAllCharacters(
      graphemes,
      operation === "replace",
      operation === "replace",
      outcome,
      signal,
    );
    if (!typed.success) {
      return typed;
    }
    const confirmed = unchangedWarning
      ? await this.confirmReplaceAfterUnchangedClear(text, unchangedWarning, typed, signal, display)
      : typed;
    const caseChecked = await this.host.verifyKeyEventLetterCase(text, confirmed, {
      mode: "eventAll",
      signal,
      display,
    });
    return outcome.batchedKeyRun
      ? this.verifyPre31Delivery(graphemes, caseChecked, signal, display)
      : caseChecked;
  }

  /**
   * `adb shell input text` on API 30 and below drops characters under load and still exits 0
   * (#12733), so success from the dispatch proves nothing there. Read the focused field back and
   * fail as a partial application when the typed text is not in it. Case is ignored (the
   * letter-case check owns that), only batched `input text` runs are read (the API level is already
   * known there, so no extra adb call), an unreadable field stays a success, and API 31+ and password
   * fields are not read.
   */
  private async verifyPre31Delivery(
    graphemes: string[],
    typed: TextActionResult,
    signal?: AbortSignal,
    display?: string,
  ): Promise<TextActionResult> {
    if (!typed.success || this.host.session.typingPasswordField) {
      return typed;
    }
    const apiLevel = await this.host.getAndroidApiLevel(signal);
    if (apiLevel === null || apiLevel >= ANDROID_KEYCOMBINATION_MIN_API_LEVEL) {
      return typed;
    }
    const expected = graphemes.join("").toLowerCase();
    const field = await readBackWithSettle(
      async () => this.host.readFocusedText(await this.host.readFreshObservation(signal, display)),
      (value) => value === undefined || value.toLowerCase().includes(expected),
      {
        timer: this.host.timer,
        finish: (value, accepted) => (accepted ? undefined : value),
        beforeRead: () => this.host.checkAbort(signal),
        onReadError: (error) => {
          this.host.checkAbort(signal, error);
          logger.warn(
            `[SendKeys] eventAll delivery read-back unavailable: ${errorMessage(error)}`,
            error,
          );
        },
      },
    );
    if (field === undefined) {
      return typed;
    }
    const committedGraphemes = this.committedPrefixLength(graphemes, field.toLowerCase());
    const error = `eventAll typed ${graphemes.length} graphemes but the focused field does not contain them: ${committedGraphemes} leading graphemes arrived and the device dropped the rest (adb input text on API ${await this.host.getAndroidApiLevel(signal)} loses characters). Use mode "ime" or "a11y" for reliable delivery.`;
    logger.warn(`[SendKeys] ${error}`);
    return this.host.withTextWarnings(
      { success: false, error, committedGraphemes, partialApplication: true },
      typed.warning ? [typed.warning] : [],
    );
  }

  private committedPrefixLength(graphemes: string[], fieldLower: string): number {
    let prefix = "";
    let count = 0;
    for (const grapheme of graphemes) {
      prefix += grapheme.toLowerCase();
      if (!fieldLower.includes(prefix)) {
        break;
      }
      count++;
    }
    return count;
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
    outcome: { batchedKeyRun: boolean },
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
        const { failure: eventFailure, deliveredGraphemes } =
          await this.executeEventAllKeyRunSafely(run, plan, progress.mutated, signal);
        // Chunks that completed before a later one failed stay committed, so a retry from
        // committedGraphemes does not type them again.
        progress.committedGraphemes += deliveredGraphemes;
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
        outcome.batchedKeyRun ||= run.length > 1;
        progress.mutated = true;
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
  ): Promise<{ failure?: TextActionResult; deliveredGraphemes: number }> {
    if (run.length === 1) {
      const failure = await this.host.executeKeyEventPlanSafely(plan, previouslyMutated, signal);
      return failure ? { failure, deliveredGraphemes: 0 } : { deliveredGraphemes: 1 };
    }
    const apiLevel = await this.host.getAndroidApiLevel(signal);
    // One dispatch per chunk: a failure in a later chunk must not hide the finished ones.
    let deliveredGraphemes = 0;
    for (const chunk of splitAndroidInputText(run.join(""), apiLevel)) {
      // The process may have typed part of the chunk before failing, so any failure is partial.
      const failure = await this.host.executeKeyEventPlanSafely(
        buildAndroidInputTextPlan(chunk, apiLevel),
        true,
        signal,
      );
      if (failure) {
        return { failure, deliveredGraphemes };
      }
      deliveredGraphemes += chunk.length;
    }
    return { deliveredGraphemes };
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
