import contract from "../../../schemas/overlay-spec-contract.json";

/**
 * Static checks for the `repeat` list template on an already structurally valid spec.
 *
 * A container with `repeat: {items, as}` instantiates its children once per item, so these checks
 * run over the raw tree after the contract walk: placeholders must name a field every item has, a
 * template may not nest another `repeat` or declare a pager, and the expanded tree must still fit
 * the node and image limits. Depth is unaffected because instances are siblings, never deeper.
 */
export interface RepeatError {
  path: string;
  message: string;
}

type Raw = Record<string, unknown>;
interface Scope {
  alias: string;
  items: Raw[];
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const fail = (path: string, message: string): RepeatError => ({ path, message });

function record(value: unknown): Raw | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : undefined;
}

/** Field names referenced as `{alias.field}`; `{index}` needs no field. Other braces stay literal. */
export function repeatFieldReferences(text: string, alias: string): string[] {
  const names: string[] = [];
  const prefix = `${alias}.`;
  let cursor = text.indexOf("{");
  while (cursor >= 0) {
    const close = text.indexOf("}", cursor + 1);
    const inner = close < 0 ? "" : text.slice(cursor + 1, close);
    if (inner.startsWith(prefix) && FIELD_NAME.test(inner.slice(prefix.length))) {
      names.push(inner.slice(prefix.length));
    }
    cursor = close < 0 ? -1 : text.indexOf("{", cursor + 1);
  }
  return names;
}

function checkString(text: unknown, path: string, scope: Scope): RepeatError | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  for (const name of repeatFieldReferences(text, scope.alias)) {
    if (!scope.items.every((item) => Object.hasOwn(item, name))) {
      return fail(path, `Unknown repeat field ${JSON.stringify(name)}`);
    }
  }
  return undefined;
}

/** The text with `{index}` and `{alias.field}` bound to one item; unknown fields stay literal. */
function renderForItem(text: string, scope: Scope, item: Raw, index: number): string {
  return text.replace(/\{([^{}]*)\}/g, (token, inner: string) => {
    if (inner === "index") {
      return String(index);
    }
    const name = inner.startsWith(`${scope.alias}.`) ? inner.slice(scope.alias.length + 1) : "";
    return FIELD_NAME.test(name) && Object.hasOwn(item, name) ? String(item[name]) : token;
  });
}

/** An emit name must stay non-empty for every item once its placeholders are bound. */
function checkEmitName(name: unknown, path: string, scope: Scope): RepeatError | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  const empty = scope.items.findIndex(
    (item, index) => renderForItem(name, scope, item, index) === "",
  );
  return empty < 0 ? undefined : fail(path, `Expanded emit name is empty for item ${empty}`);
}

function checkCondition(value: unknown, path: string, scope: Scope): RepeatError | undefined {
  const condition = record(value);
  if (!condition) {
    return undefined;
  }
  const own =
    checkString(condition.equals, `${path}.equals`, scope) ??
    checkString(condition.notEquals, `${path}.notEquals`, scope) ??
    checkCondition(condition.not, `${path}.not`, scope);
  if (own) {
    return own;
  }
  for (const form of ["all", "any"] as const) {
    const members = Array.isArray(condition[form]) ? (condition[form] as unknown[]) : [];
    for (let index = 0; index < members.length; index++) {
      const error = checkCondition(members[index], `${path}.${form}[${index}]`, scope);
      if (error) {
        return error;
      }
    }
  }
  return undefined;
}

function checkAction(value: unknown, path: string, scope: Scope): RepeatError | undefined {
  const action = record(value);
  if (action?.type === "setState") {
    return checkString(action.value, `${path}.value`, scope);
  }
  return action?.type === "emit"
    ? (checkString(action.name, `${path}.name`, scope) ??
        checkEmitName(action.name, `${path}.name`, scope))
    : undefined;
}

function checkList(
  value: unknown,
  path: string,
  check: (entry: unknown, entryPath: string) => RepeatError | undefined,
): RepeatError | undefined {
  const entries = Array.isArray(value) ? (value as unknown[]) : [];
  for (let index = 0; index < entries.length; index++) {
    const error = check(entries[index], `${path}[${index}]`);
    if (error) {
      return error;
    }
  }
  return undefined;
}

function checkOwnFields(node: Raw, path: string, scope: Scope): RepeatError | undefined {
  return (
    (node.type === "text" ? checkString(node.text, `${path}.text`, scope) : undefined) ??
    checkCondition(node.visibleWhen, `${path}.visibleWhen`, scope) ??
    checkList(node.styleWhen, `${path}.styleWhen`, (entry, entryPath) =>
      checkCondition(record(entry)?.when, `${entryPath}.when`, scope),
    ) ??
    checkList(node.onTap, `${path}.onTap`, (entry, entryPath) =>
      checkAction(entry, entryPath, scope),
    )
  );
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

function scopeOf(node: Raw): Scope | undefined {
  const repeat = record(node.repeat);
  const items = Array.isArray(repeat?.items) ? (repeat.items as unknown[]) : [];
  return repeat && typeof repeat.as === "string"
    ? { alias: repeat.as, items: items.filter((item): item is Raw => record(item) !== undefined) }
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
    const own = checkOwnFields(node, path, scope);
    if (own) {
      return own;
    }
  }
  const childScope = scopeOf(node) ?? scope;
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
  const scope = scopeOf(node);
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
