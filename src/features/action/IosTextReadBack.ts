import type { ObserveResult } from "../../models";
import { getFocusedTextInputProperties, isSecureTextInputProperties } from "./ClearText";
import type { SendKeysOperation } from "./SendKeys";

/** What the focused iOS text field holds, as the runner reports it (#10167). */
export type IosFieldRead =
  | { kind: "text"; text: string; placeholder?: string }
  | { kind: "secure" }
  | { kind: "unreadable"; reason: string };

/** Longest field or typed text quoted in a warning, in code points. */
const QUOTE_LIMIT = 80;

/**
 * The focused editable field's current text. The runner omits an empty `value` and reports the
 * placeholder as the value of an empty field (ElementLocator+Snapshot.swift), so a focused text
 * input without a `value` is empty, not unreadable; `readableText` resolves the placeholder.
 * Secure fields are never read: the runner masks them with bullets and the content is not echoed.
 */
export function readIosFocusedField(observation: ObserveResult): IosFieldRead {
  const hierarchy = observation.viewHierarchy;
  if (observation.freshness?.isFresh === false) {
    return { kind: "unreadable", reason: "the observation was not fresh" };
  }
  if (!hierarchy || hierarchy.hierarchy?.error) {
    return { kind: "unreadable", reason: "the view hierarchy was unavailable" };
  }
  const field = getFocusedTextInputProperties(hierarchy);
  if (field === undefined) {
    return { kind: "unreadable", reason: "no focused text field was found" };
  }
  if (isSecureTextInputProperties(field)) {
    return { kind: "secure" };
  }
  const hint = field["hint-text"];
  return {
    kind: "text",
    text: typeof field.value === "string" ? field.value : "",
    ...(typeof hint === "string" && hint !== "" ? { placeholder: hint } : {}),
  };
}

/** The user-visible content: an empty field reports its placeholder as its value. */
function contentOf(read: { text: string; placeholder?: string }): string {
  return read.placeholder !== undefined && read.text === read.placeholder ? "" : read.text;
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

function stripLineBreaks(text: string): string {
  return text.replace(/[\r\n]/g, "");
}

function quote(text: string): string {
  const points = Array.from(text);
  return points.length <= QUOTE_LIMIT
    ? JSON.stringify(text)
    : `${JSON.stringify(points.slice(0, QUOTE_LIMIT).join(""))} (truncated)`;
}

/** `typed` inserted anywhere in `before` yields `actual`: XCUITest types at the caret. */
function insertedAnywhere(before: string, typed: string, actual: string): boolean {
  if (actual.length !== before.length + typed.length) {
    return false;
  }
  for (let caret = 0; caret <= before.length; caret++) {
    if (actual === before.slice(0, caret) + typed + before.slice(caret)) {
      return true;
    }
  }
  return false;
}

function describeDifference(before: string, expected: string, actual: string): string {
  if (actual === before) {
    return "unchanged, so the field did not take the input";
  }
  const actualLength = codePointLength(actual);
  const expectedLength = codePointLength(expected);
  if (actualLength < expectedLength) {
    return "shorter than expected (truncated or filtered)";
  }
  if (actualLength > expectedLength) {
    return "longer than expected (characters were added)";
  }
  return "different from what was typed (reformatted or autocorrected)";
}

export interface IosTypedTextCheck {
  typed: string;
  operation: SendKeysOperation;
  /** Field content before typing; empty for a replace, which clears first. */
  before: string;
  /** Raw value read after typing. */
  after: { text: string; placeholder?: string };
}

/**
 * Warning for a field whose content differs from the expected result (existing text plus typed
 * text for an insert, the typed text for a replace), or undefined when it matches. A line break in
 * the typed text is an action key in a single-line field rather than content, so a field that
 * holds the text without it matches too. Stays a warning, like the Android letter-case read-back
 * (#9888): the text was typed, and a failure would invite a retry that duplicates it.
 */
export function describeIosTypedTextMismatch(check: IosTypedTextCheck): string | undefined {
  const { typed, before, after } = check;
  const baseline = check.operation === "replace" ? "" : before;
  const expected = baseline + typed;
  // A field that really holds its own placeholder text is indistinguishable from an empty one;
  // an exact match is still a match.
  if (after.text === expected) {
    return undefined;
  }
  const actual = contentOf(after);
  const candidates = [...new Set([typed, stripLineBreaks(typed)])];
  if (candidates.some((candidate) => insertedAnywhere(baseline, candidate, actual))) {
    return undefined;
  }
  return `After typing ${quote(typed)} the focused field holds ${quote(actual)}, not the expected ${quote(expected)}: it is ${describeDifference(baseline, expected, actual)}. An input mask, a maximum length or autocorrect probably changed the text. The text was sent, so the call stays successful; observe before retrying, because a retry could duplicate it.`;
}

/** Result note when the field could not be read back; no claim about its content. */
export function iosTypedTextNotVerifiedNote(reason: string): string {
  return `The typed text was not read back from the field (${reason}), so the result was not verified.`;
}

/** The content to compare against, from a pre-typing read (a placeholder counts as empty). */
export function iosContentBeforeTyping(read: Extract<IosFieldRead, { kind: "text" }>): string {
  return contentOf(read);
}
