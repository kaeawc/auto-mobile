import { z } from "zod";
import contract from "../../../schemas/overlay-spec-contract.json";
import { logger } from "../../utils/logger";
import { repeatErrors } from "./overlayRepeat";
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
  const selected = options.find((option) => {
    if (option.kind === "object") {
      return object(value) !== undefined;
    }
    if (option.kind === "number") {
      return typeof value === "number";
    }
    return typeof value === "string";
  });
  return selected ? walk(value, selected, path, context, depth) : fail(path, "Invalid union value");
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
    : fail(path, `Invalid ${rule.kind} value`);
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
function bindingErrors(
  context: Context,
  data: Record<string, unknown>,
): OverlayValidationError | undefined {
  const state = object(data.state) ?? {};
  for (const { value, path } of context.nodes) {
    if (typeof value.stateKey !== "string") {
      continue;
    }
    const stored = state[value.stateKey];
    if (value.type === "textField" && typeof stored !== "string") {
      return fail(`${path}.stateKey`, "Text field requires a string state key");
    }
    if ((value.type === "switch" || value.type === "checkbox") && typeof stored !== "boolean") {
      return fail(`${path}.stateKey`, "Toggle control requires a boolean state key");
    }
    if (value.type !== "tabBar" && value.type !== "bottomNav") {
      continue;
    }
    if (!numberValid(stored, { kind: "number", integer: true, min: 0 })) {
      return fail(`${path}.stateKey`, "Selection requires a nonnegative integer state key");
    }
  }
  return undefined;
}
function sheetBindingErrors(
  context: Context,
  data: Record<string, unknown>,
): OverlayValidationError | undefined {
  const state = object(data.state) ?? {};
  for (const { value, path } of context.nodes) {
    if (value.type !== "bottomSheet") {
      continue;
    }
    const condition = object(value.openWhen);
    const key = condition?.key;
    if (typeof key === "string" && Object.hasOwn(state, key) && typeof state[key] !== "boolean") {
      return fail(`${path}.openWhen.key`, "Sheet requires a boolean state key");
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
  context: Context,
  data: Record<string, unknown>,
): OverlayValidationError | undefined {
  const state = object(data.state) ?? {};
  for (const { value, path } of context.actions) {
    const rule =
      typeof value.type === "string" && Object.hasOwn(stateActionTypes, value.type)
        ? stateActionTypes[value.type]
        : undefined;
    if (rule && typeof value.key === "string" && !rule.check(state[value.key])) {
      return fail(`${path}.key`, rule.message);
    }
  }
  return undefined;
}
function validateValue(value: unknown): OverlayValidationResult {
  const context: Context = {
    nodes: [],
    actions: [],
    images: 0,
    selectorDepth: 0,
    conditionDepth: 0,
  };
  const error =
    walk(value, definitions.spec, "", context, 0) ??
    repeatErrors(value) ??
    pagerErrors(context) ??
    bindingErrors(context, object(value) ?? {}) ??
    sheetBindingErrors(context, object(value) ?? {}) ??
    stateActionErrors(context, object(value) ?? {});
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
