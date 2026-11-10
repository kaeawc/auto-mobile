import type { ObserveResult, ViewHierarchyNode } from "../../models";
import { nodeAttributes } from "../../models/ViewHierarchyResult";
import { DefaultElementParser } from "../utility/ElementParser";
import {
  getFocusedTextField,
  hasFocusedTextInput,
  type FocusedTextField,
  type FocusedTextFieldOptions,
} from "./ClearText";
import type { ObserveScreenExecuteOptions } from "../observe/interfaces/ObserveScreen";
import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import {
  compareIosTokenField,
  describeIosTokenFieldCommitted,
  isIosTokenField,
} from "./iosTokenFieldVerification";
import { isTextIndeterminateMessage } from "./TextIndeterminateError";
import { getTextRequestDeadlineMs } from "./textTransportTimeout";
import { combineAbortSignals, combineWithAmbientAbort } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";
import { isIosKeyboardVisible } from "../observe/ios/IosScreenIdentity";

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
        "resource-id": attributes["resource-id"],
        bounds: attributes.bounds,
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

/** XCUI snapshot values expose only the first 512 characters of a longer focused value. */
export const IOS_FOCUSED_VALUE_READ_WINDOW = 512;

const IOS_FOCUSED_VALUE_READ_WINDOW_WARNING = `iOS typed text result was not verified: the focused field value fills the ${IOS_FOCUSED_VALUE_READ_WINDOW}-character read window, so a change past it cannot be seen.`;

/** Full insertion at any caret position; only the first chunk may replace selected text. */
function isIosChunkInsertion(
  text: string,
  before: string,
  after: string,
  firstChunk: boolean,
): boolean {
  const replacedLength = before.length + text.length - after.length;
  if (replacedLength < 0 || (!firstChunk && replacedLength !== 0)) {
    return false;
  }
  for (let index = after.indexOf(text); index !== -1; index = after.indexOf(text, index + 1)) {
    if (after.slice(0, index) !== before.slice(0, index)) {
      return false;
    }
    if (after.slice(index + text.length) === before.slice(index + replacedLength)) {
      return true;
    }
  }
  return false;
}

function compareIosChunkAppend(
  text: string,
  before: string,
  after: string,
  firstChunk: boolean,
): IosTypedTextVerificationResult {
  // An exact window may hide the append, including the chunk that first fills it.
  // Wider readable values still allow the full insertion check below.
  if (after.length === IOS_FOCUSED_VALUE_READ_WINDOW) {
    return {
      success: true,
      warning: IOS_FOCUSED_VALUE_READ_WINDOW_WARNING,
    };
  }
  if (before === after) {
    return {
      success: false,
      error: "iOS nothing was typed: the focused field value is unchanged.",
    };
  }
  // A suffix alone is insufficient: earlier repeated characters can hide a partial append.
  return isIosChunkInsertion(text, before, after, firstChunk)
    ? { success: true }
    : {
        success: false,
        error: "iOS typed text chunk was not fully appended to the focused field.",
      };
}

export interface IosTypedTextVerificationOptions {
  verifyAppend: boolean;
  firstChunk?: boolean;
}

/** Literal Unicode characters in order; intervening mask characters are allowed. */
export function compareIosTypedText(
  text: string,
  before: FocusedTextField = { secure: false },
  after: FocusedTextField = { secure: false },
  options: boolean | IosTypedTextVerificationOptions = false,
): IosTypedTextVerificationResult {
  if (before.secure || after.secure) {
    return { success: true, warning: "iOS typed text check skipped for a secure field." };
  }
  const verifyAppend = typeof options === "boolean" ? options : options.verifyAppend;
  const baseline = withBlankOmittedNativeValue(before);
  return (
    (verifyAppend
      ? compareIosChunkField(
          text,
          baseline,
          after,
          typeof options !== "boolean" && options.firstChunk === true,
        )
      : undefined) ?? compareIosNonSecureTypedText(text, baseline, after)
  );
}

/**
 * Runners omit an empty native field's value, so a native baseline with no value is blank (#17764).
 * Only the baseline: an omitted value after typing still cannot show what was typed.
 */
