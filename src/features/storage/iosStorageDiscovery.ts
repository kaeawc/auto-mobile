import { z } from "zod";

/**
 * iOS Keychain capability and shared-store states the AutoMobile SDK reports in its
 * storage capability payload (#5161). Parsing keeps only these contract fields, so a
 * Keychain value or store contents can never pass through even if a payload carried
 * them. Values are never read: `inspection` is unavailable until a host inspection
 * adapter exists, and deletion is limited to the exact allowlisted selectors that
 * `deleteKeychainItem` accepts.
 */
const keychainDeletionScopeSchema = z.object({
  itemClass: z.literal("genericPassword"),
  service: z.string(),
  account: z.string(),
  accessGroup: z.string(),
});

export const keychainCapabilitySchema = z.object({
  schemaVersion: z.literal(1),
  capability: z.literal("storage.keychain"),
  inspection: z.literal("unavailable"),
  deletion: z.enum(["enabled", "disabled", "unknown"]),
  reason: z
    .enum(["DISABLED", "NO_ALLOWLISTED_SCOPES", "SDK_TOO_OLD", "BRIDGE_UNAVAILABLE"])
    .nullable()
    .optional(),
  deletionScopes: z.array(keychainDeletionScopeSchema),
});

export const storeStateSchema = z.object({
  kind: z.enum(["user_defaults_suite", "core_data"]),
  identifier: z.string(),
  sharing: z.enum(["app_private", "app_group"]),
  appGroup: z.string().nullable().optional(),
  coordination: z.enum(["single_process", "uncoordinated", "host_coordinated"]),
  query: z.enum(["supported", "unsupported"]),
  reason: z.string().nullable().optional(),
});

export type KeychainCapabilityState = z.infer<typeof keychainCapabilitySchema>;
export type StoreState = z.infer<typeof storeStateSchema>;

export interface IosStorageDiscovery {
  keychain: KeychainCapabilityState;
  stores: StoreState[];
}

/** The iOS runner path the resource uses; tests inject a fake instead of connecting. */
export interface IosStorageDiscoverer {
  discoverIosStorage(appId: string): Promise<IosStorageDiscovery>;
}

function unknownKeychain(reason: "SDK_TOO_OLD" | "BRIDGE_UNAVAILABLE"): KeychainCapabilityState {
  return {
    schemaVersion: 1,
    capability: "storage.keychain",
    inspection: "unavailable",
    deletion: "unknown",
    reason,
    deletionScopes: [],
  };
}

/** The SDK storage capability payload reduced to the #5161 contract fields. */
export function parseIosStorageDiscovery(capabilities: unknown): IosStorageDiscovery {
  const payload =
    typeof capabilities === "object" && capabilities !== null
      ? (capabilities as Record<string, unknown>)
      : {};
  const keychain = keychainCapabilitySchema.safeParse(payload.keychain);
  const stores = Array.isArray(payload.stores) ? payload.stores : [];
  return {
    // An SDK that predates #5161, or sends a malformed capability, is reported as too
    // old rather than read as "disabled", which would be a guess.
    keychain: keychain.success ? keychain.data : unknownKeychain("SDK_TOO_OLD"),
    // A malformed entry is dropped on its own so it cannot hide the valid ones.
    stores: stores.flatMap((entry) => {
      const parsed = storeStateSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

export function unavailableIosStorageDiscovery(): IosStorageDiscovery {
  return { keychain: unknownKeychain("BRIDGE_UNAVAILABLE"), stores: [] };
}
