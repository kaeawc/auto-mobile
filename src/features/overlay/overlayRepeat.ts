import contract from "../../../schemas/overlay-spec-contract.json";
import {
  bindCheckedKeys,
  checkedKeyValues,
  bindText,
  mapBindableFields,
  record,
  STATE_KEY,
  templateFieldReferences,
  templateSegments,
  type Binding,
  type FieldKind,
  type Raw,
} from "./overlayTemplate";

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
  items: Raw[];
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
        `${scope.path}.repeat.items[${index}]`,
        `Bound state key ${JSON.stringify(bound)} is invalid`,
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
  mapBindableFields(node, path, (value, fieldPath, kind) => {
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

function scopeOf(node: Raw, path: string): Scope | undefined {
  const repeat = record(node.repeat);
  const items = Array.isArray(repeat?.items) ? (repeat.items as unknown[]) : [];
  return repeat && typeof repeat.as === "string"
    ? {
        path,
        binding: { alias: repeat.as, index: true },
        items: items.filter((item): item is Raw => record(item) !== undefined),
      }
    : undefined;
}

function templateErrors(node: Raw, path: string, scope?: Scope): RepeatError | undefined {
  if (scope) {
    if (node.repeat !== undefined) {
      return fail(`${path}.repeat`, "Nested repeat is not supported");
    }
    if (node.type === "pager") {
      return fail(path, "Pager cannot appear inside a repeat template");
    }
  }
  const own = scope ? checkOwnFields(node, path, scope) : checkLiteralKeys(node, path);
  if (own) {
    return own;
  }
  const childScope = scopeOf(node, path) ?? scope;
  for (const child of childrenOf(node, path)) {
    const error = templateErrors(child.node, child.path, childScope);
    if (error) {
      return error;
    }
  }
  return undefined;
}

interface Budget {
  nodes: number;
  images: number;
}

function imageUses(node: Raw): number {
  if (node.type === "image") {
    return 1;
  }
  const items = Array.isArray(node.items) ? (node.items as unknown[]) : [];
  return items.filter((item) => typeof record(item)?.image === "string").length;
}

/** Walks the expanded tree; an overflow inside a template is reported at its `repeat`. */
function expandedErrors(
  node: Raw,
  path: string,
  budget: Budget,
  repeatPath?: string,
): RepeatError | undefined {
  const at = repeatPath ?? path;
  budget.nodes++;
  if (budget.nodes > contract.limits.MAX_OVERLAY_NODES) {
    return fail(at, "Expanded node limit exceeded");
  }
  budget.images += imageUses(node);
  if (budget.images > contract.limits.MAX_OVERLAY_IMAGES) {
    return fail(at, "Expanded image limit exceeded");
  }
  const scope = scopeOf(node, path);
  const instances = scope ? scope.items.length : 1;
  const nestedPath = scope ? `${path}.repeat` : repeatPath;
  for (let instance = 0; instance < instances; instance++) {
    for (const child of childrenOf(node, path)) {
      const error = expandedErrors(child.node, child.path, budget, nestedPath);
      if (error) {
        return error;
      }
    }
  }
  return undefined;
}

/** First repeat-related error in traversal order, or undefined when the spec's repeats are sound. */
export function repeatErrors(spec: unknown): RepeatError | undefined {
  const root = record(record(spec)?.root);
  if (!root) {
    return undefined;
  }
  return (
    templateErrors(root, "root") ?? expandedErrors(root, "root", { nodes: 0, images: 0 }, undefined)
  );
}

function collectScopes(node: Raw, path: string, scopes: Scope[]): void {
  const scope = scopeOf(node, path);
  if (scope) {
    scopes.push(scope);
  }
  for (const child of childrenOf(node, path)) {
    collectScopes(child.node, child.path, scopes);
  }
}

/** A located node or action, and the repeat item its keys were bound to, if any. */
export interface KeyInstance<T> {
  located: T;
  value: Raw;
  item?: number;
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
): KeyInstance<T>[] {
  const root = record(record(spec)?.root);
  const scopes: Scope[] = [];
  if (root) {
    collectScopes(root, "root", scopes);
  }
  return located.flatMap((entry) => {
    const scope = scopes.find((candidate) => entry.path.startsWith(`${candidate.path}.children[`));
    const templated =
      scope &&
      checkedKeyValues(entry.value).some(
        (key) => typeof key === "string" && hasPlaceholder(key, scope.binding),
      );
    if (!scope || !templated) {
      return [{ located: entry, value: entry.value }];
    }
    return scope.items.map((item, index) => ({
      located: entry,
      value: bindCheckedKeys(entry.value, instance(scope, item, index)),
      item: index,
    }));
  });
}
