import type { ObserveResult, ViewHierarchyNode } from "../../models";
import { nodeAttributes } from "../../models/ViewHierarchyResult";
import { DefaultElementParser } from "../utility/ElementParser";
import {
  getFocusedTextField,
  type FocusedTextField,
  type FocusedTextFieldOptions,
} from "./ClearText";
import type { ObserveScreenExecuteOptions } from "../observe/interfaces/ObserveScreen";
import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { isTextIndeterminateMessage } from "./TextIndeterminateError";
import { getTextRequestDeadlineMs } from "./textTransportTimeout";
import { combineAbortSignals, combineWithAmbientAbort } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";

/** Keep secure values out of the shared focused-field reader, including its property copies. */
class SecureValueOmittingParser extends DefaultElementParser {
  override extractNodeProperties(node: ViewHierarchyNode): Record<string, unknown> {
    const attributes = nodeAttributes(node);
    const nodeClass = attributes.class ?? attributes.className;
    if (
      attributes.password === true ||
      attributes.password === "true" ||
      (typeof nodeClass === "string" && nodeClass.includes("SecureTextField"))
    ) {
      return {
        focused: attributes.focused,
        class: nodeClass,
        password: true,
        editable: attributes.editable,
        actions: attributes.actions,
      };
    }
    return super.extractNodeProperties(node);
  }
}

export interface IosTypedTextVerificationResult {
  success: boolean;
  error?: string;
  warning?: string;
}

/** Literal Unicode characters in order; intervening mask characters are allowed. */
export function compareIosTypedText(
  text: string,
  before: FocusedTextField = { secure: false },
  after: FocusedTextField = { secure: false },
): IosTypedTextVerificationResult {
  if (before.secure || after.secure) {
    return { success: true, warning: "iOS typed text check skipped for a secure field." };
  }
  const nativeComparison = compareNativeEditableValues(
    before.nativeEditableValues,
    after.nativeEditableValues,
  );
  if (nativeComparison === "changed") {
    return { success: true };
  }
  // Native inputs prove typing only by changing; unchanged native inputs cannot prove nothing was
  // typed (the target may be web content whose value is unreadable).
  if (before.value === undefined || after.value === undefined) {
    return {
      success: true,
      warning: "iOS typed text result was not verified: the focused field could not be read.",
    };
  }
  if (before.value === after.value) {
    return {
      success: false,
      error: "iOS nothing was typed: the focused field value is unchanged.",
    };
  }
  return containsTypedCharacters(after.value ?? "", text)
    ? { success: true }
    : {
        success: true,
        warning: `iOS typed text changed in the focused field; observed value: ${JSON.stringify(after.value)}.`,
      };
}

/**
 * What a bounded read after an unconfirmed (timed-out) typeText says was committed. A token or
 * recipient field exposes its entries as separate elements, so its own value can stay unchanged
 * even when typing landed; the sentence says so rather than claiming nothing was typed.
 */
export function describeIosCommittedText(
  text: string,
  before: FocusedTextField | undefined,
  after: FocusedTextField | undefined,
): string {
  if (after === undefined) {
    return "the focused field could not be read, so what was committed is unknown.";
  }
  if (before?.secure || after.secure) {
    return "the focused field is secure; its content was not inspected.";
  }
  if (
    compareNativeEditableValues(before?.nativeEditableValues, after.nativeEditableValues) ===
    "changed"
  ) {
    return "another editable on screen changed (a recipient or token entry may hold the text), so the focused field's value does not show what was committed.";
  }
  if (before?.value === undefined || after.value === undefined) {
    return "the focused field's value could not be read, so what was committed is unknown.";
  }
  if (before.value === after.value) {
    return "the focused field's value is unchanged from before typing; entries held as separate tokens would not show in it.";
  }
  return containsTypedCharacters(after.value, text)
    ? "the focused field now contains the typed characters."
    : `the focused field's value changed to ${JSON.stringify(after.value)} (partial or altered input).`;
}

