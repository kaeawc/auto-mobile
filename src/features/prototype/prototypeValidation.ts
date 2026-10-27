import { prototypeStylePolishV2ObjectError } from "./prototypeStylePolishV2";
import { prototypeDerivedError } from "./prototypeDerivedValidation";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { prototypeStrictPolicyError, type PrototypeStrictOptions } from "./prototypeStrictPolicy";
import { prototypeStrictJson } from "./prototypeStrictJson";
import { prototypeCheckErrors } from "./prototypeCheckValidation";
import contract from "../../../schemas/prototype-spec-contract.json";
import { logger } from "../../utils/logger";
import { expandPrototypeComponents } from "./prototypeComponents";
import { prototypeLazyListError, prototypeLazyListLimitError } from "./prototypeLazyList";
import { imageSlotUses, repeatErrors, repeatKeyInstances } from "./prototypeRepeat";
import { isPrototypeDataPointer, PrototypeRepeatData } from "./prototypeData";
import { prototypeDataActionsError } from "./prototypeDataActions";
import { prototypeTimersError, prototypeTimerActions } from "./prototypeTimers";
import { prototypeStorageError } from "./prototypeStorage";
import { prototypeStringsError, prototypeStringsTableError } from "./prototypeStrings";
import { prototypeLoadingStatesError } from "./prototypeLoadingStates";
import { prototypeChoreographyError } from "./prototypeChoreography";
import { prototypeMotionV2Error } from "./prototypeMotionV2";
import { prototypeChartError } from "./prototypeChart";
import { prototypeRequestsError } from "./prototypeRequest";
import { prototypePlatformError, prototypeReservedTestTagError } from "./prototypePlatform";
import { prototypeLinkifyError } from "./prototypeLinkify";
import { prototypeTooltipError } from "./prototypeTooltip";
import { prototypeChatScrollError } from "./prototypeChatScroll";
import { BOUND_STATE_KEY_PATTERN } from "./prototypeTemplate";
import { effectUses } from "./prototypeEffects";
import { prototypeSpecSchema, type PrototypeSpec, MAX_PROTOTYPE_SPEC_BYTES } from "./prototypeSpec";
import {
  Rule,
  PrototypeValidationError,
  Located,
  fail,
  object,
  numberValid,
  listItemBindingErrors,
  bindingErrors,
  sheetBindingErrors,
  stateActionErrors,
  Checked,
  bound,
} from "./prototypeBindingValidation";
export { type PrototypeValidationError } from "./prototypeBindingValidation";

export type PrototypeValidationResult =
  | { success: true; data: PrototypeSpec }
  | { success: false; error: PrototypeValidationError };
