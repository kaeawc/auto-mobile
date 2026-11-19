import { z } from "zod/v3";
import type { PrototypeStackSnapshot } from "./ctrlProxyProtocol/prototypeMessages";

/** Optional navigation snapshots from newer devices; malformed entries are ignored. */
const stackEntrySchema = z
  .object({
    path: z.array(z.string().min(1)).min(1).max(32),
    depth: z.number().int().min(1).max(32),
    // Route params per entry, parallel to path (#14188).
    params: z
      .array(z.record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()])))
      .min(1)
      .max(32)
      .optional(),
  })
  .refine(
    (entry) =>
      entry.path.length === entry.depth &&
      (entry.params === undefined || entry.params.length === entry.path.length),
  );
export function parsePrototypeStacks(
  value: unknown,
): Record<string, PrototypeStackSnapshot> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value).flatMap(([id, entry]) => {
    const parsed = stackEntrySchema.safeParse(entry);
    return id && parsed.success ? [[id, parsed.data] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}
export const prototypeStacksSchema = z.unknown().optional().transform(parsePrototypeStacks);
