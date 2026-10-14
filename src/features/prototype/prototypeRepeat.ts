import { PrototypeRepeatData } from "./prototypeData";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  bindCheckedKeys,
  checkedKeyValues,
  bindText,
  mapBindableFields,
  record,
  renderScalar,
  STATE_KEY,
  templateFieldReferences,
  templateSegments,
  type Binding,
  type FieldKind,
  type Raw,
} from "./prototypeTemplate";

/**
 * Static checks for the `repeat` list template on an already structurally valid spec.
 *
 * A container with `repeat: {items, as}` instantiates its children once per item, so these checks
 * run over the raw tree after the contract walk: placeholders must name a field every item has,
 * state keys must bind to a literal key for every item, a template may not nest another `repeat`
 * or declare a pager, and the expanded tree must still fit the node and image limits. Depth is
 * unaffected because instances are siblings, never deeper.
 */
export interface RepeatError {
  path: string;
  message: string;
}

interface Scope {
  /** The repeat container's path; instance errors are reported at its `repeat.items[i]`. */
  path: string;
  binding: Binding;
  items: readonly Readonly<Raw>[];
  pathBound: boolean;
}

const fail = (path: string, message: string): RepeatError => ({ path, message });

/** Field names referenced as `{alias.field}`; `{index}` needs no field. Other braces stay literal. */
export function repeatFieldReferences(text: string, alias: string): string[] {
  return templateFieldReferences(text, { alias, index: true });
}

function hasPlaceholder(text: string, binding: Binding): boolean {
  return templateSegments(text, binding).some((segment) => segment.kind !== "literal");
}

function unknownField(text: string, path: string, scope: Scope): RepeatError | undefined {
  for (const name of templateFieldReferences(text, scope.binding)) {
    if (!scope.items.every((item) => Object.hasOwn(item, name))) {
      return fail(path, `Unknown repeat field ${JSON.stringify(name)}`);
    }
  }
  return undefined;
}

const instance = (scope: Scope, item: Raw, index: number) => ({
  binding: scope.binding,
  values: item,
  index,
});

/** An emit name must stay non-empty for every item once its placeholders are bound. */
function emptyEmitName(name: string, path: string, scope: Scope): RepeatError | undefined {
  const empty = scope.items.findIndex(
    (item, index) => bindText(name, instance(scope, item, index)) === "",
  );
  return empty < 0 ? undefined : fail(path, `Expanded emit name is empty for item ${empty}`);
}

/** A state key must bind to a literal key for every item; the failing item is reported. */
function invalidBoundKey(key: string, path: string, scope: Scope): RepeatError | undefined {
  if (!hasPlaceholder(key, scope.binding)) {
    return STATE_KEY.test(key) ? undefined : fail(path, "Invalid key value");
  }
  for (let index = 0; index < scope.items.length; index++) {
    const bound = bindText(key, instance(scope, scope.items[index], index));
    if (!STATE_KEY.test(bound)) {
      return fail(
        scope.pathBound
          ? `${scope.path}.repeat.items.path`
          : `${scope.path}.repeat.items[${index}]`,
        `Bound state key ${JSON.stringify(bound)} is invalid${scope.pathBound ? ` (repeat item ${index})` : ""}`,
      );
    }
  }
  return undefined;
}

function fieldError(
  value: unknown,
  path: string,
  kind: FieldKind,
  scope: Scope,
): RepeatError | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const unknown = unknownField(value, path, scope);
  if (unknown) {
    return unknown;
  }
  if (kind === "emitName") {
    return emptyEmitName(value, path, scope);
  }
  return kind === "key" ? invalidBoundKey(value, path, scope) : undefined;
}

/** The first error among a template node's own bindable fields, in visiting order. */
function checkOwnFields(node: Raw, path: string, scope: Scope): RepeatError | undefined {
  let first: RepeatError | undefined;
  mapBindableFields(node, path, (value, fieldPath, kind, dataCondition) => {
    if (dataCondition && typeof value === "string" && hasPlaceholder(value, scope.binding)) {
      first ??= fail(fieldPath, "Repeat placeholder in a data condition operand is not supported");
      return value;
    }
    first ??= fieldError(value, fieldPath, kind, scope);
    return value;
  });
  return first;
}

/** Outside every template a state key is literal, so a placeholder there is an invalid key. */
function checkLiteralKeys(node: Raw, path: string): RepeatError | undefined {
  let first: RepeatError | undefined;
  mapBindableFields(node, path, (value, fieldPath, kind) => {
    if (kind === "key" && typeof value === "string" && !STATE_KEY.test(value)) {
      first ??= fail(fieldPath, "State key placeholder outside a repeat template");
    }
    return value;
  });
  return first;
}

