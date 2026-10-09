import { z } from "zod";
import contract from "../../../schemas/overlay-spec-contract.json";
import { logger } from "../../utils/logger";
import { repeatErrors, repeatKeyInstances, type KeyInstance } from "./overlayRepeat";
import { BOUND_STATE_KEY_PATTERN } from "./overlayTemplate";
import { overlaySpecSchema, type OverlaySpec, MAX_OVERLAY_SPEC_BYTES } from "./overlaySpec";

interface Rule {
  kind: string;
  name?: string;
  empty?: boolean;
  nonblank?: boolean;
  exclusive?: string[];
  exactlyOne?: string[];
  dependents?: Record<string, string[]>;
  integer?: boolean;
  min?: number;
  max?: number;
  maxBytes?: number;
  maxDepth?: number;
  unique?: boolean;
  binding?: boolean;
  atLeastOne?: boolean;
  item?: Rule;
  options?: Rule[];
  values?: string[];
  fields?: Record<string, { rule: Rule; optional: boolean }>;
  variants?: Record<string, Rule>;
}
export interface OverlayValidationError {
  path: string;
  message: string;
}
export type OverlayValidationResult =
  | { success: true; data: OverlaySpec }
  | { success: false; error: OverlayValidationError };
interface Located {
  value: Record<string, unknown>;
  path: string;
}
interface Context {
  nodes: Located[];
  actions: Located[];
  images: number;
  selectorDepth: number;
  conditionDepth: number;
}
const definitions: Record<string, Rule> = contract.definitions;
const fail = (path: string, message: string): OverlayValidationError => ({
  path: path || "$",
  message,
});
const objectSchema = z.record(z.unknown());
function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }
  const result = objectSchema.safeParse(value);
  return result.success && typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
function keyPath(path: string, key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return path ? `${path}.${key}` : key;
  }
  return `${path || "$"}[${JSON.stringify(key)}]`;
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function refRule(rule: Rule): Rule {
  return definitions[rule.name ?? ""] ?? rule;
}

/** References whose nesting is bounded by their own contract limit. */
const nestedReferences: Record<string, typeof visitReference | undefined> = Object.assign(
  Object.create(null) as Record<string, typeof visitReference | undefined>,
  { container: visitContainer, condition: visitCondition },
);

function nestedReference(rule: Rule): typeof visitReference | undefined {
  return nestedReferences[rule.name ?? ""];
}

