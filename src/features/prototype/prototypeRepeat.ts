import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { chargeKeyframeNode } from "./prototypeKeyframes";
import { effectUses } from "./prototypeEffects";
import { prototypeNodeChildren } from "./prototypeNodeChildren";
import { PrototypeRepeatData } from "./prototypeData";
import contract from "../../../schemas/prototype-spec-contract.json";
import {
  prototypeDataPathHasIndex,
  prototypeDataPathPlaceholderMessage,
} from "./prototypeDataActions";
import {
  bindCheckedKeys,
  checkedKeyValues,
  bindText,
  mapBindableFields,
  record,
  renderScalar,
  STATE_KEY,
  BOUND_STATE_KEY_PATTERN,
  templateFieldReferences,
  templateSegments,
  type Binding,
  type FieldKind,
  isDataPathKind,
  type Raw,
  type Segment,
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
  derivedFields: ReadonlySet<string>;
}

const fail = (path: string, message: string): RepeatError => ({ path, message });

/** Field names referenced as `{alias.field}`; `{index}` needs no field. Other braces stay literal. */
export function repeatFieldReferences(text: string, alias: string): string[] {
  return templateFieldReferences(text, { alias, index: true });
}

function hasPlaceholder(text: string, binding: Binding): boolean {
  return templateSegments(text, binding).some((segment) => segment.kind !== "literal");
}

