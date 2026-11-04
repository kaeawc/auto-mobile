/**
 * Step-level `expectations` (#16817): each supported expectation becomes one internal `observe`
 * call with a `waitFor`, so it is checked against a fresh observation and its element is matched
 * by the same resolver `tapOn` and `observe.waitFor` use. This module owns the expectation forms,
 * their translation to a `waitFor`, and the failure message; the step executor owns the call.
 */

/** Expectation types the executor evaluates. */
export const SUPPORTED_EXPECTATION_TYPES = [
  "elementVisible",
  "elementAbsent",
  "textEquals",
  "textContains",
] as const;

export type SupportedExpectationType = (typeof SUPPORTED_EXPECTATION_TYPES)[number];

/** Selector keys an expectation accepts; `testTag`, `resourceId` and `elementId` are one id. */
const ID_KEYS = ["testTag", "resourceId", "elementId"] as const;
const PLAIN_KEYS = ["text", "contentDescription", "className"] as const;

export type ExpectationQuery =
  | { kind: "evaluate"; label: string; waitFor: Record<string, unknown> }
  | { kind: "unsupported"; label: string; type: string }
  | { kind: "invalid"; label: string; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSupportedType(type: string): type is SupportedExpectationType {
  return (SUPPORTED_EXPECTATION_TYPES as readonly string[]).includes(type);
}

/** A short, stable description of an expectation for messages, e.g. `elementVisible testTag="x"`. */
export function describeExpectation(expectation: unknown): string {
  if (!isRecord(expectation)) {
    return JSON.stringify(expectation) ?? String(expectation);
  }
  const type = typeof expectation.type === "string" ? expectation.type : "(no type)";
  const selector = isRecord(expectation.selector) ? expectation.selector : {};
  const parts = Object.entries(selector).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  if (expectation.text !== undefined) {
    parts.push(`text=${JSON.stringify(expectation.text)}`);
  }
  return [type, ...parts].join(" ");
}

type SelectorFields = Record<string, string>;

/** The `waitFor` element fields a selector maps to, or an error naming the bad field. */
function selectorFields(selector: unknown): SelectorFields | string {
  if (selector === undefined) {
    return {};
  }
  if (!isRecord(selector)) {
    return "selector must be an object";
  }
  const fields: SelectorFields = {};
  for (const [key, value] of Object.entries(selector)) {
    if (typeof value !== "string" || value.length === 0) {
      return `selector.${key} must be a non-empty string`;
    }
    if ((ID_KEYS as readonly string[]).includes(key)) {
      if (fields.elementId !== undefined && fields.elementId !== value) {
        return "selector names two different ids (testTag, resourceId, elementId)";
      }
      fields.elementId = value;
    } else if ((PLAIN_KEYS as readonly string[]).includes(key)) {
      fields[key] = value;
    } else {
      return `selector.${key} is not supported; use one of ${[...ID_KEYS, ...PLAIN_KEYS].join(", ")}`;
    }
  }
  return fields;
}

function timeoutFields(expectation: Record<string, unknown>): Record<string, number> | string {
  const timeout = expectation.timeoutMs;
  if (timeout === undefined) {
    return {};
  }
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0) {
    return "timeoutMs must be a non-negative number";
  }
  return { timeout };
}

function textWaitFor(
  type: "textEquals" | "textContains",
  fields: SelectorFields,
  text: unknown,
): Record<string, unknown> | string {
  if (typeof text !== "string" || text.length === 0) {
    return `${type} requires a non-empty \`text\``;
  }
  if (fields.text !== undefined) {
    return `${type} takes the expected value in \`text\`, not \`selector.text\``;
  }
  return { ...fields, text, textMatch: type === "textEquals" ? "exact" : "contains" };
}

function waitForFor(
  type: SupportedExpectationType,
  fields: SelectorFields,
  expectation: Record<string, unknown>,
): Record<string, unknown> | string {
  if (type === "textEquals" || type === "textContains") {
    return textWaitFor(type, fields, expectation.text);
  }
  if (Object.keys(fields).length === 0) {
    return `${type} requires a selector`;
  }
  return type === "elementVisible" ? { ...fields } : { absent: { ...fields } };
}

/** Translate one authored expectation into the `observe.waitFor` that checks it. */
export function expectationQuery(expectation: unknown): ExpectationQuery {
  const label = describeExpectation(expectation);
  if (!isRecord(expectation) || typeof expectation.type !== "string") {
    return { kind: "invalid", label, error: "an expectation must be an object with a `type`" };
  }
  if (!isSupportedType(expectation.type)) {
    return { kind: "unsupported", label, type: expectation.type };
  }
  const fields = selectorFields(expectation.selector);
  if (typeof fields === "string") {
    return { kind: "invalid", label, error: fields };
  }
  const timeout = timeoutFields(expectation);
  if (typeof timeout === "string") {
    return { kind: "invalid", label, error: timeout };
  }
  const waitFor = waitForFor(expectation.type, fields, expectation);
  if (typeof waitFor === "string") {
    return { kind: "invalid", label, error: waitFor };
  }
  return { kind: "evaluate", label, waitFor: { ...waitFor, ...timeout } };
}

/** The step warning for an expectation type the executor does not evaluate. */
export function unsupportedExpectationWarning(query: { label: string; type: string }): string {
  return `Expectation \`${query.label}\` was not evaluated: type \`${query.type}\` is not supported (supported: ${SUPPORTED_EXPECTATION_TYPES.join(", ")}).`;
}

const MAX_OBSERVED_TEXTS = 8;

/** What the expectation's observation saw, for the failure message. */
export interface ExpectationObserved {
  visibleTexts?: string[];
  candidateCount?: number;
  waitedMs?: number;
}

/** `Expectation 2/3 (elementVisible testTag="x") failed: ...; observed texts: "A", "B"`. */
export function expectationFailureMessage(
  position: { index: number; total: number; label: string },
  reason: string,
  observed: ExpectationObserved = {},
): string {
  const head = `Expectation ${position.index + 1}/${position.total} (${position.label}) failed: ${reason}`;
  const notes: string[] = [];
  if (observed.candidateCount !== undefined && observed.candidateCount > 0) {
    notes.push(`${observed.candidateCount} near match(es)`);
  }
  if (observed.visibleTexts && observed.visibleTexts.length > 0) {
    const texts = observed.visibleTexts.slice(0, MAX_OBSERVED_TEXTS).map((t) => JSON.stringify(t));
    notes.push(`observed texts: ${texts.join(", ")}`);
  }
  return notes.length > 0 ? `${head}; ${notes.join("; ")}` : head;
}
