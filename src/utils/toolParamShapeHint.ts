import type { ZodIssue } from "zod/v4";

// A tool argument-shape error (unknown key, an object or array where something
// else was sent, a missing required key) is fixed by knowing the shape, not by
// the issue text alone. This module reads the shape off the tool's own Zod input
// schema — never a hand-written per-tool list — so every tool gets the same hint
// and it cannot drift as parameters change (#17666).

interface ZodDefLike {
  type?: string;
  shape?: Record<string, unknown>;
  in?: unknown;
  out?: unknown;
  innerType?: unknown;
  element?: unknown;
  options?: readonly unknown[];
  entries?: Record<string, unknown>;
  values?: readonly unknown[];
  getter?: () => unknown;
  left?: unknown;
  right?: unknown;
}

interface ZodNodeLike {
  def?: ZodDefLike;
  minValue?: number | null;
  _zod?: { optin?: string };
  safeParse?: (value: unknown) => { success: boolean };
}

const MAX_DEPTH = 12;
// A hint lists only the keys relevant to the error path, required ones first;
// the full list made hints run past 500 characters (#17675).
const MAX_KEYS_LISTED = 8;

const WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "catch",
  "readonly",
  "nonoptional",
]);

function asNode(value: unknown): ZodNodeLike | undefined {
  return typeof value === "object" && value !== null ? (value as ZodNodeLike) : undefined;
}

interface ResolvedNode {
  readonly node: ZodNodeLike;
  readonly def: ZodDefLike;
}

function resolve(schema: unknown, depth: number): ResolvedNode | undefined {
  const node = asNode(schema);
  return node?.def && depth <= MAX_DEPTH ? { node, def: node.def } : undefined;
}

const NOT_A_WRAPPER: unique symbol = Symbol("not-a-wrapper");

// The schema a wrapper stands for. A pipe's two ends are a transform and a
// schema in either order (`z.preprocess` puts the transform first,
// `.transform()` last), so the end that is not a transform wins.
function innerOf(def: ZodDefLike): unknown {
  if (def.type && WRAPPER_TYPES.has(def.type)) {
    return def.innerType;
  }
  if (def.type === "lazy") {
    return def.getter?.();
  }
  if (def.type === "pipe") {
    return asNode(def.out)?.def?.type === "transform" ? def.in : def.out;
  }
  return NOT_A_WRAPPER;
}

// Strip wrappers down to the schema that carries the shape.
function unwrap(schema: unknown, depth = 0): ResolvedNode | undefined {
  const resolved = resolve(schema, depth);
  if (!resolved) {
    return undefined;
  }
  const inner = innerOf(resolved.def);
  return inner === NOT_A_WRAPPER ? resolved : unwrap(inner, depth + 1);
}

// The alternatives a union or intersection stands for, or `undefined` for any
// other node.
function alternativesOf(def: ZodDefLike): readonly unknown[] | undefined {
  if (def.type === "union" && Array.isArray(def.options)) {
    return def.options;
  }
  return def.type === "intersection" ? [def.left, def.right] : undefined;
}

// The schema one path segment below `def`, or `undefined` when there is none.
function childOf(def: ZodDefLike, segment: PropertyKey): unknown {
  if (def.type === "array") {
    return typeof segment === "number" ? def.element : undefined;
  }
  const shape = def.type === "object" ? def.shape : undefined;
  return shape && typeof segment === "string" && Object.hasOwn(shape, segment)
    ? shape[segment]
    : undefined;
}

// Every shape the value at `path` may take: union arms fan out, array indices
// step into the element schema, object keys into their property.
function schemasAt(schema: unknown, path: ReadonlyArray<PropertyKey>, depth = 0): ZodNodeLike[] {
  const resolved = unwrap(schema, depth);
  if (!resolved) {
    return [];
  }
  const alternatives = alternativesOf(resolved.def);
  if (alternatives) {
    return alternatives.flatMap((option) => schemasAt(option, path, depth + 1));
  }
  if (path.length === 0) {
    return [resolved.node];
  }
  const [head, ...rest] = path;
  const child = childOf(resolved.def, head);
  return child === undefined ? [] : schemasAt(child, rest, depth + 1);
}

// The keys an object (or any arm of a union of objects, or an array's element
// objects) at `path` accepts, in declaration order.
export function allowedKeysAt(schema: unknown, path: ReadonlyArray<PropertyKey>): string[] {
  const keys = schemasAt(schema, path).flatMap((node) => {
    const def = node.def;
    if (def?.type === "array") {
      return allowedKeysAt(def.element, []);
    }
    return def?.type === "object" && def.shape ? Object.keys(def.shape) : [];
  });
  return [...new Set(keys)];
}

function isOptional(schema: unknown): boolean {
  return asNode(schema)?._zod?.optin === "optional";
}

