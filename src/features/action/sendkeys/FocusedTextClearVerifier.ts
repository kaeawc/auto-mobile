import type { ObserveResult } from "../../../models";
import { FieldTypeDetector } from "../FieldTypeDetector";
import { DefaultElementParser } from "../../utility/ElementParser";
import { toSearchable } from "../../utility/SearchableNode";
import {
  getFocusedTextField,
  getFocusedTextFieldIdentity,
  getFocusedTextLength,
  hasFocusedTextInput,
} from "../ClearText";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { Timer } from "../../../utils/SystemTimer";
import type { SendKeysObserver, TextActionResult } from "../SendKeys";
import { readBackWithSettle } from "./readBackWithSettle";

/** The field still shows its pre-clear text after the full settle poll (#9943). */
const CLEAR_UNCHANGED_WARNING =
  "The field still shows its pre-clear text after the clear was acknowledged; it may be a mask or permanent prefix at its cleared content, or the app may have refused the clear.";

type AndroidClearState = { kind: "applied" } | { kind: "pending" } | { kind: "unreadable" };

/** Abort checkpoint shared by the executor and the clear verifier: rethrow an abort, nothing else. */
export function checkAbort(signal?: AbortSignal, error?: unknown): void {
  signal?.throwIfAborted();
  if (error instanceof Error && error.name === "AbortError") {
    throw error;
  }
}

/**
 * One post-Enter read. `unavailable` is a stale or errored observation, which says nothing about
 * the field; `field` is a fresh observation whose focused snapshot or identity may be absent
 * because focus left the editable field.
 */
export type EnterFieldState =
  | { kind: "unavailable" }
  | {
      kind: "field";
      snapshot: { text: string; length: number } | undefined;
      identity: string | undefined;
    };

/**
 * Whether the Enter key reached the field the baseline was read from. Unavailable reads never
 * confirm. A different focused field confirms regardless of its text; otherwise the key landed
 * when a line was added or the text no longer extends the baseline (a submit that cleared the
 * field) or focus left every readable field.
 */
export function isEnterConfirmed(
  baseline: { text: string; identity: string | undefined },
  state: EnterFieldState,
): boolean {
  if (state.kind === "unavailable") {
    return false;
  }
  if (
    state.identity !== undefined &&
    baseline.identity !== undefined &&
    state.identity !== baseline.identity
  ) {
    return true;
  }
  const { snapshot } = state;
  return (
    snapshot === undefined ||
    snapshot.text.split("\n").length > baseline.text.split("\n").length ||
    !snapshot.text.startsWith(baseline.text)
  );
}

export interface FocusedTextClearVerifierDeps {
  observer: Pick<SendKeysObserver, "execute">;
  timer: Timer;
  /** The plain field clear used when the caller supplies none. */
  clearText: () => Promise<TextActionResult>;
}

/**
 * Reads the focused Android field's text and verifies that an acknowledged clear was applied.
 * Moved out of DefaultSendKeysCommandExecutor unchanged (#11840).
 */
export class FocusedTextClearVerifier {
  constructor(private readonly deps: FocusedTextClearVerifierDeps) {}

  /**
   * set_text("") is acknowledged before the app applies it; a following a11y insert plans from a
   * fresh node snapshot and would otherwise write old + new text (#9884). The text read before the
   * clear is what an unapplied clear still shows. Shared by the `clear` command and the clear that
   * precedes an eventAll/eventLast replace (#9940).
   */
  async clearAndVerifyAndroid(
    signal?: AbortSignal,
    display?: string,
    clear: () => Promise<TextActionResult> = this.deps.clearText,
    passwordField = false,
  ): Promise<{ result: TextActionResult; unchangedWarning?: string }> {
    const preClearText = await this.readTextBeforeClear(signal, display, passwordField);
    checkAbort(signal);
    const result = await clear();
    if (!result.success) {
      return { result };
    }
    const unchangedWarning = await this.verifyAndroidClearApplied(preClearText, signal, display);
    return { result, ...(unchangedWarning === undefined ? {} : { unchangedWarning }) };
  }

