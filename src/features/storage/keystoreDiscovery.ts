import { z } from "zod";

/** Narrow wire schema; parsing strips any unexpected payload fields. */
export const keystoreDiscoverySchema = z.object({
  schemaVersion: z.literal(1),
  capability: z.literal("storage.keystore"),
  outcome: z.enum([
    "ok",
    "disabled",
    "unavailable",
    "unsupported",
    "locked",
    "authentication_required",
    "scope_not_declared",
  ]),
  reason: z
    .enum([
      "DISABLED",
      "KEYSTORE_UNAVAILABLE",
      "DECLARED_UNSUPPORTED",
      "DEVICE_LOCKED",
      "AUTHENTICATION_REQUIRED",
      "SCOPE_NOT_DECLARED",
      "BRIDGE_NOT_INSTALLED",
      "BRIDGE_UNAVAILABLE",
    ])
    .nullable()
    .optional(),
  bridgeAvailable: z.boolean(),
  metadata: z.literal("supported"),
  mutation: z.literal("declared_unsupported"),
  deviceLocked: z.enum(["locked", "unlocked", "unknown"]),
  scopes: z.array(z.string()),
});
export type KeystoreDiscoveryState = z.infer<typeof keystoreDiscoverySchema>;

/** Existing Android test-control boundary; resources inject a fake instead of connecting. */
export interface KeystoreDiscovery {
  discoverKeystore(packageName: string): Promise<KeystoreDiscoveryState>;
}
