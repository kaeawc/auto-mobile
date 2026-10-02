/** Trailing slashes require a non-empty directory in npm's POSIX file manifest. */
export const REQUIRED_PACKED_RUNTIME_ASSETS: readonly string[] = [
  "dist/src/index.js",
  "dist/src/utils/workers/iosBundleExtractWorker.js",
  "dist/schemas/test-plan.schema.json",
  "schemas/test-plan.schema.json",
  // FileMigrationProvider resolves db/migrations beside the bundled index.js.
  "dist/src/db/migrations/",
  // Raw migrations import this sibling, copied by copyDatabaseRuntimeFiles.
  "dist/src/db/eventTables.ts",
  // WebpBinaryResolver resolves both tools from the published dist project root.
  "dist/vendor/libwebp/win32-x64/cwebp.exe",
  "dist/vendor/libwebp/win32-x64/dwebp.exe",
];

export const FORBIDDEN_PACKED_ASSETS: readonly string[] = [
  "schemas/tool-definitions.json",
  "dist/schemas/tool-definitions.json",
];

export function findMissingPackedAssets(
  packedPaths: readonly string[],
  requiredPaths: readonly string[],
): string[] {
  const packed = new Set(packedPaths);
  return requiredPaths.filter((required) =>
    required.endsWith("/")
      ? !packedPaths.some((entry) => entry.startsWith(required) && entry.length > required.length)
      : !packed.has(required),
  );
}

export function findPackedAssetViolations(packedPaths: readonly string[]): string[] {
  const missing = findMissingPackedAssets(packedPaths, REQUIRED_PACKED_RUNTIME_ASSETS);
  const forbidden = FORBIDDEN_PACKED_ASSETS.filter((entry) => packedPaths.includes(entry));
  return [
    ...missing.map((entry) => `Missing runtime asset: ${entry}`),
    ...forbidden.map((entry) => `Forbidden packed asset: ${entry}`),
  ];
}
