import { record, type Raw } from "../prototypeTemplate";
import type { StillPlatformState } from "./webPlatformState";

/** What a still render knows when it evaluates a condition: spec state and frame platform state. */
export interface ConditionScope {
  readonly state: Raw;
  readonly derived?: Raw;
  readonly platform: "android" | "ios";
  /** Platform state the frame decides; a pointer not listed here is undecidable. */
  readonly platformState?: StillPlatformState;
}

/** `undefined` means the still render cannot decide. */
type Decision = boolean | undefined;

function isEmpty(value: unknown, derived: boolean): boolean {
  const object = derived ? record(value) : undefined;
  return (
    value === undefined ||
    (derived && value === null) ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (object !== undefined && Object.keys(object).length === 0)
  );
}

function compare(value: unknown, condition: Raw, derived = false): Decision {
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
    return isEmpty(value, derived) === condition.empty;
  }
  if (derived) {
    return stringCondition(value, condition);
  }
  // State string operators remain undecidable in a still frame.
  return undefined;
}

export function stringCondition(value: unknown, condition: Raw): Decision {
  const text = typeof value === "string" ? value : undefined;
  if (typeof condition.contains === "string") {
    return text !== undefined && text.includes(condition.contains);
  }
  if (typeof condition.startsWith === "string") {
    return text !== undefined && text.startsWith(condition.startsWith);
  }
  if (typeof condition.lengthGt === "number") {
    return text !== undefined && text.length > condition.lengthGt;
  }
  if (typeof condition.lengthLt === "number") {
    return text !== undefined && text.length < condition.lengthLt;
  }
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

/** The condition's value, or undefined when the still render cannot decide it. */
export function decide(condition: unknown, scope: ConditionScope): Decision {
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
  return decideLeaf(raw, scope);
}

function decideLeaf(raw: Raw, scope: ConditionScope): Decision {
  if (typeof raw.derived === "string" && scope.derived) {
    const value = Object.hasOwn(scope.derived, raw.derived)
      ? scope.derived[raw.derived]
      : undefined;
    return compare(
      typeof value === "number" && !Number.isFinite(value) ? undefined : value,
      raw,
      true,
    );
  }
  if (typeof raw.key === "string") {
    return compareState(raw, raw.key, scope.state);
  }
  // A platform pointer the frame decides compares like state; `data` pointers stay undecidable.
  const platformState = scope.platformState ?? {};
  if (typeof raw.platform === "string" && Object.hasOwn(platformState, raw.platform)) {
    return compare(platformState[raw.platform], raw);
  }
  return undefined;
}

function compareState(condition: Raw, key: string, state: Raw): Decision {
  if (typeof condition.equalsKey === "string") {
    return (
      Object.hasOwn(state, key) &&
      Object.hasOwn(state, condition.equalsKey) &&
      state[key] === state[condition.equalsKey]
    );
  }
  return Object.hasOwn(state, key) ? compare(state[key], condition) : undefined;
}

/**
 * Whether a `visibleWhen` or `enabledWhen` condition holds. Undecidable parts (data pointers,
 * platform pointers the frame does not decide, unknown keys, validity, string operators) stay undecided through `all`, `any` and
 * `not`, and only the whole condition falls back to true, so a node is never hidden by a guess.
 */
export function conditionHolds(condition: unknown, scope: ConditionScope): boolean {
  return decide(condition, scope) ?? true;
}