interface Context {
  nodes: Located[];
  actions: Located[];
  images: number;
  effects: number;
  animatedEffects: number;
  /** Current nesting per bounded reference (see `nestedReferences`). */
  nesting: Record<string, number>;
}
const definitions: Record<string, Rule> = contract.definitions;
function keyPath(path: string, key: string): string {
  if (prototypeContractPatterns.pathKey.test(key)) {
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

/** References whose nesting is bounded by their own contract limit. A request nests actions. */
const nestedReferences = Object.assign(
  Object.create(null) as Record<string, { limit: number; message: string } | undefined>,
  {
    container: {
      limit: contract.limits.MAX_PROTOTYPE_SELECTOR_DEPTH,
      message: "Selector depth limit exceeded",
    },
    condition: {
      limit: contract.limits.MAX_PROTOTYPE_CONDITION_DEPTH,
      message: "Condition depth limit exceeded",
    },
    action: {
      limit: contract.limits.MAX_PROTOTYPE_ACTION_DEPTH,
      message: "Action nesting limit exceeded",
    },
  },
);

function visitReference(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): PrototypeValidationError | undefined {
  const nested = nestedReferences[String(rule.name)];
  if (nested) {
    return visitNested(value, rule, path, context, depth, nested);
  }
  const itemImages = rule.name === "item" ? imageSlotUses(object(value)?.image) : 0;
  if (itemImages > 0) {
    context.images += itemImages;
    if (context.images > contract.limits.MAX_PROTOTYPE_IMAGES) {
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
  if (context.nodes.length > contract.limits.MAX_PROTOTYPE_NODES) {
    return fail(path, "Node limit exceeded");
  }
  if (depth + 1 > contract.limits.MAX_PROTOTYPE_DEPTH) {
    return fail(path, "Tree depth limit exceeded");
  }
  const budgetError = chargeNodeBudgets(node, path, context);
  if (budgetError) {
    return budgetError;
  }
  return walk(value, refRule(rule), path, context, depth + 1);
}
/** Adds a node's images and `style.effects` to the spec-wide totals; the node that crosses a limit is reported. */
function chargeNodeBudgets(
  node: Record<string, unknown>,
  path: string,
  context: Context,
): PrototypeValidationError | undefined {
  if (node.type === "image") {
    context.images += Math.max(1, imageSlotUses(node.asset));
  }
  if (context.images > contract.limits.MAX_PROTOTYPE_IMAGES) {
    return fail(path, "Image limit exceeded");
  }
  const uses = effectUses(node);
  context.effects += uses.total;
  context.animatedEffects += uses.animated;
  if (context.effects > contract.limits.MAX_PROTOTYPE_EFFECTS) {
    return fail(path, "Effect limit exceeded");
  }
  return context.animatedEffects > contract.limits.MAX_PROTOTYPE_ANIMATED_EFFECTS
    ? fail(path, "Animated effect limit exceeded")
    : undefined;
}
function visitNested(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
  nested: { limit: number; message: string },
): PrototypeValidationError | undefined {
  const name = rule.name ?? "";
  if (++context.nesting[name] > nested.limit) {
    return fail(path, nested.message);
  }
  const error = walk(value, refRule(rule), path, context, depth);
  context.nesting[name]--;
  return error;
}
function visitTagged(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): PrototypeValidationError | undefined {
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
/** Text's two content forms and its span count are pinned by the shared contract. */
function textNodeConstraint(
  data: Record<string, unknown>,
  rule: Rule,
  path: string,
): PrototypeValidationError | undefined {
  if (rule === definitions.node.variants?.text) {
    const text = Object.hasOwn(data, "text");
    const spans = Object.hasOwn(data, "spans");
    if (text === spans) {
      return fail(
        keyPath(path, spans ? "spans" : "text"),
        spans ? "text and spans cannot both be set" : "text node needs text or spans",
      );
    }
    if (Array.isArray(data.spans) && data.spans.length > contract.limits.MAX_PROTOTYPE_TEXT_SPANS) {
      return fail(keyPath(path, "spans"), "Text span limit exceeded");
    }
  }
  return undefined;
}
function searchBarConstraint(
  data: Record<string, unknown>,
  path: string,
): PrototypeValidationError | undefined {
  if (
    data.type === "searchBar" &&
    Object.hasOwn(data, "child") &&
    !Object.hasOwn(data, "activeKey")
  ) {
    return fail(keyPath(path, "child"), "Search bar child requires activeKey");
  }
  return undefined;
}
/** `empty` tests a `/data` value (#14207); state key and `/platform` conditions have no emptiness. */
function emptyConditionConstraint(
  data: Record<string, unknown>,
  path: string,
): PrototypeValidationError | undefined {
  return Object.hasOwn(data, "empty") &&
    (Object.hasOwn(data, "key") || Object.hasOwn(data, "platform"))
    ? fail(keyPath(path, "empty"), "empty applies only to data conditions")
    : undefined;
}
function visitObject(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): PrototypeValidationError | undefined {
  const data = object(value);
  if (!data) {
    return fail(path, "Expected object");
  }
  const textError = textNodeConstraint(data, rule, path);
  if (textError) {
    return textError;
  }
  const fields = rule.fields ?? {};
  const searchBarError = searchBarConstraint(data, path) ?? emptyConditionConstraint(data, path);
  if (searchBarError) {
    return searchBarError;
  }
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
): PrototypeValidationError | undefined {
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
    return fail(
      path,
      rule === definitions.semantics
        ? "Expected at least one semantics field"
        : "At least one selector field is required",
    );
  }
  const kind = ["style", "fadeEdges", "imageFilter"].find((name) => rule === definitions[name]);
  return prototypeStylePolishV2ObjectError(data, kind ?? "", path);
}
/** `exactlyOne` picks one form of a union-like object; `dependents` ties optional fields to a trigger. */
function formConstraint(
  data: Record<string, unknown>,
  rule: Rule,
  path: string,
): PrototypeValidationError | undefined {
  if (rule.exactlyOne && rule.exactlyOne.filter((key) => Object.hasOwn(data, key)).length !== 1) {
    return fail(
      keyPath(path, rule.exactlyOne[0]),
      `Exactly one of ${rule.exactlyOne.join(", ")} is required`,
    );
  }
  for (const [trigger, dependents] of Object.entries(rule.dependents ?? {})) {
    const present = dependents.filter((key) => Object.hasOwn(data, key));
    if (!trigger.split("|").some((key) => Object.hasOwn(data, key))) {
      if (present.length > 0) {
        return fail(keyPath(path, present[0]), `Requires ${trigger.split("|").join(" or ")}`);
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
): PrototypeValidationError | undefined {
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
): PrototypeValidationError | undefined {
  const data = object(value);
  if (!data) {
    return fail(path, "Expected object");
  }
  if (Object.keys(data).length > (rule.maxEntries ?? Infinity)) {
    return fail(path, "Map entry limit exceeded");
  }
  for (const key of Object.keys(data).sort()) {
    const childPath = keyPath(path, key);
    if (!prototypeContractPatterns.stateKey.test(key)) {
      return fail(childPath, "Invalid state key");
    }
    const error = walk(data[key], rule.item ?? { kind: "scalar" }, childPath, context, depth);
    if (error) {
      return error;
    }
  }
  return undefined;
}
function visitScreenMap(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): PrototypeValidationError | undefined {
  const screens = object(value);
  if (!screens) {
    return fail(path, "Expected object");
  }
  const names = Object.keys(screens).sort();
  if (names.length < 1 || names.length > contract.limits.MAX_PROTOTYPE_STACK_SCREENS) {
    return fail(path, "Screen count out of range");
  }
  for (const name of names) {
    const at = `${path}[${JSON.stringify(name)}]`;
    if (!name.length) {
      return fail(at, "Empty screen name");
    }
    const error = walk(screens[name], rule.item!, at, context, depth);
    if (error) {
      return error;
    }
  }
  return undefined;
}
function visitRecord(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): PrototypeValidationError | undefined {
  const data = object(value);
  if (!data) {
    return fail(path, "Expected object");
  }
  if (Object.keys(data).length > (rule.maxEntries ?? Infinity)) {
    return fail(path, "Record entry limit exceeded");
  }
  for (const [key, child] of Object.entries(data)) {
    const at = keyPath(path, key);
    if (key.length === 0) {
      return fail(at, "Invalid context name");
    }
    const error = walk(child, rule.item ?? { kind: "json" }, at, context, depth);
    if (error) {
      return error;
    }
  }
  return undefined;
}
const primitiveChecks: Record<string, (value: unknown, rule: Rule) => boolean> = {
  string: (value, rule) =>
    typeof value === "string" &&
    (rule.empty === true || value.length > 0) &&
    (!rule.nonblank || !prototypeContractPatterns.blankText.test(value)) &&
    value.length <= (rule.max ?? Infinity) &&
    (!rule.pattern ||
      new RegExp(contract.patterns[rule.pattern as keyof typeof contract.patterns]).test(value)),
  pointer: isPrototypeDataPointer,
  key: (value) => typeof value === "string" && prototypeContractPatterns.stateKey.test(value),
  boundKey: (value) => typeof value === "string" && BOUND_STATE_KEY_PATTERN.test(value),
  color: (value) => typeof value === "string" && prototypeContractPatterns.color.test(value),
  number: numberValid,
  true: (value) => value === true,
  boolean: (value) => typeof value === "boolean",
  scalar: (value) =>
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)),
  enum: (value, rule) =>
    (typeof value === "string" || typeof value === "boolean") &&
    (rule.values ?? []).includes(value),
  json: (value, rule) => {
    const cost = jsonCost(value);
    return Number.isFinite(cost) && cost <= (rule.maxBytes ?? Infinity);
  },
};
// Reserve 32 bytes per finite number so lexical exponent/decimal spellings cannot
// change payload acceptance between JavaScript and JVM JSON decoders.
function jsonCost(value: unknown, depth = 0): number {
  if (depth > contract.limits.MAX_PROTOTYPE_EMIT_PAYLOAD_DEPTH) {
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
/** Data uses the emit payload cost after its own stricter depth-first walk. */
export function prototypeDataError(
  value: unknown,
  maxBytes: number = contract.limits.MAX_PROTOTYPE_DATA_BYTES,
): PrototypeValidationError | undefined {
  if (!object(value)) {
    return fail("data", "Expected object");
  }
  return (
    walkDataValue(value, "data", 1) ??
    (jsonCost(value) > maxBytes ? fail("data", "Data byte limit exceeded") : undefined)
  );
}

function dataChildren(value: unknown, path: string): { value: unknown; path: string }[] {
  if (Array.isArray(value)) {
    return value.map((child, index) => ({ value: child, path: `${path}[${index}]` }));
  }
  const data = object(value) ?? {};
  return Object.keys(data)
    .sort()
    .map((key) => ({ value: data[key], path: keyPath(path, key) }));
}

function walkDataValue(
  value: unknown,
  path: string,
  depth: number,
): PrototypeValidationError | undefined {
  if (!Array.isArray(value) && !object(value)) {
    return primitiveChecks.scalar(value, { kind: "scalar" })
      ? undefined
      : fail(path, "Invalid data value");
  }
  if (depth > contract.limits.MAX_PROTOTYPE_DATA_DEPTH) {
    return fail(path, "Data depth limit exceeded");
  }
  if (Array.isArray(value) && value.length > contract.limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS) {
    return fail(path, "Data array limit exceeded");
  }
  for (const child of dataChildren(value, path)) {
    const error = walkDataValue(child.value, child.path, depth + 1);
    if (error) {
      return error;
    }
  }
  return undefined;
}
function visitData(value: unknown): PrototypeValidationError | undefined {
  return prototypeDataError(value);
}
function visitChoice(
  value: unknown,
  rule: Rule,
  path: string,
  context: Context,
  depth: number,
): PrototypeValidationError | undefined {
  const options = rule.options ?? [];
  const candidates = options.filter((option) => {
    if (option.kind === "array") {
      return Array.isArray(value);
    }
    if (option.kind === "object") {
      return object(value) !== undefined;
    }
    if (option.kind === "number") {
      return typeof value === "number";
    }
    if (option.kind === "scalar") {
      return ["string", "number", "boolean"].includes(typeof value);
    }
    return typeof value === "string";
  });
  // Several options can accept the same JSON type (a hex colour or a role name are both strings).
  let firstError: PrototypeValidationError | undefined;
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
): PrototypeValidationError | undefined {
  const handlers: Record<string, typeof visitObject> = {
    strings: (value) => prototypeStringsTableError(value),
    data: visitData,
    ref: visitReference,
    tagged: visitTagged,
    object: visitObject,
    array: visitArray,
    map: visitMap,
    screenMap: visitScreenMap,
    record: visitRecord,
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
function stackErrors(context: Context): PrototypeValidationError | undefined {
  const stacks = new Map<string, Record<string, unknown>>();
  for (const { value, path } of context.nodes) {
    if (value.type !== "stack" || typeof value.id !== "string") {
      continue;
    }
    if (stacks.has(value.id)) {
      return fail(`${path}.id`, "Duplicate stack id");
    }
    const screens = object(value.screens) ?? {};
    if (typeof value.start !== "string" || !Object.hasOwn(screens, value.start)) {
      return fail(`${path}.start`, "Unknown start screen");
    }
    stacks.set(value.id, screens);
  }
  return stackActionErrors(context.actions, stacks);
}
function stackActionErrors(
  actions: Located[],
  stacks: Map<string, Record<string, unknown>>,
): PrototypeValidationError | undefined {
  for (const { value, path } of actions) {
    if (typeof value.stack !== "string") {
      continue;
    }
    const screens = stacks.get(value.stack);
    if (!screens) {
      return fail(`${path}.stack`, "Unknown stack id");
    }
    if (typeof value.screen === "string" && !Object.hasOwn(screens, value.screen)) {
      return fail(`${path}.screen`, "Unknown stack screen");
    }
  }
  return undefined;
}
/** Context uses the same pager-id set as setPage; only structurally valid emits carry context. */
function emitContextPagerError(
  { value, path }: Located,
  pagers: ReadonlySet<string>,
): PrototypeValidationError | undefined {
  for (const [name, binding] of Object.entries(object(value.context) ?? {})) {
    const page = object(binding)?.page;
    if (typeof page === "string" && !pagers.has(page)) {
      return fail(keyPath(`${path}.context`, name), "Unknown pager id");
    }
  }
  return undefined;
}
/** A swipe needs an action side, and a horizontal pager or carousel would steal its drag. */
function swipeActionsErrors(context: Context): PrototypeValidationError | undefined {
  for (const { value, path } of context.nodes) {
    const swipe = object(value.swipeActions);
    if (!swipe) {
      continue;
    }
    if (swipe.start === undefined && swipe.end === undefined) {
      return fail(`${path}.swipeActions`, "swipeActions needs start or end");
    }
    const blocked = context.nodes.some(
      ({ value: ancestor, path: ancestorPath }) =>
        path.startsWith(`${ancestorPath}.`) &&
        (ancestor.type === "carousel" ||
          (ancestor.type === "pager" && ancestor.axis !== "vertical")),
    );
    if (blocked) {
      return fail(
        `${path}.swipeActions`,
        "swipeActions cannot appear inside a horizontal pager or carousel",
      );
    }
  }
  return undefined;
}
/** Whether a `scroll` with the given axis rule encloses the node at `path`. */
function insideScroll(context: Context, path: string, horizontal: boolean): boolean {
  return context.nodes.some(
    ({ value: ancestor, path: ancestorPath }) =>
      ancestor.type === "scroll" &&
      (ancestor.axis === "horizontal") === horizontal &&
      path.startsWith(`${ancestorPath}.`),
  );
}
/**
 * A horizontal `scroll` measures its child with an infinite width, which the lazy horizontal pager
 * and carousel layouts cannot take (#14165); the vertical rule is the same for vertical pagers.
 */
function horizontalLazyError(
  node: Record<string, unknown>,
  path: string,
  context: Context,
): PrototypeValidationError | undefined {
  if (node.type === "carousel" && insideScroll(context, path, true)) {
    return fail(path, "A carousel cannot appear inside a horizontal scroll");
  }
  if (node.type === "pager" && node.axis !== "vertical" && insideScroll(context, path, true)) {
    return fail(path, "A horizontal pager cannot appear inside a horizontal scroll");
  }
  return undefined;
}
/** One pager's own checks; records its id in `pagers`. */
function pagerNodeError(
  value: Record<string, unknown>,
  path: string,
  context: Context,
  pagers: Set<string>,
): PrototypeValidationError | undefined {
  if (value.type !== "pager" || typeof value.id !== "string") {
    return undefined;
  }
  if (pagers.has(value.id)) {
    return fail(`${path}.id`, "Duplicate pager id");
  }
  pagers.add(value.id);
  return value.axis === "vertical" && insideScroll(context, path, false)
    ? fail(`${path}.axis`, "A vertical pager cannot appear inside a vertical scroll")
    : undefined;
}
function pagerErrors(context: Context): PrototypeValidationError | undefined {
  const pagers = new Set<string>();
  for (const { value, path } of context.nodes) {
    const error =
      horizontalLazyError(value, path, context) ?? pagerNodeError(value, path, context, pagers);
    if (error) {
      return error;
    }
  }
  for (const { value, path } of [...context.nodes, ...context.actions]) {
    if (typeof value.pager === "string" && !pagers.has(value.pager)) {
      return fail(`${path}.pager`, "Unknown pager id");
    }
  }
  for (const action of context.actions) {
    const error = emitContextPagerError(action, pagers);
    if (error) {
      return error;
    }
  }
  return undefined;
}
/** State-type checks over every repeat instance: a templated key is checked once per item. */
function stateTypeErrors(
  value: unknown,
  context: Context,
  data: Record<string, unknown>,
  repeats: PrototypeRepeatData,
): PrototypeValidationError | undefined {
  const checked: Checked = {
    nodes: repeatKeyInstances(value, context.nodes, repeats).map(bound),
    actions: repeatKeyInstances(value, context.actions, repeats).map(bound),
  };
  return (
    bindingErrors(checked, data) ??
    listItemBindingErrors(checked, data) ??
    sheetBindingErrors(checked, data) ??
    stateActionErrors(checked, data) ??
    prototypeCheckErrors(checked.nodes, checked.actions, object(data.state) ?? {})
  );
}
/** Span belongs to the immediate grid parent, including repeat templates. */
function gridSpanErrors(context: Context): PrototypeValidationError | undefined {
  const parents = new Map<string, Record<string, unknown>>();
  for (const { value, path } of context.nodes) {
    if (value.span !== undefined) {
      const parent = parents.get(path);
      if (parent?.type !== "grid") {
        return fail(`${path}.span`, "span requires a direct grid parent");
      }
      if (
        typeof parent.columns === "number" &&
        typeof value.span === "number" &&
        value.span > parent.columns
      ) {
        return fail(`${path}.span`, "span exceeds grid columns");
      }
    }
    if (Array.isArray(value.children)) {
      for (const index of value.children.keys()) {
        parents.set(`${path}.children[${index}]`, value);
      }
    }
  }
  return undefined;
}

/** Tree-shape checks that run after the schema walk, in the order the host reports them. */
function layoutErrors(
  value: unknown,
  context: Context,
  repeats: PrototypeRepeatData,
): PrototypeValidationError | undefined {
  return (
    gridSpanErrors(context) ??
    swipeActionsErrors(context) ??
    prototypeLazyListError(context.nodes) ??
    prototypeDerivedError(value, context.nodes) ??
    repeatErrors(value, repeats) ??
    prototypeStorageError(value)
  );
}

/** A literal platform-call argument against its `platformModules` rule (#14294). */
function platformArgumentError(
  value: unknown,
  rule: Rule,
  path: string,
): PrototypeValidationError | undefined {
  const context: Context = {
    nodes: [],
    actions: [],
    images: 0,
    effects: 0,
    animatedEffects: 0,
    nesting: { container: 0, condition: 0, action: 0 },
  };
  return walk(value, rule, path, context, 0);
}

/** The host-owned vocabulary: the reserved `automobile-` testTag namespace, then the platform rules. */
function hostVocabularyError(
  value: unknown,
  context: Context,
): PrototypeValidationError | undefined {
  return (
    prototypeStringsError(value, context.nodes) ??
    prototypeReservedTestTagError(context.nodes) ??
    prototypePlatformError(value, context.actions, platformArgumentError)
  );
}

/** Motion and choreography share one set of located nodes. */
function motionErrors(nodes: Located[]): PrototypeValidationError | undefined {
  return prototypeMotionV2Error(nodes) ?? prototypeChoreographyError(nodes);
}

/** Cross-node references share the component-expanded tree and repeat cardinalities. */
function nodeReferenceErrors(
  context: Context,
  repeats: PrototypeRepeatData,
): PrototypeValidationError | undefined {
  return (
    prototypeTooltipError(context.nodes, repeats) ??
    prototypeChatScrollError(context.nodes, context.actions) ??
    pagerErrors(context) ??
    stackErrors(context)
  );
}

/** Action, container and state checks, after the layout checks pass. */
function behaviourErrors(
  value: unknown,
  context: Context,
  data: Record<string, unknown>,
  repeats: PrototypeRepeatData,
  componentTimers: Located[],
): PrototypeValidationError | undefined {
  return (
    prototypeDataActionsError(context.actions, data.data, prototypeDataError) ??
    prototypeRequestsError(context.actions, data.data) ??
    hostVocabularyError(value, context) ??
    prototypeTimersError([...context.actions, ...componentTimers]) ??
    prototypeLoadingStatesError(context.nodes) ??
    motionErrors(context.nodes) ??
    prototypeChartError(context.nodes, data.data) ??
    prototypeLinkifyError(value) ??
    nodeReferenceErrors(context, repeats) ??
    stateTypeErrors(value, context, data, repeats)
  );
}

function validateValue(
  value: unknown,
  options: PrototypeStrictOptions,
  componentTimers: Located[] = [],
): PrototypeValidationResult {
  const context: Context = {
    nodes: [],
    actions: [],
    images: 0,
    effects: 0,
    animatedEffects: 0,
    nesting: { container: 0, condition: 0, action: 0 },
  };
  const data = object(value) ?? {};
  const repeats = new PrototypeRepeatData(data.data);
  const error =
    prototypeLazyListLimitError(value) ??
    walk(value, definitions.spec, "", context, 0) ??
    layoutErrors(value, context, repeats) ??
    behaviourErrors(value, context, data, repeats, componentTimers);
  if (error) {
    return { success: false, error };
  }
  const parsed = prototypeSpecSchema.safeParse(value);
  if (!parsed.success) {
    return { success: false, error: fail("$", "Internal schema/contract mismatch") };
  }
  const policyError = prototypeStrictPolicyError(parsed.data, options, context.actions);
  return policyError
    ? { success: false, error: policyError }
    : { success: true, data: parsed.data };
}
/**
 * Expands reusable components (#11053) before validating, so every limit applies to the tree the
 * device receives. The expanded spec must also fit the byte limit, because the device re-validates
 * bytes, and an error inside an expansion is reported at its authored location.
 */
function validateExpanded(
  value: unknown,
  options: PrototypeStrictOptions,
): PrototypeValidationResult {
  const expansion = expandPrototypeComponents(value);
  if (!expansion.success) {
    return { success: false, error: expansion.error };
  }
  if (expansion.expanded && bytes(expansion.spec) > MAX_PROTOTYPE_SPEC_BYTES) {
    return { success: false, error: fail("$", "Expanded spec byte limit exceeded") };
  }
  // Expanded contract order comes first; append authored definitions not represented there.
  const components = object(object(value)?.components);
  const result = validateValue(
    expansion.spec,
    options,
    prototypeTimerActions({
      components: Object.fromEntries(
        Object.entries(components ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ),
    }),
  );
  return result.success
    ? result
    : {
        success: false,
        error: { path: expansion.locate(result.error.path), message: result.error.message },
      };
}
/** Raw JSON strings measure transmitted UTF-8 bytes; object input measures compact JSON bytes. */
export function validatePrototypeSpec(
  json: unknown,
  options: PrototypeStrictOptions = {},
): PrototypeValidationResult {
  try {
    const input = typeof json === "string" ? json : JSON.stringify(json);
    if (input === undefined) {
      return { success: false, error: fail("$", "Expected JSON") };
    }
    if (Buffer.byteLength(input, "utf8") > MAX_PROTOTYPE_SPEC_BYTES) {
      return { success: false, error: fail("$", "Spec byte limit exceeded") };
    }
    const parsedJson = prototypeStrictJson(input);
    return validateExpanded(typeof json === "string" ? parsedJson : json, options);
  } catch (error) {
    logger.warn("Prototype JSON could not be decoded", error);
    return { success: false, error: fail("$", "Invalid JSON") };
  }
}

/** Byte boundary for file/import callers; invalid UTF-8 is never replacement-decoded. */
export function validatePrototypeSpecBytes(
  bytes: Uint8Array,
  options: PrototypeStrictOptions = {},
): PrototypeValidationResult {
  if (bytes.byteLength > MAX_PROTOTYPE_SPEC_BYTES) {
    return { success: false, error: fail("$", "Spec byte limit exceeded") };
  }
  try {
    return validatePrototypeSpec(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      options,
    );
  } catch (error) {
    logger.warn("Prototype UTF-8 could not be decoded", error);
    return { success: false, error: fail("$", "Invalid UTF-8") };
  }
}
