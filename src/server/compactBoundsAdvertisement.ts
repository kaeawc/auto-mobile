/**
 * Honest-by-default advertisement of the `bounds` output shape (issue #2990).
 *
 * `elementBoundsSchema` (`src/server/toolOutputSchemas.ts`) is a
 * `bounds-object | [left, top, right, bottom]` union so that runtime never carries
 * a shape the schema can't describe. But the tuple arm is only ever *emitted* when
 * `--observe-result-compact` is set (`finalizeToolResponse` → `sanitizeObserveResult`),
 * which is off by default. Advertising the tuple arm unconditionally would tell a
 * client generating decoders from `tools/list` to handle a shape the server will
 * never send in its default configuration.
 *
 * This mirrors the sibling `suppressOutputSchema` precedent in `toolRegistry.ts`
 * (issue #2899), which keeps the advertised shape in sync with the emitted shape by
 * dropping an `outputSchema` the finalize step would strip. Here, when compaction is
 * off, we collapse every bounds union in the already-generated JSON Schema down to
 * its object arm; when on, the union is left intact (the server emits tuples, and
 * the object|tuple union is a safe superset a compact client can decode).
 */

/**
 * Description prefix carried by the `elementBoundsSchema` union (set via its
 * `.describe(...)`). It is the stable marker used to locate bounds unions in the
 * generated JSON Schema without structurally guessing at any two-arm `anyOf`.
 */
export const BOUNDS_UNION_DESCRIPTION_PREFIX = "Element bounds. Default:";

/**
 * Return a copy of `schema` in which every `elementBoundsSchema` union is resolved
 * for the given compaction state. When `compactEnabled` is false each bounds union
 * (an `anyOf` whose description starts with {@link BOUNDS_UNION_DESCRIPTION_PREFIX})
 * is collapsed to its object arm, preserving the union's description so the prose
 * still notes the tuple exists under the flag. When true the input is returned
 * unchanged. Pure: never mutates `schema`.
 */
export function advertiseBoundsForCompact(schema: unknown, compactEnabled: boolean): unknown {
  if (compactEnabled) {
    return schema;
  }
  return collapseBoundsUnions(schema);
}

function collapseBoundsUnions(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(collapseBoundsUnions);
  }
  if (!node || typeof node !== "object") {
    return node;
  }

  const obj = node as Record<string, unknown>;
  const anyOf = obj.anyOf;
  if (
    Array.isArray(anyOf) &&
    typeof obj.description === "string" &&
    obj.description.startsWith(BOUNDS_UNION_DESCRIPTION_PREFIX)
  ) {
    const objectArm = anyOf.find(
      (arm): arm is Record<string, unknown> =>
        !!arm && typeof arm === "object" && (arm as Record<string, unknown>).type === "object"
    );
    if (objectArm) {
      // Keep the union's description (it names the tuple order + enabling flag) so
      // the object-only advertisement still documents the compact form in prose.
      return { ...collapseBoundsUnions(objectArm), description: obj.description };
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = collapseBoundsUnions(value);
  }
  return out;
}
