import { z } from "zod";
import { type KeyInstance } from "./prototypeRepeat";
import { prototypeRequestStatusKeyError } from "./prototypeRequest";

export interface Rule {
  kind: string;
  pattern?: string;
  name?: string;
  empty?: boolean;
  nonblank?: boolean;
  exclusive?: string[];
  exactlyOne?: string[];
  atMostOne?: string[];
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
  values?: (string | boolean)[];
  maxEntries?: number;
  keyPattern?: string;
  fields?: Record<string, { rule: Rule; optional: boolean } | undefined>;
  variants?: Record<string, Rule>;
}

export interface PrototypeValidationError {
  path: string;
  message: string;
}

export interface Located {
  value: Record<string, unknown>;
  path: string;
}

export const fail = (path: string, message: string): PrototypeValidationError => ({
  path: path || "$",
  message,
});

const objectSchema = z.record(z.unknown());

export function object(value: unknown): Record<string, unknown> | undefined {
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

export function numberValid(value: unknown, rule: Rule): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!rule.integer || Number.isInteger(value)) &&
    value >= (rule.min ?? -Infinity) &&
    value <= (rule.max ?? Infinity)
  );
}

/** A radio group or segmented button binds a string key to one of its unique option values. */
function radioGroupErrors(
  value: Record<string, unknown>,
  path: string,
  stored: unknown,
): PrototypeValidationError | undefined {
  const name =
    value.type === "select"
      ? "Select"
      : value.type === "segmentedButton"
        ? "Segmented button"
        : "Radio group";
  if (typeof stored !== "string") {
    return fail(`${path}.stateKey`, `${name} requires a string state key`);
  }
  const values = new Set<unknown>();
  for (const [index, option] of (Array.isArray(value.options) ? value.options : []).entries()) {
    const optionValue = object(option)?.value;
    if (values.has(optionValue)) {
      return fail(
        `${path}.options[${index}].value`,
        value.type === "select" ? "Duplicate select option value" : "Duplicate radio option value",
      );
    }
    values.add(optionValue);
  }
  return undefined;
}

/** An extended FAB (one with a label) has a single size, so `size` applies only to icon FABs. */
function fabErrors(
  value: Record<string, unknown>,
  path: string,
): PrototypeValidationError | undefined {
  return typeof value.label === "string" && value.size !== undefined
    ? fail(`${path}.size`, "Extended FAB cannot set size")
    : undefined;
}

/** A bound progress indicator is determinate over 0..max (default 1); unbound is indeterminate. */
function progressErrors(
  value: Record<string, unknown>,
  path: string,
  stored: unknown,
): PrototypeValidationError | undefined {
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
): PrototypeValidationError | undefined {
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
function isPrototypeDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
  return year >= 1900 && year <= 2100 && days !== undefined && day >= 1 && day <= days;
}

/** A list item's trailing switch or checkbox binds a boolean, like the standalone controls. */
function trailingErrors(
  value: Record<string, unknown>,
  path: string,
  state: Record<string, unknown>,
): PrototypeValidationError | undefined {
  const trailing = value.type === "listItem" ? object(value.trailing) : undefined;
  return trailing &&
    typeof trailing.stateKey === "string" &&
    typeof state[trailing.stateKey] !== "boolean"
    ? fail(`${path}.trailing.stateKey`, "Toggle control requires a boolean state key")
    : undefined;
}

