import { record, type Raw } from "../prototypeTemplate";

/** What a still render knows when it evaluates a condition: spec state only. */
export interface ConditionScope {
  readonly state: Raw;
  readonly platform: "android" | "ios";
}

/** `undefined` means the still render cannot decide. */
type Decision = boolean | undefined;

function compare(value: unknown, condition: Raw): Decision {
  if ("equals" in condition) {
    return value === condition.equals;
  }
  if ("notEquals" in condition) {
    return value !== condition.notEquals;
  }
  if (typeof condition.gt === "number") {
    return typeof value === "number" && value > condition.gt;
  }
  if (typeof condition.lt === "number") {
    return typeof value === "number" && value < condition.lt;
  }
  if (typeof condition.empty === "boolean") {
    const isEmpty =
      value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
    return isEmpty === condition.empty;
  }
  // Text operators need string semantics a still frame does not model.
  return undefined;
}

function all(decisions: Decision[]): Decision {
  if (decisions.includes(false)) {
    return false;
  }
  return decisions.includes(undefined) ? undefined : true;
}

function any(decisions: Decision[]): Decision {
  if (decisions.includes(true)) {
    return true;
  }
  return decisions.includes(undefined) ? undefined : false;
}

function decide(condition: unknown, scope: ConditionScope): Decision {
  const raw = record(condition);
  if (!raw) {
    return undefined;
  }
  if (Array.isArray(raw.all)) {
    return all(raw.all.map((entry) => decide(entry, scope)));
  }
  if (Array.isArray(raw.any)) {
    return any(raw.any.map((entry) => decide(entry, scope)));
  }
  if (raw.not !== undefined) {
    const inner = decide(raw.not, scope);
    return inner === undefined ? undefined : !inner;
  }
  // `data` and `platform` are pointers into data and platform state the still does not model.
  if (typeof raw.key === "string" && Object.hasOwn(scope.state, raw.key)) {
    return compare(scope.state[raw.key], raw);
  }
  return undefined;
}

/**
 * Whether a `visibleWhen` or `enabledWhen` condition holds. Undecidable parts (data and platform
 * pointers, unknown keys, validity, string operators) stay undecided through `all`, `any` and
 * `not`, and only the whole condition falls back to true, so a node is never hidden by a guess.
 */
export function conditionHolds(condition: unknown, scope: ConditionScope): boolean {
  return decide(condition, scope) ?? true;
}