function visitReference(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): OverlayValidationError | undefined {
  const nested = nestedReference(rule);
  if (nested) {
    return nested(value, rule, path, context, depth);
  }
  if (rule.name === "item" && typeof object(value)?.image === "string") {
    context.images++;
    if (context.images > contract.limits.MAX_OVERLAY_IMAGES) {
      return fail(`${path}.image`, "Image limit exceeded");
    }
  }
  if (rule.name !== "node") {
    return walk(value, refRule(rule), path, context, depth);
  }
  const node = object(value);
  if (!node) {
    return fail(path, "Expected object");
  }
  context.nodes.push({ value: node, path });
  if (context.nodes.length > contract.limits.MAX_OVERLAY_NODES) {
    return fail(path, "Node limit exceeded");
  }
  if (depth + 1 > contract.limits.MAX_OVERLAY_DEPTH) {
    return fail(path, "Tree depth limit exceeded");
  }
  if (node.type === "image") {
    context.images++;
  }
  if (context.images > contract.limits.MAX_OVERLAY_IMAGES) {
    return fail(path, "Image limit exceeded");
  }
  return walk(value, refRule(rule), path, context, depth + 1);
}
function visitContainer(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): OverlayValidationError | undefined {
  context.selectorDepth++;
  if (context.selectorDepth > contract.limits.MAX_OVERLAY_SELECTOR_DEPTH) {
    return fail(path, "Selector depth limit exceeded");
  }
  const error = walk(value, refRule(rule), path, context, depth);
  context.selectorDepth--;
  return error;
}
function visitCondition(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): OverlayValidationError | undefined {
  context.conditionDepth++;
  if (context.conditionDepth > contract.limits.MAX_OVERLAY_CONDITION_DEPTH) {
    return fail(path, "Condition depth limit exceeded");
  }
  const error = walk(value, refRule(rule), path, context, depth);
  context.conditionDepth--;
  return error;
}
function visitTagged(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): OverlayValidationError | undefined {
  const data = object(value);
  if (!data) {
    return fail(path, "Expected object");
  }
  const variant =
    typeof data.type === "string" && rule.variants && Object.hasOwn(rule.variants, data.type)
      ? rule.variants[data.type]
      : undefined;
  if (!variant) {
    return fail(keyPath(path, "type"), "Unknown or missing discriminator");
  }
  if (rule === definitions.action) {
    context.actions.push({ value: data, path });
  }
  return walk(data, variant, path, context, depth);
}
function visitObject(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): OverlayValidationError | undefined {
  const data = object(value);
  if (!data) {
    return fail(path, "Expected object");
  }
  const fields = rule.fields ?? {};
  const keys = [...new Set([...Object.keys(data), ...Object.keys(fields)])].sort();
  for (const key of keys) {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    const childPath = keyPath(path, key);
    if (!field) {
      return fail(childPath, "Unknown property");
    }
    if (!Object.hasOwn(data, key)) {
      if (!field.optional) {
        return fail(childPath, "Required property");
      }
      continue;
    }
    const error = walk(data[key], field.rule, childPath, context, depth);
    if (error) {
      return error;
    }
  }
  return objectConstraint(data, rule, path);
}
function objectConstraint(
  data: Record<string, unknown>,
  rule: Rule,
  path: string,
): OverlayValidationError | undefined {
  if (rule.binding && Object.hasOwn(data, "pager") === Object.hasOwn(data, "stateKey")) {
    return fail(keyPath(path, "pager"), "Exactly one of pager or stateKey is required");
  }
  if (rule.exclusive && rule.exclusive.filter((key) => Object.hasOwn(data, key)).length !== 1) {
    return fail(keyPath(path, rule.exclusive[0]), "Exactly one container selector is required");
  }
  const formError = formConstraint(data, rule, path);
  if (formError) {
    return formError;
  }
  if (rule.atLeastOne && Object.keys(data).length === 0) {
    return fail(path, "At least one selector field is required");
  }
  return undefined;
}
/** `exactlyOne` picks one form of a union-like object; `dependents` ties optional fields to a trigger. */
function formConstraint(
  data: Record<string, unknown>,
  rule: Rule,
  path: string,
): OverlayValidationError | undefined {
  if (rule.exactlyOne && rule.exactlyOne.filter((key) => Object.hasOwn(data, key)).length !== 1) {
    return fail(
      keyPath(path, rule.exactlyOne[0]),
      `Exactly one of ${rule.exactlyOne.join(", ")} is required`,
    );
  }
  for (const [trigger, dependents] of Object.entries(rule.dependents ?? {})) {
    const present = dependents.filter((key) => Object.hasOwn(data, key));
    if (!Object.hasOwn(data, trigger)) {
      if (present.length > 0) {
        return fail(keyPath(path, present[0]), `Requires ${trigger}`);
      }
    } else if (present.length !== 1) {
      const target = present[1] ?? dependents[0];
      return fail(keyPath(path, target), `Exactly one of ${dependents.join(", ")} is required`);
    }
  }
  return undefined;
}
function visitArray(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): OverlayValidationError | undefined {
  if (!Array.isArray(value)) {
    return fail(path, "Expected array");
  }
  if (value.length < (rule.min ?? 0) || value.length > (rule.max ?? Infinity)) {
    return fail(path, "Array length out of range");
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const childPath = `${path}[${index}]`;
    const error = walk(value[index], rule.item ?? { kind: "json" }, childPath, context, depth);
    if (error) {
      return error;
    }
    const canonical = JSON.stringify(value[index]);
    if (rule.unique && seen.has(canonical)) {
      return fail(childPath, "Duplicate array value");
    }
    seen.add(canonical);
  }
  return undefined;
}
function visitMap(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): OverlayValidationError | undefined {
  const data = object(value);
  if (!data) {
    return fail(path, "Expected object");
  }
  for (const key of Object.keys(data).sort()) {
    const childPath = keyPath(path, key);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
      return fail(childPath, "Invalid state key");
    }
    const error = walk(data[key], rule.item ?? { kind: "scalar" }, childPath, context, depth);
    if (error) {
      return error;
    }
  }
  return undefined;
}
function numberValid(value: unknown, rule: Rule): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!rule.integer || Number.isInteger(value)) &&
    value >= (rule.min ?? -Infinity) &&
    value <= (rule.max ?? Infinity)
  );
}
const primitiveChecks: Record<string, (value: unknown, rule: Rule) => boolean> = {
  string: (value, rule) =>
    typeof value === "string" &&
    (rule.empty === true || value.length > 0) &&
    (!rule.nonblank || value.trim().length > 0),
  key: (value) => typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value),
  boundKey: (value) => typeof value === "string" && BOUND_STATE_KEY_PATTERN.test(value),
  color: (value) => typeof value === "string" && /^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(value),
  number: numberValid,
  boolean: (value) => typeof value === "boolean",
  scalar: (value) =>
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)),
  enum: (value, rule) => typeof value === "string" && (rule.values ?? []).includes(value),
  json: (value, rule) => jsonCost(value) <= (rule.maxBytes ?? Infinity),
};
// Reserve 32 bytes per finite number so lexical exponent/decimal spellings cannot
// change payload acceptance between JavaScript and JVM JSON decoders.
function jsonCost(value: unknown, depth = 0): number {
  if (depth > contract.limits.MAX_OVERLAY_EMIT_PAYLOAD_DEPTH) {
    return Infinity;
  }
  if (value === null) {
    return 4;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? 32 : Infinity;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return bytes(value);
  }
  if (Array.isArray(value)) {
    return (
      2 +
      Math.max(0, value.length - 1) +
      value.reduce<number>((sum, child) => sum + jsonCost(child, depth + 1), 0)
    );
  }
  const data = object(value);
  if (!data) {
    return Infinity;
  }
  const entries = Object.entries(data);
  return (
    2 +
    Math.max(0, entries.length - 1) +
    entries.reduce((sum, [key, child]) => sum + bytes(key) + 1 + jsonCost(child, depth + 1), 0)
  );
}
function visitChoice(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): OverlayValidationError | undefined {
  const options = rule.options ?? [];
  const candidates = options.filter((option) => {
    if (option.kind === "object") {
      return object(value) !== undefined;
    }
    if (option.kind === "number") {
      return typeof value === "number";
    }
    return typeof value === "string";
  });
  // Several options can accept the same JSON type (a hex colour or a role name are both strings).
  let firstError: OverlayValidationError | undefined;
  for (const option of candidates) {
    const error = walk(value, option, path, context, depth);
    if (!error) {
      return undefined;
    }
    firstError ??= error;
  }
  return candidates.length > 0 ? firstError : fail(path, "Invalid union value");
}
function walk(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): OverlayValidationError | undefined {
  const handlers: Record<string, typeof visitObject> = {
    ref: visitReference,
    tagged: visitTagged,
    object: visitObject,
    array: visitArray,
    map: visitMap,
    choice: visitChoice,
  };
  const handler = handlers[rule.kind];
  if (handler) {
    return handler(value, rule, path, context, depth);
  }
  return primitiveChecks[rule.kind]?.(value, rule)
    ? undefined
    : fail(path, `Invalid ${rule.kind === "boundKey" ? "key" : rule.kind} value`);
}
function pagerErrors(context: Context): OverlayValidationError | undefined {
  const pagers = new Set<string>();
  for (const { value, path } of context.nodes) {
    if (value.type !== "pager" || typeof value.id !== "string") {
      continue;
    }
    if (pagers.has(value.id)) {
      return fail(`${path}.id`, "Duplicate pager id");
    }
    pagers.add(value.id);
  }
  for (const { value, path } of [...context.nodes, ...context.actions]) {
    if (typeof value.pager === "string" && !pagers.has(value.pager)) {
      return fail(`${path}.pager`, "Unknown pager id");
    }
  }
  return undefined;
}
/** A radio group or segmented button binds a string key to one of its unique option values. */
function radioGroupErrors(
  value: Record<string, unknown>,
  path: string,
  stored: unknown,
): OverlayValidationError | undefined {
  const name = value.type === "segmentedButton" ? "Segmented button" : "Radio group";
  if (typeof stored !== "string") {
    return fail(`${path}.stateKey`, `${name} requires a string state key`);
  }
  const values = new Set<unknown>();
  for (const [index, option] of (Array.isArray(value.options) ? value.options : []).entries()) {
    const optionValue = object(option)?.value;
    if (values.has(optionValue)) {
      return fail(`${path}.options[${index}].value`, "Duplicate radio option value");
    }
    values.add(optionValue);
  }
  return undefined;
}
/** An extended FAB (one with a label) has a single size, so `size` applies only to icon FABs. */
function fabErrors(
  value: Record<string, unknown>,
  path: string,
): OverlayValidationError | undefined {
  return typeof value.label === "string" && value.size !== undefined
    ? fail(`${path}.size`, "Extended FAB cannot set size")
    : undefined;
}
/** A bound progress indicator is determinate over 0..max (default 1); unbound is indeterminate. */
function progressErrors(
  value: Record<string, unknown>,
  path: string,
  stored: unknown,
): OverlayValidationError | undefined {
  if (typeof value.stateKey !== "string") {
    return value.max === undefined ? undefined : fail(`${path}.max`, "Requires stateKey");
  }
  const max = typeof value.max === "number" ? value.max : 1;
  if (max <= 0) {
    return fail(`${path}.max`, "Progress max must be greater than 0");
  }
  if (typeof stored !== "number" || !Number.isFinite(stored) || stored < 0 || stored > max) {
    return fail(`${path}.stateKey`, "Progress requires a numeric state key within 0 and max");
  }
  return undefined;
}
/** A time picker binds two distinct integer keys: hour 0..23 and minute 0..59. */
function timePickerErrors(
  value: Record<string, unknown>,
  path: string,
  state: Record<string, unknown>,
): OverlayValidationError | undefined {
  const fields = [
    { field: "hourKey", max: 23, message: "Time picker hour requires an integer 0..23 state key" },
    {
      field: "minuteKey",
      max: 59,
      message: "Time picker minute requires an integer 0..59 state key",
    },
  ];
  for (const { field, max, message } of fields) {
    const key = value[field];
    const stored = typeof key === "string" ? state[key] : undefined;
    if (!numberValid(stored, { kind: "number", integer: true, min: 0, max })) {
      return fail(`${path}.${field}`, message);
    }
  }
  return value.hourKey === value.minuteKey
    ? fail(`${path}.minuteKey`, "Time picker hour and minute keys must differ")
    : undefined;
}
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** A `YYYY-MM-DD` calendar date in 1900..2100, the Material date picker's year range. */
function isOverlayDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
  return year >= 1900 && year <= 2100 && days !== undefined && day >= 1 && day <= days;
}
/** A list item's trailing switch or checkbox binds a boolean, like the standalone controls. */
function listItemBindingErrors(
  checked: Checked,
  data: Record<string, unknown>,
): OverlayValidationError | undefined {
  const state = object(data.state) ?? {};
  for (const { value, path, item } of checked.nodes) {
    const trailing = value.type === "listItem" ? object(value.trailing) : undefined;
    if (
      trailing &&
      typeof trailing.stateKey === "string" &&
      typeof state[trailing.stateKey] !== "boolean"
    ) {
      return forItem(
        fail(`${path}.trailing.stateKey`, "Toggle control requires a boolean state key"),
        item,
      );
    }
  }
  return undefined;
}
function stepFitsRange(step: number, range: number): boolean {
  const count = range / step;
  return step > 0 && count >= 1 && Math.abs(count - Math.round(count)) < 1e-9;
}
/** Slider range, step and bound-value checks; the contract only types the individual fields. */
function sliderErrors(
  value: Record<string, unknown>,
  path: string,
  stored: unknown,
): OverlayValidationError | undefined {
  const { min, max, step } = value;
  if (typeof min !== "number" || typeof max !== "number" || min >= max) {
    return fail(`${path}.max`, "Slider max must be greater than min");
  }
  if (typeof step === "number" && !stepFitsRange(step, max - min)) {
    return fail(`${path}.step`, "Slider step must be positive and divide the range evenly");
  }
  if (typeof stored !== "number" || !Number.isFinite(stored) || stored < min || stored > max) {
    return fail(`${path}.stateKey`, "Slider requires a numeric state key within min and max");
  }
  return undefined;
}
/** A filter chip is a boolean toggle; an assist chip only runs its actions. */
function chipErrors(
  value: Record<string, unknown>,
  path: string,
  stored: unknown,
): OverlayValidationError | undefined {
  const bound = typeof value.stateKey === "string";
  if (value.variant === "filter" && !bound) {
    return fail(`${path}.stateKey`, "Filter chip requires a boolean state key");
  }
  if (value.variant !== undefined && value.variant !== "filter" && bound) {
    return fail(`${path}.stateKey`, "Only a filter chip can bind a state key");
  }
  if (bound && typeof stored !== "boolean") {
    return fail(`${path}.stateKey`, "Filter chip requires a boolean state key");
  }
  return undefined;
}
function componentBindingErrors(
  value: Record<string, unknown>,
  path: string,
  state: Record<string, unknown>,
): OverlayValidationError | undefined {
  const stored = typeof value.stateKey === "string" ? state[value.stateKey] : undefined;
  if (value.type === "textField" && typeof stored !== "string") {
    return fail(`${path}.stateKey`, "Text field requires a string state key");
  }
  if ((value.type === "switch" || value.type === "checkbox") && typeof stored !== "boolean") {
    return fail(`${path}.stateKey`, "Toggle control requires a boolean state key");
  }
  if (value.type === "slider") {
    return sliderErrors(value, path, stored);
  }
  return componentFormErrors(value, path, stored, state);
}
function componentFormErrors(
  value: Record<string, unknown>,
  path: string,
  stored: unknown,
  state: Record<string, unknown>,
): OverlayValidationError | undefined {
  switch (value.type) {
    case "radioGroup":
    case "segmentedButton":
      return radioGroupErrors(value, path, stored);
    case "chip":
      return chipErrors(value, path, stored);
    case "fab":
      return fabErrors(value, path);
    case "progress":
      return progressErrors(value, path, stored);
    case "timePicker":
      return timePickerErrors(value, path, state);
    case "datePicker":
      return isOverlayDate(stored)
        ? undefined
        : fail(`${path}.stateKey`, "Date picker requires a YYYY-MM-DD state key in 1900..2100");
    default:
      return undefined;
  }
}
function bindingErrors(
  checked: Checked,
  data: Record<string, unknown>,
): OverlayValidationError | undefined {
  const state = object(data.state) ?? {};
  for (const { value, path, item } of checked.nodes) {
    const component = componentBindingErrors(value, path, state);
    if (component) {
      return forItem(component, item);
    }
    if (typeof value.stateKey !== "string") {
      continue;
    }
    const stored = state[value.stateKey];
    if (value.type !== "tabBar" && value.type !== "bottomNav") {
      continue;
    }
    if (!numberValid(stored, { kind: "number", integer: true, min: 0 })) {
      return forItem(
        fail(`${path}.stateKey`, "Selection requires a nonnegative integer state key"),
        item,
      );
    }
  }
  return undefined;
}
/** Nodes opened by a boolean `openWhen` key; an existing key must hold a boolean. */
const MODAL_NAMES: Record<string, string | undefined> = {
  bottomSheet: "Sheet",
  dialog: "Dialog",
  snackbar: "Snackbar",
};
function sheetBindingErrors(
  checked: Checked,
  data: Record<string, unknown>,
): OverlayValidationError | undefined {
  const state = object(data.state) ?? {};
  for (const { value, path, item } of checked.nodes) {
    const type = String(value.type);
    const name = Object.hasOwn(MODAL_NAMES, type) ? MODAL_NAMES[type] : undefined;
    if (name === undefined) {
      continue;
    }
    const condition = object(value.openWhen);
    const key = condition?.key;
    if (typeof key === "string" && Object.hasOwn(state, key) && typeof state[key] !== "boolean") {
      return forItem(fail(`${path}.openWhen.key`, `${name} requires a boolean state key`), item);
    }
  }
  return undefined;
}
const stateActionTypes: Record<string, { check: (stored: unknown) => boolean; message: string }> = {
  toggle: {
    check: (stored) => typeof stored === "boolean",
    message: "Toggle requires a boolean state key",
  },
  increment: {
    check: (stored) => typeof stored === "number" && Number.isFinite(stored),
    message: "Increment requires a numeric state key",
  },
  decrement: {
    check: (stored) => typeof stored === "number" && Number.isFinite(stored),
    message: "Decrement requires a numeric state key",
  },
};
function stateActionErrors(
  checked: Checked,
  data: Record<string, unknown>,
): OverlayValidationError | undefined {
  const state = object(data.state) ?? {};
  for (const { value, path, item } of checked.actions) {
    const rule =
      typeof value.type === "string" && Object.hasOwn(stateActionTypes, value.type)
        ? stateActionTypes[value.type]
        : undefined;
    if (rule && typeof value.key === "string" && !rule.check(state[value.key])) {
      return forItem(fail(`${path}.key`, rule.message), item);
    }
  }
  return undefined;
}
/** A node or action as the state-type checks see it: keys bound for one repeat item, if any. */
interface Bound {
  value: Record<string, unknown>;
  path: string;
  item?: number;
}
interface Checked {
  nodes: Bound[];
  actions: Bound[];
}
function forItem(error: OverlayValidationError, item: number | undefined): OverlayValidationError {
  return item === undefined
    ? error
    : { ...error, message: `${error.message} (repeat item ${item})` };
}
const bound = ({ located, value, item }: KeyInstance<Located>): Bound => ({
  value,
  path: located.path,
  item,
});
/** State-type checks over every repeat instance: a templated key is checked once per item. */
function stateTypeErrors(
  value: unknown,
  context: Context,
  data: Record<string, unknown>,
): OverlayValidationError | undefined {
  const checked: Checked = {
    nodes: repeatKeyInstances(value, context.nodes).map(bound),
    actions: repeatKeyInstances(value, context.actions).map(bound),
  };
  return (
    bindingErrors(checked, data) ??
    listItemBindingErrors(checked, data) ??
    sheetBindingErrors(checked, data) ??
    stateActionErrors(checked, data)
  );
}
function validateValue(value: unknown): OverlayValidationResult {
  const context: Context = {
    nodes: [],
    actions: [],
    images: 0,
    selectorDepth: 0,
    conditionDepth: 0,
  };
  const data = object(value) ?? {};
  const error =
    walk(value, definitions.spec, "", context, 0) ??
    repeatErrors(value) ??
    pagerErrors(context) ??
    stateTypeErrors(value, context, data);
  if (error) {
    return { success: false, error };
  }
  const parsed = overlaySpecSchema.safeParse(value);
  if (!parsed.success) {
    return { success: false, error: fail("$", "Internal schema/contract mismatch") };
  }
  return { success: true, data: parsed.data };
}
/** Raw JSON strings measure transmitted UTF-8 bytes; object input measures compact JSON bytes. */
export function validateOverlaySpec(json: unknown): OverlayValidationResult {
  try {
    const input = typeof json === "string" ? json : JSON.stringify(json);
    if (input === undefined) {
      return { success: false, error: fail("$", "Expected JSON") };
    }
    if (Buffer.byteLength(input, "utf8") > MAX_OVERLAY_SPEC_BYTES) {
      return { success: false, error: fail("$", "Spec byte limit exceeded") };
    }
    return validateValue(typeof json === "string" ? JSON.parse(input) : json);
  } catch (error) {
    logger.warn("Overlay JSON could not be decoded", error);
    return { success: false, error: fail("$", "Invalid JSON") };
  }
}
