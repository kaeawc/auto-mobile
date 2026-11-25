import { PROTOTYPE_LARGE_BUDGET_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { expandPrototypeComponents } from "./prototypeComponents";
import { resolvePrototypeDataPointer } from "./prototypeData";
import { PROTOTYPE_DATA_ACTION_TYPES } from "./prototypeDataActionTypes";
import { jsonCost } from "./prototypeJsonCost";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import {
  prototypeBaseRuntimeBudget,
  prototypeLargeRuntimeBudget,
} from "./prototypeRenderContract.generated";
import { record } from "./prototypeTemplate";

// Zod-free and read from the generated contract values, so the web library can check a bare spec
// against the base budget in the browser (#16453).

/**
 * The contract limits a runtime budget can raise (#18804). The contract's `runtimeBudgets` table
 * is the only place their raised values live; every other limit is the same in every runtime.
 */
export type PrototypeBudgetLimit = keyof typeof prototypeLargeRuntimeBudget;

/** The limits one runtime validates a spec against. */
export type PrototypeRuntimeBudget = Readonly<Record<PrototypeBudgetLimit, number>>;

const LARGE: PrototypeRuntimeBudget = prototypeLargeRuntimeBudget;

/** Today's limits: the overlay, the iOS agent and any runtime without a budget capability. */
export const PROTOTYPE_BASE_BUDGET: PrototypeRuntimeBudget = prototypeBaseRuntimeBudget;

/** An activity-hosted runtime advertising `prototype_large_budget_v1`. */
export const PROTOTYPE_LARGE_BUDGET: PrototypeRuntimeBudget = LARGE;

export function isPrototypeBudgetLimit(name: string): name is PrototypeBudgetLimit {
  return Object.hasOwn(LARGE, name);
}

/** A `maxLimit` rule's bound is the budget's value of that limit; `max` is the base value. */
export function prototypeBudgetRule<R extends { max?: number; maxLimit?: string }>(
  rule: R,
  limits: PrototypeRuntimeBudget,
): R {
  return rule.maxLimit !== undefined && isPrototypeBudgetLimit(rule.maxLimit)
    ? { ...rule, max: limits[rule.maxLimit] }
    : rule;
}

/** The budget of a runtime advertising `capabilities`; no capabilities is the base budget. */
export function prototypeRuntimeBudget(
  capabilities: Iterable<string> | undefined,
): PrototypeRuntimeBudget {
  return capabilities && new Set(capabilities).has(PROTOTYPE_LARGE_BUDGET_CAPABILITY)
    ? PROTOTYPE_LARGE_BUDGET
    : PROTOTYPE_BASE_BUDGET;
}

function oversizedArrays(value: unknown, path: string, fields: string[]): void {
  if (Array.isArray(value)) {
    if (value.length > PROTOTYPE_BASE_BUDGET.MAX_PROTOTYPE_DATA_ARRAY_ITEMS) {
      fields.push(path);
    }
    for (const [index, child] of value.entries()) {
      oversizedArrays(child, `${path}[${index}]`, fields);
    }
    return;
  }
  const object = record(value);
  for (const key of Object.keys(object ?? {}).sort()) {
    oversizedArrays(object?.[key], `${path}.${key}`, fields);
  }
}

function oversizedLists(spec: unknown, fields: string[]): void {
  const data = record(spec)?.data;
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type !== "list") {
      return;
    }
    if (
      typeof node.maxItems === "number" &&
      node.maxItems > PROTOTYPE_BASE_BUDGET.MAX_PROTOTYPE_LIST_ITEMS
    ) {
      fields.push(`${path}.maxItems`);
    }
    const pointer = record(record(node.repeat)?.items)?.path;
    const items = typeof pointer === "string" ? resolvePrototypeDataPointer(data, pointer) : [];
    if (Array.isArray(items) && items.length > PROTOTYPE_BASE_BUDGET.MAX_PROTOTYPE_LIST_ITEMS) {
      fields.push(`${path}.repeat.items.path`);
    }
  });
}

const WINDOWED_DATA_ACTIONS = new Set(["appendData", "upsertData"]);
/**
 * Opaque JSON no action sits in: the data model, state, emit payloads and any `value` (a literal or
 * binding on a data action, setState or emit context; a data action's literal is size-checked by
 * `oversizedDataAction`).
 */