function parses(schema: unknown, value: unknown): boolean {
  const node = asNode(schema);
  return typeof node?.safeParse === "function" && node.safeParse(value).success;
}

// `nonEmpty` adds the first derivable optional key when every key is optional,
// so an example for an all-optional object such as `searchUntil` shows a field.
function exampleObject(shape: Record<string, unknown>, depth: number, nonEmpty = false): unknown {
  const entries: Array<[string, unknown]> = [];
  for (const [key, property] of Object.entries(shape)) {
    if (isOptional(property)) {
      continue;
    }
    const value = exampleValue(property, key, depth + 1);
    if (value === undefined) {
      return undefined;
    }
    entries.push([key, value]);
  }
  if (nonEmpty && entries.length === 0) {
    const first = Object.entries(shape)
      .map(([key, property]): [string, unknown] => [key, exampleValue(property, key, depth + 1)])
      .find(([, value]) => value !== undefined);
    return first ? Object.fromEntries([first]) : {};
  }
  return Object.fromEntries(entries);
}

function exampleScalar(node: ZodNodeLike, label: string): unknown {
  const def = node.def ?? {};
  switch (def.type) {
    case "string":
      return `<${label}>`;
    case "number":
    case "int":
      return typeof node.minValue === "number" && Number.isFinite(node.minValue)
        ? Math.max(0, node.minValue)
        : 0;
    case "boolean":
      return true;
    case "enum":
      return def.entries ? Object.values(def.entries)[0] : undefined;
    case "literal":
      return def.values?.[0];
    default:
      return undefined;
  }
}

function exampleOfFirstArm(options: readonly unknown[], label: string, depth: number): unknown {
  for (const option of options) {
    const candidate = exampleValue(option, label, depth + 1);
    if (candidate !== undefined && parses(option, candidate)) {
      return candidate;
    }
  }
  return undefined;
}

// The smallest value that satisfies `schema`: required keys only, the first
// union arm that produces a valid value, one array element, and placeholder
// strings named after their key. `undefined` when no such value is derivable.
function exampleValue(schema: unknown, label: string, depth = 0, nonEmpty = false): unknown {
  const resolved = unwrap(schema, depth);
  if (!resolved) {
    return undefined;
  }
  const { node, def } = resolved;
  if (def.type === "union" && Array.isArray(def.options)) {
    return exampleOfFirstArm(def.options, label, depth);
  }
  if (def.type === "object" && def.shape) {
    return exampleObject(def.shape, depth, nonEmpty);
  }
  if (def.type === "array") {
    const element = exampleValue(def.element, label, depth + 1);
    return element === undefined ? undefined : [element];
  }
  return exampleScalar(node, label);
}

/** A minimal call the schema accepts, or `undefined` when none can be derived. */
export function minimalExample(schema: unknown): Record<string, unknown> | undefined {
  const example = exampleValue(schema, "value");
  const isRecord = typeof example === "object" && example !== null && !Array.isArray(example);
  return isRecord && parses(schema, example) ? (example as Record<string, unknown>) : undefined;
}

