/** A shallow keyword view for schema post-processors, without expanding recursive children. */
export function resolveJsonSchemaReference(
  root: Record<string, unknown>,
  node: Record<string, unknown>,
): Record<string, unknown> {
  const visited = new Set<string>();
  let current = node;
  while (typeof current.$ref === "string" && !visited.has(current.$ref)) {
    visited.add(current.$ref);
    const target = localJsonSchemaTarget(root, current.$ref);
    const { $ref: _ref, ...siblings } = current;
    void _ref;
    current = Object.keys(siblings).length ? { ...target, ...siblings } : target;
  }
  return current;
}

function localJsonSchemaTarget(
  root: Record<string, unknown>,
  reference: string,
): Record<string, unknown> {
  if (reference !== "#" && !reference.startsWith("#/")) {
    throw new Error(`Expected a document-local JSON Schema reference: ${reference}`);
  }
  let target: unknown = root;
  const pointer = decodeURIComponent(reference.slice(1));
  for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!target || typeof target !== "object" || !Object.hasOwn(target, key)) {
      throw new Error(`Unresolved JSON Schema reference: ${reference}`);
    }
    target = (target as Record<string, unknown>)[key];
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error(`Expected a JSON Schema object at ${reference}`);
  }
  return target as Record<string, unknown>;
}

/**
 * Visit response-level alternatives without entering properties. Materialize a
 * referenced arm at its use site first: a response-only override must not mutate
 * a definition that is also used by nested values.
 */
export function visitJsonSchemaAlternatives(
  root: Record<string, unknown>,
  visit: (node: Record<string, unknown>) => void,
): void {
  const visited = new Set<unknown>();
  const references = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object" || Array.isArray(node) || visited.has(node)) {
      return;
    }
    visited.add(node);
    const object = node as Record<string, unknown>;
    const reference = typeof object.$ref === "string" ? object.$ref : node;
    if (references.has(reference)) {
      return;
    }
    references.add(reference);
    const resolved = resolveJsonSchemaReference(root, object);
    if (resolved !== object) {
      const copy = structuredClone(resolved);
      for (const key of Object.keys(object)) {
        delete object[key];
      }
      Object.assign(object, copy);
    }
    visit(object);
    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      const branches = object[keyword];
      if (Array.isArray(branches)) {
        branches.forEach(walk);
      }
    }
    references.delete(reference);
  };
  walk(root);
}