export function listItemBindingErrors(
  checked: Checked,
  data: Record<string, unknown>,
): PrototypeValidationError | undefined {
  const state = object(data.state) ?? {};
  for (const { value, path, item } of checked.nodes) {
    const error = trailingErrors(value, path, state);
    if (error) {
      return forItem(error, item);
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
): PrototypeValidationError | undefined {
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
): PrototypeValidationError | undefined {
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

/** Text field option relationships and the initial bound value; individual fields are contract-typed. */
/** The rules tying `multiline` to the other text field options. */
function multilineErrors(
  value: Record<string, unknown>,
  path: string,
): PrototypeValidationError | undefined {
  const lineField = ["minLines", "maxLines"].find((field) => value[field] !== undefined);
  if (value.multiline !== true) {
    return lineField === undefined
      ? undefined
      : fail(`${path}.${lineField}`, "Requires multiline: true");
  }
  if (value.secure === true || value.keyboardType === "password") {
    return fail(`${path}.multiline`, "Multiline text cannot be secure");
  }
  const imeField = ["imeAction", "onSubmit"].find((field) => value[field] !== undefined);
  return imeField === undefined
    ? undefined
    : fail(`${path}.${imeField}`, "Multiline text has no IME action");
}

function textFieldErrors(
  value: Record<string, unknown>,
  path: string,
  stored: unknown,
): PrototypeValidationError | undefined {
  const { minLines, maxLines, maxLength } = value;
  const multiline = multilineErrors(value, path);
  if (multiline) {
    return multiline;
  }
  if (typeof minLines === "number" && typeof maxLines === "number" && minLines > maxLines) {
    return fail(`${path}.minLines`, "minLines cannot exceed maxLines");
  }
  if (typeof stored === "string" && typeof maxLength === "number" && stored.length > maxLength) {
    return fail(`${path}.stateKey`, "Text field value exceeds maxLength");
  }
  return undefined;
}

function componentBindingErrors(
  value: Record<string, unknown>,
  path: string,
  state: Record<string, unknown>,
): PrototypeValidationError | undefined {
  const stored = typeof value.stateKey === "string" ? state[value.stateKey] : undefined;
  if ((value.type === "textField" || value.type === "searchBar") && typeof stored !== "string") {
    return fail(`${path}.stateKey`, "Text field requires a string state key");
  }
  if (
    value.type === "searchBar" &&
    typeof value.activeKey === "string" &&
    typeof state[value.activeKey] !== "boolean"
  ) {
    return fail(`${path}.activeKey`, "Search bar requires a boolean active key");
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
): PrototypeValidationError | undefined {
  switch (value.type) {
    case "textField":
      return textFieldErrors(value, path, stored);
    case "select":
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
      return isPrototypeDate(stored)
        ? undefined
        : fail(`${path}.stateKey`, "Date picker requires a YYYY-MM-DD state key in 1900..2100");
    default:
      return undefined;
  }
}

/** A tab bar or bottom navigation bound to a state key selects a nonnegative integer index. */
function selectionErrors(
  value: Record<string, unknown>,
  path: string,
  state: Record<string, unknown>,
): PrototypeValidationError | undefined {
  if (
    typeof value.stateKey !== "string" ||
    (value.type !== "tabBar" && value.type !== "bottomNav" && value.type !== "pager")
  ) {
    return undefined;
  }
  return numberValid(state[value.stateKey], { kind: "number", integer: true, min: 0 })
    ? undefined
    : fail(`${path}.stateKey`, "Selection requires a nonnegative integer state key");
}

export function bindingErrors(
  checked: Checked,
  data: Record<string, unknown>,
): PrototypeValidationError | undefined {
  const state = object(data.state) ?? {};
  for (const { value, path, item } of checked.nodes) {
    const error = componentBindingErrors(value, path, state) ?? selectionErrors(value, path, state);
    if (error) {
      return forItem(error, item);
    }
  }
  return undefined;
}

/** Nodes opened by a boolean `openWhen` key; an existing key must hold a boolean. */
const MODAL_NAMES: Record<string, string | undefined> = {
  tooltip: "Tooltip",
  drawer: "Drawer",
  bottomSheet: "Sheet",
  dialog: "Dialog",
  menu: "Menu",
  snackbar: "Snackbar",
};

function openWhenErrors(
  value: Record<string, unknown>,
  path: string,
  state: Record<string, unknown>,
): PrototypeValidationError | undefined {
  const type = String(value.type);
  const name = Object.hasOwn(MODAL_NAMES, type) ? MODAL_NAMES[type] : undefined;
  const key = name === undefined ? undefined : object(value.openWhen)?.key;
  return typeof key === "string" && Object.hasOwn(state, key) && typeof state[key] !== "boolean"
    ? fail(`${path}.openWhen.key`, `${name} requires a boolean state key`)
    : undefined;
}

/** Pull-to-refresh needs a vertical scroll, and its declared key must hold a boolean. */
function refreshErrors(
  value: Record<string, unknown>,
  path: string,
  state: Record<string, unknown>,
): PrototypeValidationError | undefined {
  const refresh = ["scroll", "list"].includes(String(value.type))
    ? object(value.refresh)
    : undefined;
  if (!refresh) {
    return undefined;
  }
  if (value.axis === "horizontal") {
    return fail(`${path}.refresh`, `Pull-to-refresh needs a vertical ${value.type}`);
  }
  const key = refresh.stateKey;
  return typeof key === "string" &&
    (Object.hasOwn(state, key) || value.type === "list") &&
    typeof state[key] !== "boolean"
    ? fail(`${path}.refresh.stateKey`, "Refresh requires a boolean state key")
    : undefined;
}

/** A chat scroll's `atEndKey` (#14232) must name a declared boolean state key. */
function atEndKeyErrors(
  value: Record<string, unknown>,
  path: string,
  state: Record<string, unknown>,
): PrototypeValidationError | undefined {
  const key = value.type === "scroll" ? value.atEndKey : undefined;
  return typeof key === "string" && (!Object.hasOwn(state, key) || typeof state[key] !== "boolean")
    ? fail(`${path}.atEndKey`, "atEndKey must name a declared boolean state key")
    : undefined;
}

export function sheetBindingErrors(
  checked: Checked,
  data: Record<string, unknown>,
): PrototypeValidationError | undefined {
  const state = object(data.state) ?? {};
  for (const { value, path, item } of checked.nodes) {
    const error =
      openWhenErrors(value, path, state) ??
      refreshErrors(value, path, state) ??
      atEndKeyErrors(value, path, state);
    if (error) {
      return forItem(error, item);
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

/** Every state key a node binds: `stateKey`, time picker keys, a trailing control, `openWhen`. */
function boundKeys(value: Record<string, unknown>): string[] {
  const keys = [
    value.stateKey,
    value.activeKey,
    value.hourKey,
    value.minuteKey,
    object(value.trailing)?.stateKey,
    ["scroll", "list"].includes(String(value.type)) ? object(value.refresh)?.stateKey : undefined,
    value.type === "scroll" ? value.atEndKey : undefined,
  ];
  const openWhen = Object.hasOwn(MODAL_NAMES, String(value.type))
    ? object(value.openWhen)
    : undefined;
  return [...keys, openWhen?.key].filter((key): key is string => typeof key === "string");
}

/** First binding rule the node breaks; the same rules that check the declared state. */
function controlErrors(
  value: Record<string, unknown>,
  path: string,
  state: Record<string, unknown>,
): PrototypeValidationError | undefined {
  return (
    componentBindingErrors(value, path, state) ??
    selectionErrors(value, path, state) ??
    trailingErrors(value, path, state) ??
    openWhenErrors(value, path, state) ??
    refreshErrors(value, path, state) ??
    atEndKeyErrors(value, path, state)
  );
}

/**
 * A `setState` must leave every control bound to its key valid, so the key is checked as if the
 * value were the declared state (#11452). A key no control binds, a key bound by controls of
 * different types, and a repeat-templated value are not checked.
 */
function setStateBindingErrors(
  action: Bound,
  checked: Checked,
  state: Record<string, unknown>,
): PrototypeValidationError | undefined {
  const { key, value } = action.value;
  if (typeof key !== "string" || action.operandTemplated || value === undefined) {
    return undefined;
  }
  const controls = checked.nodes.filter((node) => boundKeys(node.value).includes(key));
  if (new Set(controls.map((node) => String(node.value.type))).size !== 1) {
    return undefined;
  }
  // A linkify `{match}` (#14233) writes the matched text, so it is checked as a string.
  const match = object(value) !== undefined && typeof object(value)?.match === "string";
  const written = { ...state, [key]: match ? "" : value };
  for (const control of controls) {
    const error = controlErrors(control.value, control.path, written);
    if (error) {
      return fail(
        `${action.path}.value`,
        `setState value does not fit the control bound to "${key}": ${error.message}`,
      );
    }
  }
  return undefined;
}

export function stateActionErrors(
  checked: Checked,
  data: Record<string, unknown>,
): PrototypeValidationError | undefined {
  const state = object(data.state) ?? {};
  for (const action of checked.actions) {
    const { value, path, item } = action;
    const rule =
      typeof value.type === "string" && Object.hasOwn(stateActionTypes, value.type)
        ? stateActionTypes[value.type]
        : undefined;
    if (rule && typeof value.key === "string" && !rule.check(state[value.key])) {
      return forItem(fail(`${path}.key`, rule.message), item);
    }
    const written =
      value.type === "setState"
        ? setStateBindingErrors(action, checked, state)
        : prototypeRequestStatusKeyError(value, path, state);
    if (written) {
      return forItem(written, item);
    }
  }
  return undefined;
}

/** A node or action as the state-type checks see it: keys bound for one repeat item, if any. */
interface Bound {
  value: Record<string, unknown>;
  path: string;
  item?: number;
  /** An action whose `value` holds a repeat placeholder: its type is not known statically. */
  operandTemplated?: boolean;
}

export interface Checked {
  nodes: Bound[];
  actions: Bound[];
}

function forItem(
  error: PrototypeValidationError,
  item: number | undefined,
): PrototypeValidationError {
  return item === undefined
    ? error
    : { ...error, message: `${error.message} (repeat item ${item})` };
}

export const bound = ({ located, value, item, operandTemplated }: KeyInstance<Located>): Bound => ({
  value,
  path: located.path,
  item,
  operandTemplated,
});