function unknownField(segments: Segment[], path: string, scope: Scope): RepeatError | undefined {
  for (const segment of segments) {
    if (segment.kind !== "field") {
      continue;
    }
    const name = segment.name;
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
  const pattern =
    scope.binding.alias !== "route" &&
    templateFieldReferences(key, { alias: "route", index: false }).length
      ? BOUND_STATE_KEY_PATTERN
      : STATE_KEY;
  if (!hasPlaceholder(key, scope.binding)) {
    return pattern.test(key) ? undefined : fail(path, "Invalid key value");
  }
  for (let index = 0; index < scope.items.length; index++) {
    const bound = bindText(key, instance(scope, scope.items[index], index));
    const invalidRepeatPart = templateSegments(key, scope.binding).some(
      (segment) =>
        segment.kind === "field" &&
        !prototypeContractPatterns.pathKey.test(
          `_${renderScalar(scope.items[index][segment.name])}`,
        ),
    );
    if (invalidRepeatPart || !pattern.test(bound)) {
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

/** Count each placeholder once, then evaluate field multiplicities per item. */
function repeatTextError(
  text: string,
  segments: Segment[],
  path: string,
  scope: Scope,
  state: RepeatState,
  dataRecognized: boolean,
): RepeatError | undefined {
  const fields = new Map<string, number>();
  let indices = 0;
  let recognized = dataRecognized;
  for (const segment of segments) {
    if (segment.kind === "index") {
      recognized = true;
      indices++;
    } else if (segment.kind === "field") {
      recognized = true;
      fields.set(segment.name, (fields.get(segment.name) ?? 0) + 1);
    }
  }
  if (!recognized) {
    return undefined;
  }
  for (let index = 0; index < scope.items.length; index++) {
    let length = indices * String(index).length;
    if (length > contract.limits.MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH) {
      return fail(path, "Substituted text length limit exceeded");
    }
    const item = scope.items[index];
    for (const [name, count] of fields) {
      if (!Object.hasOwn(item, name)) {
        continue;
      }
      length += count * renderScalar(item[name]).length;
      if (length > contract.limits.MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH) {
        return fail(path, "Substituted text length limit exceeded");
      }
    }
    if (!chargeText(state, text.length + length)) {
      return fail(path, "Substituted text total limit exceeded");
    }
  }
  return undefined;
}

function chargeText(state: RepeatState, length: number): boolean {
  state.total += length;
  return state.total <= contract.limits.MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL;
}

function dataTextError(path: string, state: RepeatState): RepeatError | undefined {
  return fail(
    path,
    state.total > contract.limits.MAX_PROTOTYPE_SUBSTITUTED_TEXT_TOTAL
      ? "Substituted text total limit exceeded"
      : "Substituted text length limit exceeded",
  );
}

function fieldError(
  value: unknown,
  path: string,
  kind: FieldKind,
  scope: Scope,
  state: RepeatState,
  dataCondition = false,
): RepeatError | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const authored = templateSegments(value, scope.binding);
  if (dataCondition && authored.some((segment) => segment.kind !== "literal")) {
    return fail(path, "Repeat placeholder in a data condition operand is not supported");
  }
  const unknown = unknownField(authored, path, scope);
  if (unknown) {
    return unknown;
  }
  let dataRecognized = false;
  const resolved =
    kind === "text"
      ? state.data.text(value, (length) => {
          dataRecognized = true;
          return chargeText(state, length);
        })
      : value;
  if (resolved === undefined) {
    return dataTextError(path, state);
  }
  const segments = resolved === value ? authored : templateSegments(resolved, scope.binding);
  const repeated = repeatTextError(resolved, segments, path, scope, state, dataRecognized);
  if (repeated) {
    return repeated;
  }
  return repeatedValueError(kind, value, path, scope);
}

/** A data action path binds only a whole `{index}` segment; `{alias.field}` is refused. */
function dataPathPlaceholderError(
  kind: FieldKind,
  value: unknown,
  path: string,
  scope: Scope,
): RepeatError | undefined {
  const message =
    isDataPathKind(kind) && typeof value === "string"
      ? prototypeDataPathPlaceholderMessage(value, scope.binding)
      : undefined;
  return message === undefined ? undefined : fail(path, message);
}

function emitBindingError(value: unknown, path: string, scope?: Scope): RepeatError | undefined {
  const binding = record(value);
  if (!binding) {
    return undefined;
  }
  if (!scope) {
    return Object.hasOwn(binding, "item") || Object.hasOwn(binding, "index")
      ? fail(path, "Emit item/index binding outside a repeat template")
      : undefined;
  }
  return typeof binding.item === "string" &&
    !scope.items.every((item) => Object.hasOwn(item, binding.item as string))
    ? fail(path, `Unknown repeat field ${JSON.stringify(binding.item)}`)
    : undefined;
}

/** The first error among a template node's own bindable fields, in visiting order. */
function checkOwnFields(
  node: Raw,
  path: string,
  scope: Scope,
  state: RepeatState,
): RepeatError | undefined {
  let first: RepeatError | undefined;
  mapBindableFields(node, path, (value, fieldPath, kind, dataCondition) => {
    if (kind === "emitBinding") {
      first ??= emitBindingError(value, fieldPath, scope);
    }
    first ??= dataPathPlaceholderError(kind, value, fieldPath, scope);
    first ??= fieldError(value, fieldPath, kind, scope, state, dataCondition);
    return value;
  });
  return first;
}

/** Outside a template a state key is literal and a data path has no `{index}`. */
function literalPlaceholderError(
  kind: FieldKind,
  value: unknown,
  path: string,
): RepeatError | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (
    kind === "key" &&
    !STATE_KEY.test(
      templateSegments(value, { alias: "route", index: false })
        .map((segment) => (segment.kind === "literal" ? segment.text : "r"))
        .join(""),
    )
  ) {
    return fail(path, "State key placeholder outside a repeat template");
  }
  return isDataPathKind(kind) && prototypeDataPathHasIndex(value)
    ? fail(path, "{index} outside a repeat template")
    : undefined;
}

/** Outside every template a state key is literal, so a placeholder there is an invalid key. */
function checkLiteralKeys(node: Raw, path: string, state: RepeatState): RepeatError | undefined {
  let first: RepeatError | undefined;
  mapBindableFields(node, path, (value, fieldPath, kind) => {
    if (kind === "emitBinding") {
      first ??= emitBindingError(value, fieldPath);
    }
    if (
      !first &&
      kind === "text" &&
      typeof value === "string" &&
      state.data.text(value, (length) => chargeText(state, length)) === undefined
    ) {
      first = dataTextError(fieldPath, state);
    }
    first ??= literalPlaceholderError(kind, value, fieldPath);
    return value;
  });
  return first;
}

interface Child {
  node: Raw;
  path: string;
}

function childrenOf(node: Raw, path: string): Child[] {
  return prototypeNodeChildren(node).flatMap(({ value, suffix }) => {
    const child = record(value);
    return child ? [{ node: child, path: `${path}${suffix}` }] : [];
  });
}

interface RepeatState {
  data: PrototypeRepeatData;
  cells: number;
  total: number;
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
            ? derivedValidationItems(data.items(source.path), repeat.derive)
            : derivedValidationItems(
                literal.filter((item): item is Raw => record(item) !== undefined),
                repeat.derive,
              ),
        pathBound: source !== undefined,
        derivedFields: new Set(Object.keys(record(repeat.derive) ?? {})),
      }
    : undefined;
}

function templateNodeError(node: Raw, path: string): RepeatError | undefined {
  if (node.type === "list") {
    return fail(path, "A list cannot sit inside a repeat template");
  }
  if (node.repeat !== undefined) {
    return fail(`${path}.repeat`, "Nested repeat is not supported");
  }
  if (node.type === "stack") {
    return fail(path, "Stack cannot appear inside a repeat template");
  }
  if (node.type === "pager") {
    return fail(path, "Pager cannot appear inside a repeat template");
  }
  return undefined;
}

function templateErrors(
  node: Raw,
  path: string,
  state: RepeatState,
  scope?: Scope,
): RepeatError | undefined {
  const nesting = scope ? templateNodeError(node, path) : undefined;
  if (nesting) {
    return nesting;
  }
  const own = scope
    ? checkOwnFields(node, path, scope, state)
    : checkLiteralKeys(node, path, state);
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
    const error = templateErrors(
      child.node,
      child.path,
      state,
      node.type === "list" && !child.path.startsWith(`${path}.children[`) ? scope : childScope,
    );
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
  return scope && typeof key === "string" && !scope.derivedFields.has(key)
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
    const maximum =
      node.type === "list" ? contract.limits.MAX_PROTOTYPE_LIST_ITEMS : MAX_REPEAT_ITEMS;
    if (items.length > maximum) {
      return fail(at, `Repeat path resolves to more than ${maximum} items`);
    }
    if (node.type === "list" && typeof node.maxItems === "number" && items.length > node.maxItems) {
      return fail(at, "List data has more items than maxItems");
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
  effects: number;
  animatedEffects: number;
  keyframeNodes: number;
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
  // A data-bound slot names a device media item, not an uploaded asset: it costs no image budget.
  if (typeof pair.data === "string") {
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

/** Charges one expanded node against every budget; returns the first limit it breaks. */
function chargeExpandedNode(
  node: Raw,
  path: string,
  budget: Budget,
  at: string,
): RepeatError | undefined {
  budget.nodes++;
  if (budget.nodes > contract.limits.MAX_PROTOTYPE_NODES) {
    return fail(at, "Expanded node limit exceeded");
  }
  budget.images += imageUses(node);
  if (budget.images > contract.limits.MAX_PROTOTYPE_IMAGES) {
    return fail(at, "Expanded image limit exceeded");
  }
  const keyframeLimit = chargeKeyframeNode(node, budget, contract.limits, path);
  if (keyframeLimit) {
    return fail(keyframeLimit.path, keyframeLimit.message);
  }
  const effects = effectUses(node);
  budget.effects += effects.total;
  budget.animatedEffects += effects.animated;
  if (budget.effects > contract.limits.MAX_PROTOTYPE_EFFECTS) {
    return fail(at, "Expanded effect limit exceeded");
  }
  if (budget.animatedEffects > contract.limits.MAX_PROTOTYPE_ANIMATED_EFFECTS) {
    return fail(at, "Expanded animated effect limit exceeded");
  }
  return undefined;
}

/** Walks the expanded tree; an overflow inside a template is reported at its `repeat`. */
function expandedErrors(
  node: Raw,
  path: string,
  budget: Budget,
  data: PrototypeRepeatData,
  repeatPath?: string,
): RepeatError | undefined {
  const overflow = chargeExpandedNode(node, path, budget, repeatPath ?? path);
  if (overflow) {
    return overflow;
  }
  const scope = scopeOf(node, path, data);
  const instances = scope && node.type !== "list" ? scope.items.length : 1;
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
    templateErrors(root, "root", { data, cells: 0, total: 0 }) ??
    expandedErrors(
      root,
      "root",
      { nodes: 0, images: 0, effects: 0, animatedEffects: 0, keyframeNodes: 0 },
      data,
      undefined,
    )
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
    // A derived key cannot be bound to its device-local string during host validation.
    if (
      scope &&
      checkedKeyValues(entry.value).some(
        (key) => typeof key === "string" && hasDerivedField(key, scope),
      )
    ) {
      return [];
    }
    const routeOperand =
      typeof entry.value.value === "string" &&
      templateFieldReferences(entry.value.value, { alias: "route", index: false }).length > 0;
    const operandTemplated =
      routeOperand ||
      (scope !== undefined &&
        typeof entry.value.value === "string" &&
        hasPlaceholder(entry.value.value, scope.binding));
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

/** Validation needs the projected field types, without reading a clock or formatting values. */
function derivedValidationItems(
  items: readonly Readonly<Raw>[],
  derive: unknown,
): readonly Readonly<Raw>[] {
  const fields = Object.fromEntries(Object.keys(record(derive) ?? {}).map((name) => [name, ""]));
  return Object.keys(fields).length ? items.map((item) => ({ ...item, ...fields })) : items;
}

function hasDerivedField(text: string, scope: Scope): boolean {
  return templateFieldReferences(text, scope.binding).some((name) => scope.derivedFields.has(name));
}

function repeatedValueError(
  kind: FieldKind,
  value: string,
  path: string,
  scope: Scope,
): RepeatError | undefined {
  // Device locale and clock determine derived strings; their value-dependent checks run there.
  if (hasDerivedField(value, scope)) {
    return undefined;
  }
  if (kind === "emitName") {
    return emptyEmitName(value, path, scope);
  }
  return kind === "key" ? invalidBoundKey(value, path, scope) : undefined;
}
