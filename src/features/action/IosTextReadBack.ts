import type { ObserveResult } from "../../models";
import { getFocusedTextInputProperties, isSecureTextInputProperties } from "./ClearText";
import type { SendKeysOperation } from "./SendKeys";

/** What the focused iOS text field holds, as the runner reports it (#10167). */
export type IosFieldRead =
  | { kind: "text"; text: string; placeholder?: string; identity: string }
  | { kind: "secure"; identity: string }
  | { kind: "unreadable"; reason: string };

/**
 * Which field a read came from, compared between the read before typing and the read after it.
 * `view-id` is the runner's identity for a node: the accessibility identifier when the app set
 * one, otherwise an id derived from the node's path in the tree, so two different fields do not
 * share it. Without a `view-id` the class and placeholder are all the hierarchy offers, and two
 * fields that differ only by position would look alike (the weaker case).
 */
function focusedFieldIdentity(field: Record<string, unknown>): string {
  const viewId = field["view-id"] ?? field.viewId;
  if (typeof viewId === "string" && viewId !== "") {
    return `view-id:${viewId}`;
  }
  const nodeClass = field.class ?? field.className;
  const hint = field["hint-text"];
  return `shape:${typeof nodeClass === "string" ? nodeClass : ""}|${typeof hint === "string" ? hint : ""}`;
}

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
  const identity = focusedFieldIdentity(field);
  if (isSecureTextInputProperties(field)) {
    return { kind: "secure", identity };
  }
  const hint = field["hint-text"];
  return {
    kind: "text",
    text: typeof field.value === "string" ? field.value : "",
    ...(typeof hint === "string" && hint !== "" ? { placeholder: hint } : {}),
    identity,
  };
}

interface RawFieldText {
  text: string;
  placeholder?: string;
}

/**
 * What an empty field and a field that holds its own placeholder text both report. The hierarchy
 * carries no flag that says which one it is, so a value equal to the placeholder is read both
 * ways rather than guessed.
 */
function interpretations(read: RawFieldText): string[] {
  return read.placeholder !== undefined && read.text === read.placeholder
    ? [read.text, ""]
    : [read.text];
}

/** The most likely user-visible content, for display: a value equal to the placeholder is empty. */
function contentOf(read: RawFieldText): string {
  return interpretations(read).at(-1)!;
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

/**
 * `typed` replaced a non-empty range of `before` and nothing else changed: what typing over a
 * selection (after `selectAllText`) produces. The hierarchy reports no selection range, so this
 * shape cannot be told apart from text that was lost.
 */
function replacedSomeRange(before: string, typed: string, actual: string): boolean {
  for (let start = 0; start < before.length && actual.startsWith(before.slice(0, start)); start++) {
    const rest = actual.slice(start);
    if (!rest.startsWith(typed)) {
      continue;
    }
    const tail = rest.slice(typed.length);
    if (tail.length < before.length - start && before.endsWith(tail)) {
      return true;
    }
  }
  return false;
}

export interface IosTypedTextCheck {
  typed: string;
  operation: SendKeysOperation;
  /** The field's raw value before typing; ignored for a replace, which clears first. */
  before: RawFieldText;
  /** The field's raw value after typing. */
  after: RawFieldText;
}

export type IosTypedTextVerdict =
  | { kind: "match" }
  | { kind: "mismatch"; warning: string }
  | { kind: "unverifiable"; reason: string };

/**
 * Judge the field's content against the expected result (existing text plus typed text for an
 * insert, the typed text for a replace). A line break in the typed text is an action key in a
 * single-line field rather than content, so a field that holds the text without it matches too.
 * A mismatch stays a warning, like the Android letter-case read-back (#9888): the text was typed,
 * and a failure would invite a retry that duplicates it.
 *
 * Two things the hierarchy cannot tell are not guessed: a value equal to the placeholder is read
 * as both empty and literal, and an insert whose result is the typed text replacing part of the
 * old content is "unverifiable" (the old content may have been selected), not a shortfall.
 * The caller has already established that this is the field that was typed into.
 */
export function judgeIosTypedText(check: IosTypedTextCheck): IosTypedTextVerdict {
  const { typed, after } = check;
  const insert = check.operation !== "replace";
  const baselines = insert ? interpretations(check.before) : [""];
  const actuals = interpretations(after);
  const forms = [...new Set([typed, stripLineBreaks(typed)])];
  const combos = baselines.flatMap((baseline) =>
    actuals.flatMap((actual) => forms.map((form) => ({ baseline, actual, form }))),
  );
  if (combos.some((c) => insertedAnywhere(c.baseline, c.form, c.actual))) {
    return { kind: "match" };
  }
  if (insert && combos.some((c) => replacedSomeRange(c.baseline, c.form, c.actual))) {
    return {
      kind: "unverifiable",
      reason:
        "the field's selection is not reported, so typing over selected text cannot be told apart from lost text",
    };
  }
  const baseline = insert ? contentOf(check.before) : "";
  const actual = contentOf(after);
  const expected = baseline + typed;
  return {
    kind: "mismatch",
    warning: `After typing ${quote(typed)} the focused field holds ${quote(actual)}, not the expected ${quote(expected)}: it is ${describeDifference(baseline, expected, actual)}. An input mask, a maximum length or autocorrect probably changed the text. The text was sent, so the call stays successful; observe before retrying, because a retry could duplicate it.`,
  };
}

/** Result note when the field could not be read back; no claim about its content. */
export function iosTypedTextNotVerifiedNote(reason: string): string {
  return `The typed text was not read back from the field (${reason}), so the result was not verified.`;
}

/**
 * Whether the read after typing is of the field that was typed into. Compared on `identity` and
 * never on content: when the focus moved (a Return or Next key, a field that advances itself)
 * the later field's content must not be compared, quoted or judged.
 */
export function iosFocusMoved(
  before: Exclude<IosFieldRead, { kind: "unreadable" }>,
  after: Exclude<IosFieldRead, { kind: "unreadable" }>,
): boolean {
  return before.identity !== after.identity;
}