function withBlankOmittedNativeValue(before: FocusedTextField): FocusedTextField {
  return before.iosNativeValueOmitted === true && before.value === undefined
    ? { ...before, value: "" }
    : before;
}

function compareIosChunkField(
  text: string,
  before: FocusedTextField,
  after: FocusedTextField,
  firstChunk: boolean,
): IosTypedTextVerificationResult | undefined {
  if (
    before.identity !== undefined &&
    after.identity !== undefined &&
    before.identity !== after.identity
  ) {
    return {
      success: true,
      warning: "iOS typed text result was not verified: focus moved to another field.",
    };
  }
  const nativeBefore = before.nativeEditableValues ?? {};
  const nativeAfter = after.nativeEditableValues ?? {};
  if (
    Object.keys(nativeBefore).some(
      (id) =>
        Object.hasOwn(nativeAfter, id) &&
        nativeBefore[id] !== nativeAfter[id] &&
        isIosChunkInsertion(text, nativeBefore[id], nativeAfter[id], firstChunk),
    )
  ) {
    return { success: true };
  }
  if (before.value !== undefined && after.value !== undefined && !isIosTokenField(before, after)) {
    return compareIosChunkAppend(text, before.value, after.value, firstChunk);
  }
  return undefined;
}

function compareIosNonSecureTypedText(
  text: string,
  before: FocusedTextField,
  after: FocusedTextField,
): IosTypedTextVerificationResult {
  const nativeComparison = compareNativeEditableValues(
    before.nativeEditableValues,
    after.nativeEditableValues,
  );
  if (nativeComparison === "changed") {
    return { success: true };
  }
  // A recipient/token field is judged by its trailing text and tokens, not its full value.
  const tokenComparison = compareIosTokenField(text, before, after);
  if (tokenComparison !== undefined) {
    return tokenComparison;
  }
  // Native inputs prove typing only by changing; unchanged native inputs cannot prove nothing was
  // typed (the target may be web content whose value is unreadable).
  if (before.value === undefined || after.value === undefined) {
    return {
      success: true,
      warning: "iOS typed text result was not verified: the focused field could not be read.",
    };
  }
  if (after.value.length >= IOS_FOCUSED_VALUE_READ_WINDOW) {
    return {
      success: true,
      warning: IOS_FOCUSED_VALUE_READ_WINDOW_WARNING,
    };
  }
  if (before.value === after.value) {
    return {
      success: false,
      error: "iOS nothing was typed: the focused field value is unchanged.",
    };
  }
  return containsTypedCharacters(after.value, text)
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
  const tokenDescription = describeIosTokenFieldCommitted(text, before, after);
  if (tokenDescription !== undefined) {
    return tokenDescription;
  }
  if (
    compareNativeEditableValues(before?.nativeEditableValues, after.nativeEditableValues) ===
    "changed"
  ) {
    return "another editable on screen changed (a recipient or token entry may hold the text), so the focused field's value does not show what was committed.";
  }
  return describeFocusedValueChange(text, before?.value, after.value);
}

