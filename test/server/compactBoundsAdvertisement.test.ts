import { describe, expect, test } from "bun:test";
import { toJSONSchema } from "zod/v4";
import {
  advertiseBoundsForCompact,
  BOUNDS_UNION_DESCRIPTION_PREFIX,
} from "../../src/server/compactBoundsAdvertisement";
import { tapOnResultSchema } from "../../src/server/toolOutputSchemas";

/**
 * Honest-by-default advertisement of the compact bounds tuple (issue #2990).
 * When `--observe-result-compact` is off the server never emits tuple bounds, so the
 * advertised `tools/list` schema must not offer the tuple arm; when on, the union is
 * left intact. Mirrors the `suppressOutputSchema` precedent (#2899).
 */
describe("advertiseBoundsForCompact (#2990)", () => {
  const boundsJson = () => toJSONSchema(tapOnResultSchema);

  const findBounds = (schema: unknown): Record<string, unknown> => {
    // Depth-first search for the elementBoundsSchema node by its description marker.
    const stack: unknown[] = [schema];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) {
        stack.push(...node);
      } else if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        if (
          typeof obj.description === "string" &&
          obj.description.startsWith(BOUNDS_UNION_DESCRIPTION_PREFIX)
        ) {
          return obj;
        }
        stack.push(...Object.values(obj));
      }
    }
    throw new Error("no bounds node found");
  };

  test("compact ON: the object|tuple union is advertised intact", () => {
    const out = advertiseBoundsForCompact(boundsJson(), true);
    const bounds = findBounds(out);
    expect(Array.isArray(bounds.anyOf)).toBe(true);
    const arms = bounds.anyOf as Array<Record<string, unknown>>;
    expect(arms.some((a) => a.type === "array")).toBe(true); // tuple arm present
    expect(arms.some((a) => a.type === "object")).toBe(true);
  });

  test("compact OFF: the tuple arm is dropped, object arm advertised", () => {
    const out = advertiseBoundsForCompact(boundsJson(), false);
    const bounds = findBounds(out);
    // No union any more — collapsed to the object arm.
    expect(bounds.anyOf).toBeUndefined();
    expect(bounds.type).toBe("object");
    expect((bounds.properties as Record<string, unknown>).left).toBeDefined();
    expect((bounds.properties as Record<string, unknown>).bottom).toBeDefined();
    // Description is preserved so the prose still documents the positional tuple order.
    expect(bounds.description).toContain("left, top, right, bottom");
  });

  /**
   * Strip every `skeleton` property node from a JSON-Schema tree (recursively,
   * any depth/nesting — `anyOf` arms included). Mirrors the equivalent exclusion
   * in `observeOutputSchema.test.ts`: the `skeleton` projection field (#4388,
   * embedded on `tapOnResultSchema.observation`'s diff arm since issue #6221 item
   * 4.1) carries a deliberately ALWAYS-tuple bounds that never depends on
   * `--observe-result-compact`, so it is not a collapsible bounds *union* and
   * must be excluded before asserting the union-collapse invariant below.
   */
  function stripSkeletonNodes(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map(stripSkeletonNodes);
    }
    if (node && typeof node === "object") {
      // `context` (issue #6256) shares `skeleton`'s always-compact-tuple bounds
      // schema, so it must be stripped here too.
      const { skeleton: _skeleton, context: _context, ...rest } = node as Record<string, unknown>;
      void _skeleton;
      void _context;
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        out[key] = stripSkeletonNodes(value);
      }
      return out;
    }
    return node;
  }

  test("compact OFF advertises no positional tuple anywhere in the schema", () => {
    const out = advertiseBoundsForCompact(boundsJson(), false);
    const json = JSON.stringify(stripSkeletonNodes(out));
    // The tuple arm renders as a JSON-Schema array with prefixItems; none should remain.
    expect(json).not.toContain("prefixItems");
  });

  test("is pure — does not mutate its input", () => {
    const input = boundsJson();
    const snapshot = JSON.stringify(input);
    advertiseBoundsForCompact(input, false);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("leaves schemas without a bounds union untouched", () => {
    const plain = { type: "object", properties: { success: { type: "boolean" } } };
    expect(advertiseBoundsForCompact(plain, false)).toEqual(plain);
    expect(advertiseBoundsForCompact(plain, true)).toBe(plain);
  });
});
