#!/usr/bin/env bun
/**
 * Enable host feature flags in the AutoMobile database before the server starts, for CI lanes
 * that have no IDE plugin to flip them (#16746). Point `AUTOMOBILE_DB_PATH` at a run-private
 * database first so a developer's own flags are never touched.
 *
 * Usage: bun scripts/ci/aaos-smoke/enableFeatureFlags.ts device-condition [more-flags...]
 */
import {
  FEATURE_FLAG_DEFINITIONS,
  type FeatureFlagKey,
} from "../../../src/models/FeatureFlagDefinitions";

/** Validate requested keys against the known flag set; throws naming every unknown key. */
export function parseFeatureFlagKeys(args: readonly string[]): FeatureFlagKey[] {
  if (args.length === 0) {
    throw new Error("usage: enableFeatureFlags.ts <flag-key> [flag-key...]");
  }
  const known = new Set<string>(FEATURE_FLAG_DEFINITIONS.map((definition) => definition.key));
  const unknown = args.filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`unknown feature flag(s): ${unknown.join(", ")}`);
  }
  return args as FeatureFlagKey[];
}

/** The flag-setting surface this script needs; faked in tests. */
export interface FeatureFlagWriter {
  setFlag(key: FeatureFlagKey, enabled: boolean): Promise<unknown>;
}

export async function enableFeatureFlags(
  keys: readonly FeatureFlagKey[],
  writer: FeatureFlagWriter,
): Promise<void> {
  for (const key of keys) {
    await writer.setFlag(key, true);
  }
}

async function main(): Promise<void> {
  const keys = parseFeatureFlagKeys(process.argv.slice(2));
  if (!process.env.AUTOMOBILE_DB_PATH) {
    throw new Error("AUTOMOBILE_DB_PATH must name a run-private database");
  }
  const { ensureMigrations, closeDatabase } = await import("../../../src/db/database");
  const { FeatureFlagService } =
    await import("../../../src/features/featureFlags/FeatureFlagService");
  await ensureMigrations();
  try {
    await enableFeatureFlags(keys, FeatureFlagService.getInstance());
  } finally {
    await closeDatabase();
  }
  console.log(`Enabled feature flags: ${keys.join(", ")}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`enableFeatureFlags: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
