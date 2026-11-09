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
const MAX_KEYS_LISTED = 40;

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

function exampleObject(shape: Record<string, unknown>, depth: number): unknown {
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
function exampleValue(schema: unknown, label: string, depth = 0): unknown {
  const resolved = unwrap(schema, depth);
  if (!resolved) {
    return undefined;
  }
  const { node, def } = resolved;
  if (def.type === "union" && Array.isArray(def.options)) {
    return exampleOfFirstArm(def.options, label, depth);
  }
  if (def.type === "object" && def.shape) {
    return exampleObject(def.shape, depth);
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

function keysLine(schema: unknown, path: ReadonlyArray<PropertyKey>): string | undefined {
  const keys = allowedKeysAt(schema, path);
  if (keys.length === 0) {
    return undefined;
  }
  const listed = keys.slice(0, MAX_KEYS_LISTED).join(", ");
  const more = keys.length > MAX_KEYS_LISTED ? `, … (${keys.length - MAX_KEYS_LISTED} more)` : "";
  const owner = path.length === 0 ? "Allowed keys" : `Allowed ${displayPath(path)} keys`;
  return `${owner}: ${listed}${more}.`;
}

/**
 * Hint for argument-shape errors: the allowed keys of every object the caller
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
  const owners = new Map<string, ReadonlyArray<PropertyKey>>();
  for (const issue of issues) {
    const owner = shapeOwnerPath(issue, rawInput);
    if (owner && !owners.has(displayPath(owner))) {
      owners.set(displayPath(owner), owner);
    }
  }
  if (owners.size === 0) {
    return "";
  }
  const lines = [...owners.values()]
    .map((path) => keysLine(schema, path))
    .filter((line): line is string => line !== undefined);
  const example = minimalExample(schema);
  if (example !== undefined) {
    lines.push(`Example: ${toolName}(${JSON.stringify(example)})`);
  }
  return lines.join(" ");
}