function describeFocusedValueChange(
  text: string,
  before: string | undefined,
  after: string | undefined,
): string {
  if (after !== undefined && after.length >= IOS_FOCUSED_VALUE_READ_WINDOW) {
    return `the focused field's value fills the ${IOS_FOCUSED_VALUE_READ_WINDOW}-character read window, so what was committed is unknown.`;
  }
  if (before === undefined || after === undefined) {
    return "the focused field's value could not be read, so what was committed is unknown.";
  }
  if (before === after) {
    return "the focused field's value is unchanged from before typing; entries held as separate tokens would not show in it.";
  }
  return containsTypedCharacters(after, text)
    ? "the focused field now contains the typed characters."
    : `the focused field's value changed to ${JSON.stringify(after)} (partial or altered input).`;
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

/** Where and how a focused-field read-back runs. */
export interface IosTypedTextRead {
  observer: IosTypedTextObserver;
  timer: Timer;
  signal?: AbortSignal;
  display?: string;
}

/** Request budget left for a read, capped by `maxWaitMs` when given; undefined means unbounded. */
function readBudgetMs(timer: Timer, maxWaitMs?: number): number | undefined {
  const deadline = getTextRequestDeadlineMs();
  const requestRemaining = deadline === undefined ? undefined : deadline - timer.now();
  return maxWaitMs === undefined
    ? requestRemaining
    : Math.min(maxWaitMs, requestRemaining ?? maxWaitMs);
}

export type IosTypedTextFocusRead =
  | { kind: "unavailable" }
  | {
      kind: "read";
      field: FocusedTextField | undefined;
      hasFocusedTextInput: boolean;
      keyboardVisible: boolean;
    };

/** Preserve the focused-field-only contract for verification callers. */
export async function readIosTypedTextField(
  read: IosTypedTextRead,
  options: FocusedTextFieldOptions = {},
  maxWaitMs?: number,
): Promise<FocusedTextField | undefined> {
  const result = await readIosTypedTextFocus(read, options, maxWaitMs);
  return result.kind === "read" ? result.field : undefined;
}

/** One fresh hierarchy-only read, bounded even when a client ignores cancellation. */
export async function readIosTypedTextFocus(
  read: IosTypedTextRead,
  options: FocusedTextFieldOptions = {},
  maxWaitMs?: number,
): Promise<IosTypedTextFocusRead> {
  const { observer, timer, signal, display } = read;
  const requestSignal = combineWithAmbientAbort(signal);
  const remaining = readBudgetMs(timer, maxWaitMs);
  if (requestSignal?.aborted || (remaining !== undefined && remaining <= 0)) {
    return { kind: "unavailable" };
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
    if (observation.freshness?.isFresh === false || !hierarchy || hierarchy.hierarchy.error) {
      return { kind: "unavailable" };
    }
    return {
      kind: "read",
      field: getFocusedTextField(hierarchy, new SecureValueOmittingParser(), {
        ...options,
        includeIosNativeEditableValues: true,
      }),
      // Real focus does not require a readable value or a native editable snapshot.
      hasFocusedTextInput: hasFocusedTextInput(hierarchy, new SecureValueOmittingParser()),
      keyboardVisible: isIosKeyboardVisible(observation.viewHierarchy, observation.screenSize),
    };
  } catch {
    // Best-effort verification must preserve a confirmed delivery; never log field/transport values.
    logger.warn("[iOS typed text] Focused field read unavailable; result cannot be verified");
    return { kind: "unavailable" };
  }
}

/** A recipient field commits a token with an animation; how long and how often to re-read. */
export const IOS_TOKEN_SETTLE_MAX_MS = 1000;
export const IOS_TOKEN_SETTLE_POLL_MS = 250;

export async function verifyIosTypedText(
  text: string,
  before: FocusedTextField | undefined,
  read: IosTypedTextRead,
  options: boolean | IosTypedTextVerificationOptions = false,
): Promise<IosTypedTextVerificationResult & { after: FocusedTextField | undefined }> {
  const { timer, signal } = read;
  const verifyAppend = typeof options === "boolean" ? options : options.verifyAppend;
  if (before?.secure && !verifyAppend) {
    return { ...compareIosTypedText(text, before, undefined), after: before };
  }
  let after = await readIosTypedTextField(read, { includeIdentity: verifyAppend });
  let result = compareIosTypedText(text, before, after, options);
  // A recipient/token field can settle after the keystrokes land; re-read it, bounded, before
  // reporting that nothing was typed.
  const settleDeadline = timer.now() + IOS_TOKEN_SETTLE_MAX_MS;
  while (!result.success && isIosTokenField(before, after) && timer.now() < settleDeadline) {
    signal?.throwIfAborted();
    await timer.sleep(IOS_TOKEN_SETTLE_POLL_MS);
    after = await readIosTypedTextField(
      read,
      { includeIdentity: verifyAppend },
      Math.max(0, settleDeadline - timer.now()),
    );
    result = compareIosTypedText(text, before, after, options);
  }
  return { ...result, after };
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
  read: IosTypedTextRead,
): Promise<string | undefined> {
  if (!isTextIndeterminateMessage(error)) {
    return error;
  }
  const after = before?.secure
    ? before
    : await readIosTypedTextField(read, {}, IOS_INDETERMINATE_READBACK_MAX_MS);
  return `${error} Observed afterwards: ${describeIosCommittedText(text, before, after)}`;
}