function isMissing(rawInput: unknown, path: ReadonlyArray<PropertyKey>): boolean {
  let current = rawInput;
  for (const segment of path) {
    if (current === null || typeof current !== "object") {
      return true;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current === undefined;
}

// The object whose shape the caller got wrong, or `undefined` when the issue is
// about a value (a bad enum, a number out of range), not the shape.
function shapeOwnerPath(
  issue: ZodIssue,
  rawInput: unknown,
): ReadonlyArray<PropertyKey> | undefined {
  if (issue.code === "unrecognized_keys") {
    return issue.path;
  }
  if (issue.code === "invalid_type") {
    if (issue.expected === "object" || issue.expected === "array") {
      return issue.path;
    }
    return isMissing(rawInput, issue.path) ? issue.path.slice(0, -1) : undefined;
  }
  if (issue.code === "invalid_union" && issue.path.length > 0) {
    // A discriminated union with no matching discriminator reports at the
    // discriminator key; its owner is the object that carries it.
    return issue.path.slice(0, -1);
  }
  return undefined;
}

function displayPath(path: ReadonlyArray<PropertyKey>): string {
  return path
    .map((segment) => (typeof segment === "number" ? "[]" : `.${String(segment)}`))
    .join("")
    .replace(/^\./, "");
}

function requiredKeysAt(schema: unknown, path: ReadonlyArray<PropertyKey>): Set<string> {
  const objects = schemasAt(schema, path).flatMap((node) => {
    const def = node.def;
    return def?.type === "array" ? schemasAt(def.element, []) : [node];
  });
  const required = objects.flatMap((node) => {
    const shape = node.def?.type === "object" ? node.def.shape : undefined;
    return shape ? Object.keys(shape).filter((key) => !isOptional(shape[key])) : [];
  });
  return new Set(required);
}

function formatKeyList(keys: readonly string[], maxKeys: number): string {
  const listed = keys.slice(0, maxKeys).join(", ");
  const more = keys.length > maxKeys ? `, … (${keys.length - maxKeys} more)` : "";
  return `${listed}${more}`;
}

// Where each unknown key at `path` is accepted one level down, e.g. a top-level
// `text` that belongs inside `selector`. Empty when no child object takes it.
function relocationLines(
  schema: unknown,
  path: ReadonlyArray<PropertyKey>,
  unknownKeys: readonly string[],
): string[] {
  const children = allowedKeysAt(schema, path);
  // A union arm reports a key another arm accepts as unknown; only a key no arm
  // at `path` takes is misplaced.
  const misplaced = [...new Set(unknownKeys)].filter((key) => !children.includes(key));
  return misplaced.flatMap((key) => {
    const owners = children.filter((child) =>
      allowedKeysAt(schema, [...path, child]).includes(key),
    );
    if (owners.length === 0) {
      return [];
    }
    const under = owners.map((child) => displayPath([...path, child])).join(", ");
    return [`"${key}" belongs under ${under}.`];
  });
}

function keysLine(
  schema: unknown,
  path: ReadonlyArray<PropertyKey>,
  unknownKeys: readonly string[],
  maxKeys = MAX_KEYS_LISTED,
): string | undefined {
  const relocations = relocationLines(schema, path, unknownKeys);
  if (relocations.length > 0) {
    return relocations.join(" ");
  }
  const keys = allowedKeysAt(schema, path);
  if (keys.length === 0) {
    return undefined;
  }
  const required = requiredKeysAt(schema, path);
  const ordered = [
    ...keys.filter((key) => required.has(key)),
    ...keys.filter((key) => !required.has(key)),
  ];
  const owner = path.length === 0 ? "Allowed keys" : `Allowed ${displayPath(path)} keys`;
  return `${owner}: ${formatKeyList(ordered, maxKeys)}.`;
}

/**
 * The keys line for unknown top-level keys alone, listing at most `maxKeys`, for
 * a tool-specific hint that covers every other error but not those keys (#17680).
 * Empty when there are no unknown keys or the schema derives no line.
 */
export function topLevelKeysHint(
  schema: unknown,
  unknownKeys: readonly string[],
  maxKeys: number,
): string {
  if (schema === undefined || unknownKeys.length === 0) {
    return "";
  }
  return keysLine(schema, [], unknownKeys, maxKeys) ?? "";
}

// The minimal call, extended with the top-level key each error path sits under
// when the minimal call leaves it out (an optional `searchUntil`), so the
// example shows the object the caller got wrong.
function exampleFor(
  schema: unknown,
  paths: ReadonlyArray<ReadonlyArray<PropertyKey>>,
): Record<string, unknown> | undefined {
  const base = minimalExample(schema);
  if (base === undefined) {
    return undefined;
  }
  const extended = { ...base };
  for (const [head] of paths) {
    if (typeof head !== "string" || Object.hasOwn(extended, head)) {
      continue;
    }
    const [child] = schemasAt(schema, [head]);
    const value = child === undefined ? undefined : exampleValue(child, head, 0, true);
    if (value !== undefined) {
      extended[head] = value;
    }
  }
  return parses(schema, extended) ? extended : base;
}

interface ShapeOwner {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly unknownKeys: string[];
}

function collectOwners(
  issues: ReadonlyArray<ZodIssue>,
  rawInput: unknown,
): Map<string, ShapeOwner> {
  const owners = new Map<string, ShapeOwner>();
  for (const issue of issues) {
    const path = shapeOwnerPath(issue, rawInput);
    if (!path) {
      continue;
    }
    const id = displayPath(path);
    const owner = owners.get(id) ?? { path, unknownKeys: [] };
    if (issue.code === "unrecognized_keys") {
      owner.unknownKeys.push(...issue.keys.map(String));
    }
    owners.set(id, owner);
  }
  return owners;
}

/**
 * Hint for argument-shape errors: the keys relevant to each object the caller
 * shaped wrong, then a minimal valid call. Empty when no issue is about shape.
 */
export function formatShapeHint(
  toolName: string,
  schema: unknown,
  issues: ReadonlyArray<ZodIssue>,
  rawInput: unknown,
): string {
  if (schema === undefined) {
    return "";
  }
  const owners = [...collectOwners(issues, rawInput).values()];
  if (owners.length === 0) {
    return "";
  }
  const lines = owners
    .map(({ path, unknownKeys }) => keysLine(schema, path, unknownKeys))
    .filter((line): line is string => line !== undefined);
  const example = exampleFor(
    schema,
    owners.map(({ path }) => path),
  );
  if (example !== undefined) {
    lines.push(`Example: ${toolName}(${JSON.stringify(example)})`);
  }
  return lines.join(" ");
}