function compareNativeEditableValues(
  before: Readonly<Record<string, string>> = {},
  after: Readonly<Record<string, string>> = {},
): "changed" | "unchanged" | "unavailable" {
  const sharedIds = Object.keys(before).filter((id) => Object.hasOwn(after, id));
  if (sharedIds.some((id) => before[id] !== after[id])) {
    return "changed";
  }
  return sharedIds.length > 0 ? "unchanged" : "unavailable";
}

function containsTypedCharacters(value: string, text: string): boolean {
  const characters = Array.from(text);
  let matched = 0;
  for (const character of value) {
    if (character === characters[matched]) {
      matched++;
    }
  }
  return matched === characters.length;
}

export interface IosTypedTextObserver {
  execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult>;
}

/** Request budget left for a read, capped by `maxWaitMs` when given; undefined means unbounded. */
function readBudgetMs(timer: Timer, maxWaitMs?: number): number | undefined {
  const deadline = getTextRequestDeadlineMs();
  const requestRemaining = deadline === undefined ? undefined : deadline - timer.now();
  return maxWaitMs === undefined
    ? requestRemaining
    : Math.min(maxWaitMs, requestRemaining ?? maxWaitMs);
}

/** One fresh hierarchy-only read, bounded even when a client ignores cancellation. */
export async function readIosTypedTextField(
  observer: IosTypedTextObserver,
  timer: Timer,
  signal?: AbortSignal,
  display?: string,
  options: FocusedTextFieldOptions = {},
  maxWaitMs?: number,
): Promise<FocusedTextField | undefined> {
  const requestSignal = combineWithAmbientAbort(signal);
  const remaining = readBudgetMs(timer, maxWaitMs);
  if (requestSignal?.aborted || (remaining !== undefined && remaining <= 0)) {
    return undefined;
  }
  const controller = new AbortController();
  const readSignal = combineAbortSignals(requestSignal, controller.signal);
  try {
    const observation = await raceWithDeadline(
      () =>
        observer.execute({
          freshness: "fresh",
          skipScreenshot: true,
          skipAccessibilityAudit: true,
          signal: readSignal,
          timeoutMs: remaining,
          ...(display === undefined ? {} : { display }),
        }),
      {
        timer,
        timeoutMs: remaining,
        signal: readSignal,
        label: "iOS typed text verification",
        onTimeout: () => controller.abort(),
      },
    );
    const hierarchy = observation.viewHierarchy;
    return observation.freshness?.isFresh === false || !hierarchy || hierarchy.hierarchy.error
      ? undefined
      : getFocusedTextField(hierarchy, new SecureValueOmittingParser(), {
          ...options,
          includeIosNativeEditableValues: true,
        });
  } catch {
    // Best-effort verification must preserve a confirmed delivery; never log field/transport values.
    logger.warn("[iOS typed text] Focused field read unavailable; result cannot be verified");
    return undefined;
  }
}

export async function verifyIosTypedText(
  text: string,
  before: FocusedTextField | undefined,
  observer: IosTypedTextObserver,
  timer: Timer,
  signal?: AbortSignal,
  display?: string,
): Promise<IosTypedTextVerificationResult> {
  if (before?.secure) {
    return compareIosTypedText(text, before, undefined);
  }
  return compareIosTypedText(
    text,
    before,
    await readIosTypedTextField(observer, timer, signal, display),
  );
}

/** Upper bound for the read that explains an unconfirmed typeText. */
export const IOS_INDETERMINATE_READBACK_MAX_MS = 2000;

/**
 * Append what was committed to an unconfirmed (dispatched, timed-out) typeText error. The read is
 * bounded and best effort: the original error is always returned, never replaced.
 */
export async function explainIosIndeterminateText(
  error: string | undefined,
  text: string,
  before: FocusedTextField | undefined,
  read: {
    observer: IosTypedTextObserver;
    timer: Timer;
    signal?: AbortSignal;
    display?: string;
  },
): Promise<string | undefined> {
  if (!isTextIndeterminateMessage(error)) {
    return error;
  }
  const after = before?.secure
    ? before
    : await readIosTypedTextField(
        read.observer,
        read.timer,
        read.signal,
        read.display,
        {},
        IOS_INDETERMINATE_READBACK_MAX_MS,
      );
  return `${error} Observed afterwards: ${describeIosCommittedText(text, before, after)}`;
}
