import { AndroidAvdProvenanceCache } from "./AndroidAvdProvenanceCache";
import { resetAndroidInventoryEnrichmentCache } from "./android-cmdline-tools/AndroidEmulatorClient";

// Resource ownership stays in the server; lifecycle code must not import that layer.
let invalidateCatalog: (() => void) | undefined;

export function registerAndroidInventoryCatalogInvalidator(invalidator: () => void): void {
  invalidateCatalog = invalidator;
}

/** Successful AVD/system-image mutations and shutdown invalidate durable inventory once. */
export function invalidateAndroidInventoryProvenanceAndCatalog(): void {
  AndroidAvdProvenanceCache.getInstance().invalidate();
  resetAndroidInventoryEnrichmentCache();
  invalidateCatalog?.();
}
