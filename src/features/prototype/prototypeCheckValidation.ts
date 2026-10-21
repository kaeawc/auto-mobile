import { parseCheckPattern } from "./prototypeCheckPattern";
import { record, type Raw } from "./prototypeTemplate";
import type { PrototypeValidationError } from "./prototypeValidation";
interface Located {
  value: Raw;
  path: string;
  item?: number;
}
const error = (path: string, message: string): PrototypeValidationError => ({ path, message });
const textKinds = new Set(["minLength", "maxLength", "format", "pattern"]);
function fitsControl(kind: string, type: unknown): boolean {
  if (textKinds.has(kind)) {
    return type === "textField";
  }
  if (kind === "min" || kind === "max") {
    return ["slider", "datePicker", "timePicker"].includes(String(type));
  }
  return true;
}
function checkErrors(node: Raw, path: string): PrototypeValidationError | undefined {
  const checks = Array.isArray(node.checks) ? node.checks.map((check) => record(check) ?? {}) : [];
  for (const [index, check] of checks.entries()) {
    const kind = Object.keys(check).find((key) => key !== "message") ?? "";
    const at = `${path}.checks[${index}].${kind}`;
    if (!fitsControl(kind, node.type)) {
      return error(at, `Check ${kind} does not fit ${node.type}`);
    }
    if (typeof check.pattern === "string") {
      const parsed = parseCheckPattern(check.pattern);
      if (!parsed.ok) {
        return error(at, parsed.message);
      }
    }
  }
  for (const [lower, upper] of [
    ["min", "max"],
    ["minLength", "maxLength"],
  ]) {
    const lows = checks
      .map((check) => check[lower])
      .filter((v): v is number => typeof v === "number");
    const highs = checks
      .map((check) => check[upper])
      .filter((v): v is number => typeof v === "number");
    if (lows.length && highs.length && Math.max(...lows) > Math.min(...highs)) {
      const index = checks.findIndex((check) => check[upper] === Math.min(...highs));
      return error(`${path}.checks[${index}].${upper}`, `${lower} exceeds ${upper}`);
    }
  }
  return undefined;
}
function keyError(
  value: unknown,
  path: string,
  keys: Set<string>,
): PrototypeValidationError | undefined {
  const requested = Array.isArray(value) ? value : [value];
  return requested.some((key) => typeof key !== "string" || !keys.has(key))
    ? error(path, "Validity key must be declared state with at least one check")
    : undefined;
}
function conditionError(
  value: unknown,
  path: string,
  keys: Set<string>,
): PrototypeValidationError | undefined {
  const condition = record(value);
  if (!condition) {
    return undefined;
  }
  if (condition.valid !== undefined) {
    return keyError(condition.valid, path, keys);
  }
  if (condition.not !== undefined) {
    return conditionError(condition.not, `${path}.not`, keys);
  }
  for (const form of ["all", "any"]) {
    const children = condition[form];
    if (!Array.isArray(children)) {
      continue;
    }
    for (const [index, child] of children.entries()) {
      const found = conditionError(child, `${path}.${form}[${index}]`, keys);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}
function checkedKeys(nodes: Located[], state: Raw): Set<string> {
  const keys = new Set<string>();
  for (const { value } of nodes) {
    if (!Array.isArray(value.checks) || !value.checks.length) {
      continue;
    }
    for (const key of [value.stateKey, value.hourKey, value.minuteKey]) {
      if (typeof key === "string" && Object.hasOwn(state, key)) {
        keys.add(key);
      }
    }
  }
  return keys;
}
function nodeConditionError(
  value: Raw,
  path: string,
  keys: Set<string>,
): PrototypeValidationError | undefined {
  const found =
    conditionError(value.visibleWhen, `${path}.visibleWhen`, keys) ??
    conditionError(value.enabledWhen, `${path}.enabledWhen`, keys);
  if (found) {
    return found;
  }
  const styles = Array.isArray(value.styleWhen) ? value.styleWhen : [];
  for (const [index, entry] of styles.entries()) {
    const found = conditionError(record(entry)?.when, `${path}.styleWhen[${index}].when`, keys);
    if (found) {
      return found;
    }
  }
  return undefined;
}
export function prototypeCheckErrors(
  nodes: Located[],
  actions: Located[],
  state: Raw,
): PrototypeValidationError | undefined {
  const keys = checkedKeys(nodes, state);
  for (const { value, path } of nodes) {
    const found = checkErrors(value, path) ?? nodeConditionError(value, path, keys);
    if (found) {
      return found;
    }
  }
  for (const { value, path } of actions) {
    if (value.requireValid === undefined) {
      continue;
    }
    const found = keyError(value.requireValid, path, keys);
    if (found) {
      return found;
    }
  }
  return undefined;
}
