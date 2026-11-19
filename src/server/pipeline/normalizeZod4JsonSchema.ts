/**
 * Zod 4.6 string checks that already emit a `pattern` (`startsWith`, `endsWith`,
 * `includes`) also emit a non-standard `format` naming the check. The pattern
 * carries the constraint; the format is not a JSON Schema format and strict
 * validators warn on it.
 */
const NON_STANDARD_CHECK_FORMATS = new Set(["starts_with", "ends_with", "includes"]);

const DEF_PREFIX = "#/$defs/";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNode(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(normalizeNode);
    return;
  }
  if (!isJsonObject(node)) {
    return;
  }
  Object.values(node).forEach(normalizeNode);
  if (typeof node.format === "string" && NON_STANDARD_CHECK_FORMATS.has(node.format)) {
    delete node.format;
  }
  const type = node.type;
  if (!Array.isArray(type) || node.anyOf !== undefined) {
    return;
  }
  delete node.type;
  node.anyOf = type.map((member) => ({ type: member }));
}

function defName(node: unknown): string | undefined {
  if (!isJsonObject(node) || typeof node.$ref !== "string" || !node.$ref.startsWith(DEF_PREFIX)) {
    return undefined;
  }
  return node.$ref.slice(DEF_PREFIX.length);
}

function forEachNode(node: unknown, visit: (node: JsonObject) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => forEachNode(child, visit));
    return;
  }
  if (!isJsonObject(node)) {
    return;
  }
  visit(node);
  Object.values(node).forEach((child) => forEachNode(child, visit));
}

function referencedDefs(node: unknown): string[] {
  const names: string[] = [];
  forEachNode(node, (child) => {
    const name = defName(child);
    if (name !== undefined) {
      names.push(name);
    }
  });
  return names;
}

function reachesItself(defs: JsonObject, start: string): boolean {
  const seen = new Set<string>();
  const pending = referencedDefs(defs[start]);
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (name === start) {
      return true;
    }
    if (!seen.has(name) && Object.hasOwn(defs, name)) {
      seen.add(name);
      pending.push(...referencedDefs(defs[name]));
    }
  }
  return false;
}

/**
 * Zod 4.6 with `reused: "ref"` also extracts a schema wrapped once by
 * `.optional()`/`.describe()` into `$defs`. Inline every definition referenced
 * exactly once that cannot reach itself, so only shared and recursive schemas stay
 * behind a `$ref`.
 */
function inlineSingleUseDefs(root: JsonObject): void {
  const defs = root.$defs;
  if (!isJsonObject(defs)) {
    return;
  }
  const references = referencedDefs(root);
  const singleUse = (name: string): boolean =>
    references.indexOf(name) !== -1 && references.indexOf(name) === references.lastIndexOf(name);
  const inlined = new Set(
    Object.keys(defs).filter((name) => singleUse(name) && !reachesItself(defs, name)),
  );
  if (inlined.size === 0) {
    return;
  }
  const expand = (node: JsonObject): void => {
    // A definition can itself be a bare `$ref` to another single-use definition.
    for (let name = defName(node); name !== undefined && inlined.has(name); name = defName(node)) {
      const { $ref: _ref, ...siblings } = node;
      void _ref;
      delete node.$ref;
      Object.assign(node, defs[name], siblings);
    }
  };
  forEachNode(root, expand);
  inlined.forEach((name) => delete defs[name]);
  if (Object.keys(defs).length === 0) {
    delete root.$defs;
  }
}

/**
 * Restores the advertised tool contract's spelling of a Zod 4.6 JSON Schema, in
 * place (#16102):
 * - Zod 4.6 folds `anyOf: [{type: "a"}, {type: "b"}]` into `type: ["a", "b"]`. The
 *   forms are equivalent, but the contract has always spelled a union of bare types
 *   as `anyOf` of single-type branches, and MCP clients that model `type` as one
 *   string reject the array form.
 * - Drops the non-standard check formats above.
 * - Inlines single-use, non-recursive `$defs` entries.
 */
export function normalizeZod4JsonSchema(node: unknown): void {
  normalizeNode(node);
  if (isJsonObject(node)) {
    inlineSingleUseDefs(node);
  }
}
