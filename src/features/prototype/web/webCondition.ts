import { record, type Raw } from "../prototypeTemplate";

/** What a still render knows when it evaluates a condition: spec state and the target platform. */
export interface ConditionScope {
  readonly state: Raw;
  readonly platform: "android" | "ios";
}

function compare(value: unknown, condition: Raw): boolean {
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
  // Text operators need values a still frame does not model; the node stays visible.
  return true;
}

/**
 * Whether a `visibleWhen` or `enabledWhen` condition holds. A condition the still render cannot
 * decide (data paths, unknown keys, validity) counts as true, so a node is never hidden by a guess.
 */
export function conditionHolds(condition: unknown, scope: ConditionScope): boolean {
  const raw = record(condition);
  if (!raw) {
    return true;
  }
  if (Array.isArray(raw.all)) {
    return raw.all.every((entry) => conditionHolds(entry, scope));
  }
  if (Array.isArray(raw.any)) {
    return raw.any.some((entry) => conditionHolds(entry, scope));
  }
  if (raw.not !== undefined) {
    return !conditionHolds(raw.not, scope);
  }
  if (raw.platform !== undefined) {
    return compare(scope.platform, raw);
  }
  if (typeof raw.key === "string" && Object.hasOwn(scope.state, raw.key)) {
    return compare(scope.state[raw.key], raw);
  }
  return true;
}
