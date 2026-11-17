import { z } from "zod/v4";

/**
 * Marks a strict object's own unknown-key issue as aborting, so a union of such
 * arms keeps reporting every arm's issues.
 *
 * Zod 4.6 reports an unknown key as non-aborting, and a union whose only
 * non-aborted arm failed on unknown keys alone returns that arm's issues instead
 * of an `invalid_union`. For mutually exclusive single-key arms that turns
 * `{ elementId: "id", text: 123 }` into "Unrecognized key: text", hiding both the
 * conflict and the value error the tool-parameter formatter reports from the
 * per-arm issues (#16102).
 */
export function abortOnUnknownKeys<T extends z.ZodType>(schema: T): T {
  return schema.check((ctx) => {
    ctx.issues.forEach((issue, index) => {
      if (issue.code === "unrecognized_keys" && (issue.path?.length ?? 0) === 0) {
        ctx.issues[index] = { ...issue, continue: false };
      }
    });
  });
}

/** `z.union` of strict object arms that each abort on their own unknown keys. */
export function strictObjectUnion<const T extends readonly z.ZodType[]>(
  options: T,
): z.ZodUnion<Array<T[number]>> {
  return z.union(options.map((option) => abortOnUnknownKeys(option)));
}