interface Child {
  node: Raw;
  path: string;
}

function childrenOf(node: Raw, path: string): Child[] {
  if (node.type === "stack") {
    return Object.entries(record(node.screens) ?? {}).flatMap(([name, value]) => {
      const child = record(value);
      return child ? [{ node: child, path: `${path}.screens[${JSON.stringify(name)}]` }] : [];
    });
  }
  const single = record(node.child);
  if (single) {
    return [{ node: single, path: `${path}.child` }];
  }
  const list = Array.isArray(node.children) ? (node.children as unknown[]) : [];
  return list.flatMap((entry, index) => {
    const child = record(entry);
    return child ? [{ node: child, path: `${path}.children[${index}]` }] : [];
  });
}

interface RepeatState {
  data: PrototypeRepeatData;
  cells: number;
}

function scopeOf(node: Raw, path: string, data: PrototypeRepeatData): Scope | undefined {
  const repeat = record(node.repeat);
  const source = record(repeat?.items);
  const literal: unknown[] = Array.isArray(repeat?.items) ? repeat.items : [];
  return repeat && typeof repeat.as === "string"
    ? {
        path,
        binding: { alias: repeat.as, index: true },
        items:
          source && typeof source.path === "string"
            ? data.items(source.path)
            : literal.filter((item): item is Raw => record(item) !== undefined),
        pathBound: source !== undefined,
      }
    : undefined;
}

function templateErrors(
  node: Raw,
  path: string,
  state: RepeatState,
  scope?: Scope,
): RepeatError | undefined {
  if (scope) {
    if (node.repeat !== undefined) {
      return fail(`${path}.repeat`, "Nested repeat is not supported");
    }
    if (node.type === "stack") {
      return fail(path, "Stack cannot appear inside a repeat template");
    }
    if (node.type === "pager") {
      return fail(path, "Pager cannot appear inside a repeat template");
    }
  }
  const own = scope ? checkOwnFields(node, path, scope) : checkLiteralKeys(node, path);
  if (own) {
    return own;
  }
  const repeatError = repeatSourceErrors(node, path, state);
  if (repeatError) {
    return repeatError;
  }
  const ownScope = scopeOf(node, path, state.data);
  const childScope = ownScope ?? scope;
  for (const child of childrenOf(node, path)) {
    const error = templateErrors(child.node, child.path, state, childScope);
    if (error) {
      return error;
    }
  }
  return repeatIdentityError(node, path, ownScope);
}

function repeatIdentityError(
  node: Raw,
  path: string,
  scope: Scope | undefined,
): RepeatError | undefined {
  const key = record(node.repeat)?.key;
  return scope && typeof key === "string"
    ? repeatKeyError(scope.items, key, `${path}.repeat.key`)
    : undefined;
}

const MAX_REPEAT_ITEMS =
  contract.definitions.repeat.fields.items.rule.options.find((option) => option.kind === "array")
    ?.max ?? Infinity;

function repeatSourceErrors(node: Raw, path: string, state: RepeatState): RepeatError | undefined {
  const repeat = record(node.repeat);
  if (!repeat) {
    return undefined;
  }
  const source = record(repeat.items);
  if (source && typeof source.path === "string") {
    const items = state.data.source(source.path);
    const at = `${path}.repeat.items.path`;
    if (!Array.isArray(items)) {
      return fail(at, "Repeat path does not resolve to an array");
    }
    if (items.length > MAX_REPEAT_ITEMS) {
      return fail(at, `Repeat path resolves to more than ${MAX_REPEAT_ITEMS} items`);
    }
    const invalid = items.findIndex((item) => !record(item));
    if (invalid >= 0) {
      return fail(at, `Repeat path item ${invalid} is not an object`);
    }
    state.cells += state.data.cells(source.path);
    if (state.cells > contract.limits.MAX_PROTOTYPE_REPEAT_PATH_CELLS) {
      return fail(at, "Repeat path cell limit exceeded");
    }
  }
  return undefined;
}

function repeatKeyError(
  items: readonly Readonly<Raw>[],
  key: string,
  path: string,
): RepeatError | undefined {
  if (items.some((item) => !Object.hasOwn(item, key))) {
    return fail(path, `Unknown repeat field ${JSON.stringify(key)}`);
  }
  const seen = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const text = renderScalar(item[key]);
    const first = seen.get(text);
    if (first !== undefined) {
      return fail(
        path,
        `Duplicate repeat key ${JSON.stringify(text)} (items ${first} and ${index})`,
      );
    }
    seen.set(text, index);
  }
  return undefined;
}