const OPAQUE_FIELDS = new Set(["data", "state", "payload", "value"]);

function oversizedActionWindows(value: unknown, path: string, fields: string[]): void {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      oversizedActionWindows(child, `${path}[${index}]`, fields);
    }
    return;
  }
  const object = record(value);
  if (!object) {
    return;
  }
  oversizedDataAction(object, path, fields);
  for (const key of Object.keys(object).sort()) {
    if (!OPAQUE_FIELDS.has(key)) {
      oversizedActionWindows(object[key], path ? `${path}.${key}` : key, fields);
    }
  }
}

/** A data action whose window or literal value is over the base budget. */
function oversizedDataAction(
  action: Record<string, unknown>,
  path: string,
  fields: string[],
): void {
  const type = typeof action.type === "string" ? action.type : "";
  if (
    WINDOWED_DATA_ACTIONS.has(type) &&
    typeof action.maxItems === "number" &&
    action.maxItems > PROTOTYPE_BASE_BUDGET.MAX_PROTOTYPE_DATA_ARRAY_ITEMS
  ) {
    fields.push(`${path}.maxItems`);
  }
  if (PROTOTYPE_DATA_ACTION_TYPES.some((name) => name === type)) {
    oversizedLiteral(record(action.value), `${path}.value.value`, fields);
  }
}

/**
 * A data action's `{value: literal}` is checked like data (`{value: literal}` against the data byte
 * and array limits), so a literal over the base budget needs the large budget too.
 */
function oversizedLiteral(
  binding: Record<string, unknown> | undefined,
  path: string,
  fields: string[],
): void {
  if (!binding || !Object.hasOwn(binding, "value")) {
    return;
  }
  const before = fields.length;
  oversizedArrays(binding.value, path, fields);
  if (
    fields.length === before &&
    jsonCost({ value: binding.value }) > PROTOTYPE_BASE_BUDGET.MAX_PROTOTYPE_DATA_BYTES
  ) {
    fields.push(path);
  }
}

const utf8 = new TextEncoder();

function specBytes(spec: unknown): number {
  return utf8.encode(JSON.stringify(spec) ?? "").byteLength;
}

/**
 * Where a spec is over the base budget, so only a runtime advertising
 * `prototype_large_budget_v1` can show it: `$` for spec bytes (authored or expanded), `data` for
 * data bytes, each oversized `/data` array, each list whose items or `maxItems` exceed the base
 * list limit, each `appendData`/`upsertData` whose `maxItems` exceeds the base array limit and
 * each data action literal (`value.value`) over the base data byte or array limits.
 * Paths are those of the component-expanded spec the validator checks.
 */
export function prototypeLargeBudgetFields(spec: unknown): string[] {
  const fields: string[] = [];
  const expansion = expandPrototypeComponents(spec);
  const expanded = expansion.success ? expansion.spec : spec;
  const bytes = Math.max(
    specBytes(spec),
    expansion.success && expansion.expanded ? specBytes(expanded) : 0,
  );
  if (bytes > PROTOTYPE_BASE_BUDGET.MAX_PROTOTYPE_SPEC_BYTES) {
    fields.push("$");
  }
  const data = record(expanded)?.data;
  if (data !== undefined && jsonCost(data) > PROTOTYPE_BASE_BUDGET.MAX_PROTOTYPE_DATA_BYTES) {
    fields.push("data");
  }
  oversizedArrays(data, "data", fields);
  oversizedLists(expanded, fields);
  oversizedActionWindows(expanded, "", fields);
  return [...new Set(fields)];
}

export function prototypeLargeBudgetUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const runtime = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const base = PROTOTYPE_BASE_BUDGET;
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${runtime} does not advertise ${PROTOTYPE_LARGE_BUDGET_CAPABILITY}, so it keeps the base budget (${base.MAX_PROTOTYPE_LIST_ITEMS} list items, ${base.MAX_PROTOTYPE_SPEC_BYTES} spec bytes, ${base.MAX_PROTOTYPE_DATA_BYTES} data bytes), which ${fields[0]}${more} exceeds. Nothing was shown. Show it in a disposable app or ProtoViewer, or shrink the data.`;
}
