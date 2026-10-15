/** Trailing slashes require a non-empty directory in npm's POSIX file manifest. */
export const REQUIRED_PACKED_RUNTIME_ASSETS: readonly string[] = [
  "dist/src/index.js",
  "dist/src/utils/workers/iosBundleExtractWorker.js",
  "dist/schemas/test-plan.schema.json",
  "schemas/test-plan.schema.json",
  // WebpBinaryResolver resolves both tools from the published dist project root.
  "dist/vendor/libwebp/win32-x64/cwebp.exe",
  "dist/vendor/libwebp/win32-x64/dwebp.exe",
];

export const FORBIDDEN_PACKED_ASSETS: readonly string[] = [
  "schemas/tool-definitions.json",
  "dist/schemas/tool-definitions.json",
];

/** Migrations ship only inside the bundle (static imports); a raw folder would double-pack them (#12457). */
export const FORBIDDEN_PACKED_PREFIXES: readonly string[] = ["dist/src/db/"];

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
  const forbiddenPrefixed = packedPaths.filter((entry) =>
    FORBIDDEN_PACKED_PREFIXES.some((prefix) => entry.startsWith(prefix)),
  );
  return [
    ...forbiddenPrefixed.map((entry) => `Forbidden packed asset: ${entry}`),
    ...missing.map((entry) => `Missing runtime asset: ${entry}`),
    ...forbidden.map((entry) => `Forbidden packed asset: ${entry}`),
  ];
}