interface Budget {
  nodes: number;
  images: number;
}

/**
 * What one image slot costs against `MAX_PROTOTYPE_IMAGES`: an asset id costs 1, and a
 * `{light, dark}` pair costs 2 when the two modes name different assets (#11218). Absent is 0.
 */
export function imageSlotUses(value: unknown): number {
  if (typeof value === "string") {
    return 1;
  }
  const pair = record(value);
  if (!pair) {
    return 0;
  }
  return typeof pair.light === "string" && typeof pair.dark === "string" && pair.light !== pair.dark
    ? 2
    : 1;
}

function imageUses(node: Raw): number {
  if (node.type === "image") {
    return Math.max(1, imageSlotUses(node.asset));
  }
  const items = Array.isArray(node.items) ? (node.items as unknown[]) : [];
  return items.reduce<number>((sum, item) => sum + imageSlotUses(record(item)?.image), 0);
}

/** Walks the expanded tree; an overflow inside a template is reported at its `repeat`. */
function expandedErrors(
  node: Raw,
  path: string,
  budget: Budget,
  data: PrototypeRepeatData,
  repeatPath?: string,
): RepeatError | undefined {
  const at = repeatPath ?? path;
  budget.nodes++;
  if (budget.nodes > contract.limits.MAX_PROTOTYPE_NODES) {
    return fail(at, "Expanded node limit exceeded");
  }
  budget.images += imageUses(node);
  if (budget.images > contract.limits.MAX_PROTOTYPE_IMAGES) {
    return fail(at, "Expanded image limit exceeded");
  }
  const scope = scopeOf(node, path, data);
  const instances = scope ? scope.items.length : 1;
  const nestedPath = scope ? `${path}.repeat` : repeatPath;
  for (let instance = 0; instance < instances; instance++) {
    for (const child of childrenOf(node, path)) {
      const error = expandedErrors(child.node, child.path, budget, data, nestedPath);
      if (error) {
        return error;
      }
    }
  }
  return undefined;
}

/** First repeat-related error in traversal order, or undefined when the spec's repeats are sound. */
export function repeatErrors(
  spec: unknown,
  data = new PrototypeRepeatData(record(spec)?.data),
): RepeatError | undefined {
  const root = record(record(spec)?.root);
  if (!root) {
    return undefined;
  }
  return (
    templateErrors(root, "root", { data, cells: 0 }) ??
    expandedErrors(root, "root", { nodes: 0, images: 0 }, data, undefined)
  );
}

function collectScopes(node: Raw, path: string, scopes: Scope[], data: PrototypeRepeatData): void {
  const scope = scopeOf(node, path, data);
  if (scope) {
    scopes.push(scope);
  }
  for (const child of childrenOf(node, path)) {
    collectScopes(child.node, child.path, scopes, data);
  }
}

/** A located node or action, and the repeat item its keys were bound to, if any. */
export interface KeyInstance<T> {
  located: T;
  value: Raw;
  item?: number;
  /** True when the entry's `value` operand holds a repeat placeholder, so its type is not static. */
  operandTemplated: boolean;
}

/**
 * The per-item views the state-type checks run over: a node or action inside a template whose
 * state keys hold placeholders appears once per item with those keys bound (a bound key missing
 * from `state` then fails exactly like a literal one); everything else appears once, unchanged.
 * Call only after `repeatErrors` passed, so every bound key is a literal key.
 */
export function repeatKeyInstances<T extends { value: Raw; path: string }>(
  spec: unknown,
  located: T[],
  data = new PrototypeRepeatData(record(spec)?.data),
): KeyInstance<T>[] {
  const root = record(record(spec)?.root);
  const scopes: Scope[] = [];
  if (root) {
    collectScopes(root, "root", scopes, data);
  }
  return located.flatMap((entry) => {
    const scope = scopes.find((candidate) => entry.path.startsWith(`${candidate.path}.children[`));
    const operandTemplated =
      scope !== undefined &&
      typeof entry.value.value === "string" &&
      hasPlaceholder(entry.value.value, scope.binding);
    const templated =
      scope &&
      checkedKeyValues(entry.value).some(
        (key) => typeof key === "string" && hasPlaceholder(key, scope.binding),
      );
    if (!scope || !templated) {
      return [{ located: entry, value: entry.value, operandTemplated }];
    }
    return scope.items.map((item, index) => ({
      located: entry,
      value: bindCheckedKeys(entry.value, instance(scope, item, index)),
      item: index,
      operandTemplated,
    }));
  });
}
