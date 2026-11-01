import { z } from "zod/v4";

/** Identifiers and outcomes only. Unknown fields are stripped at both levels. */
export const keystoreResetSchema = z.object({
  schemaVersion: z.literal(1),
  capability: z.literal("storage.keystore"),
  outcome: z.enum([
    "ok",
    "disabled",
    "unavailable",
    "unsupported",
    "scope_not_declared",
    "authorization_denied",
    "invalid_selector",
  ]),
  reason: z
    .enum([
      "DISABLED",
      "BRIDGE_NOT_INSTALLED",
      "BRIDGE_UNAVAILABLE",
      "DECLARED_UNSUPPORTED",
      "SCOPE_NOT_DECLARED",
      "MUTATION_NOT_ALLOWED",
      "EMPTY_SELECTOR",
    ])
    .nullable()
    .optional(),
  bridgeAvailable: z.boolean(),
  requestedScope: z.string().nullable().optional(),
  requestedAlias: z.string().nullable().optional(),
  status: z.enum(["deleted", "partial", "failed"]).nullish(),
  deletedCount: z.number().int().nonnegative(),
  aliases: z
    .array(
      z.object({
        alias: z.string(),
        outcome: z.enum(["deleted", "not_found", "locked", "authentication_required", "failed"]),
      }),
    )
    .nullish(),
});
export type KeystoreReset = z.infer<typeof keystoreResetSchema>;
/** Narrow transport seam for deterministic action tests. */
export interface KeystoreResetBackend {
  resetKeystore(packageName: string, scope?: string, alias?: string): Promise<KeystoreReset>;
}