  /**
   * Focused text before a clear, or undefined when there is nothing to verify (empty field, or an
   * unreadable one, which is logged). Hint-aware: placeholder text counts as empty.
   */
  async readTextBeforeClear(
    signal?: AbortSignal,
    display?: string,
    passwordField = false,
  ): Promise<string | undefined> {
    try {
      const snapshot = this.readFocusedTextSnapshot(
        await this.readFreshObservation(signal, display),
      );
      if (snapshot === undefined && passwordField) {
        // A password field is masked by design; an unverifiable clear is expected, not a fault.
        logger.debug("[SendKeys] Password field is masked; the clear will not be verified");
      } else if (snapshot === undefined) {
        logger.warn(
          "[SendKeys] Focused text is unreadable before the clear; it will not be verified",
        );
      }
      return snapshot && snapshot.length > 0 ? snapshot.text : undefined;
    } catch (error) {
      checkAbort(signal, error);
      logger.warn(`[SendKeys] Pre-clear read unavailable: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  /**
   * Poll until the acknowledged clear is visible, i.e. the field no longer shows the pre-clear
   * text. Any other content (empty, hint, a mask or permanent prefix) counts as applied. Text that
   * is still unchanged after the full poll is a settled state (a mask or permanent prefix already
   * at its cleared content, or a refused clear), so the clear stays successful with a warning
   * rather than failing the call (#9943). An unreadable field is retried, then passes.
   */
  verifyAndroidClearApplied(
    preClearText: string | undefined,
    signal?: AbortSignal,
    display?: string,
  ): Promise<string | undefined> {
    if (preClearText === undefined) {
      return Promise.resolve(undefined);
    }
    return readBackWithSettle(
      () => this.readClearState(preClearText, signal, display),
      (state) => state.kind === "applied",
      {
        timer: this.deps.timer,
        finish: (state) => {
          if (state?.kind === "applied") {
            return undefined;
          }
          if (state?.kind === "pending") {
            logger.warn(`[SendKeys] ${CLEAR_UNCHANGED_WARNING}`);
            return CLEAR_UNCHANGED_WARNING;
          }
          logger.warn(
            "[SendKeys] The clear could not be verified: the focused field stayed unreadable",
          );
          return undefined;
        },
      },
    );
  }

  async readClearState(
    preClearText: string,
    signal?: AbortSignal,
    display?: string,
  ): Promise<AndroidClearState> {
    try {
      const snapshot = this.readFocusedTextSnapshot(
        await this.readFreshObservation(signal, display),
      );
      if (snapshot === undefined) {
        return { kind: "unreadable" };
      }
      return snapshot.length === 0 || snapshot.text !== preClearText
        ? { kind: "applied" }
        : { kind: "pending" };
    } catch (error) {
      checkAbort(signal, error);
      logger.warn(`[SendKeys] Clear read-back unavailable: ${errorMessage(error)}`, error);
      return { kind: "unreadable" };
    }
  }

  async readFreshObservation(signal?: AbortSignal, display?: string): Promise<ObserveResult> {
    checkAbort(signal);
    const observation = await this.deps.observer.execute({
      signal,
      freshness: "fresh",
      skipScreenshot: true,
      ...(display === undefined ? {} : { display }),
    });
    checkAbort(signal);
    return observation;
  }

  /** Classify a post-Enter observation without conflating "unavailable" with "focus left". */
  readEnterFieldState(observation: ObserveResult): EnterFieldState {
    const hierarchy = observation.viewHierarchy;
    if (observation.freshness?.isFresh === false || !hierarchy || hierarchy.hierarchy.error) {
      return { kind: "unavailable" };
    }
    return {
      kind: "field",
      snapshot: this.readFocusedTextSnapshot(observation),
      identity: getFocusedTextFieldIdentity(hierarchy),
    };
  }

  /** Hint-aware length plus the text; undefined when the field cannot be read. */
  readFocusedTextSnapshot(
    observation: ObserveResult,
  ): { text: string; length: number } | undefined {
    const hierarchy = observation.viewHierarchy;
    if (observation.freshness?.isFresh === false || !hierarchy || hierarchy.hierarchy.error) {
      return undefined;
    }
    // Hint-aware, like ClearText.verifyKeyEventClear: placeholder text counts as empty.
    const length = getFocusedTextLength(hierarchy);
    if (length === undefined) {
      return undefined;
    }
    const text = this.readFocusedText(observation);
    if (length === 0) {
      return { text: text ?? "", length };
    }
    return text === undefined ? undefined : { text, length };
  }

  readFocusedText(observation: ObserveResult): string | undefined {
    const detector = new FieldTypeDetector();
    const focused = observation.focusedElement;
    if (focused && String(focused.focused) === "true" && detector.detect(focused) === "text") {
      if (detector.isPasswordField(focused)) {
        return undefined;
      }
      return this.searchableText(focused);
    }
    if (!observation.viewHierarchy || !hasFocusedTextInput(observation.viewHierarchy)) {
      return undefined;
    }
    // ClearText already selects focused editable controls, including custom editors
    // with set_text actions, and preserves password metadata for unreadable values.
    const editable = getFocusedTextField(observation.viewHierarchy);
    if (editable !== undefined) {
      return editable.secure ? undefined : editable.value;
    }
    const parser = new DefaultElementParser();
    for (const root of parser.extractRootNodes(observation.viewHierarchy)) {
      let found: string | undefined;
      parser.traverseNode(root, (node) => {
        const element = parser.extractNodeProperties(node);
        if (element.focused === true || element.focused === "true") {
          if (detector.isPasswordField(element)) {
            return;
          }
          found = this.searchableText(element);
        }
      });
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  searchableText(element: Parameters<typeof toSearchable>[0]): string | undefined {
    const searchable = toSearchable(element);
    return (
      searchable.textSources.value ??
      searchable.textSources.text ??
      (searchable.capturedTextLength === 0 ? "" : undefined)
    );
  }
}
