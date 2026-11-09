import { findMissingBundleModules, type PackedModuleReader } from "./bundle-module-graph";

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

/**
 * Bundle entrypoints whose module graph must be fully packed. With `splitting`
 * they import hashed `dist/src/chunk-*.js` files that no static list can name.
 */
export const PACKED_BUNDLE_ENTRYPOINTS: readonly string[] = REQUIRED_PACKED_RUNTIME_ASSETS.filter(
  (entry) => entry.startsWith("dist/src/") && entry.endsWith(".js"),
);

export const FORBIDDEN_PACKED_ASSETS: readonly string[] = [
  "schemas/tool-definitions.json",
  "dist/schemas/tool-definitions.json",
];

/** Migrations ship only inside the bundle (static imports); a raw folder would double-pack them (#12457). */
export const FORBIDDEN_PACKED_PREFIXES: readonly string[] = ["dist/src/db/"];

/**
 * Nothing at runtime loads the bundle's external source maps (the bundle carries no
 * sourceMappingURL and Bun's stack traces are identical without them), and they were
 * ~9 MB of the tarball. They stay build artifacts only; package.json "files" excludes them.
 */
export function isForbiddenPackedSourceMap(entry: string): boolean {
  return entry.startsWith("dist/") && entry.endsWith(".map");
}

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

export function findPackedAssetViolations(
  packedPaths: readonly string[],
  readModule: PackedModuleReader,
): string[] {
  const missing = findMissingPackedAssets(packedPaths, REQUIRED_PACKED_RUNTIME_ASSETS);
  const missingModules = findMissingBundleModules(
    packedPaths,
    PACKED_BUNDLE_ENTRYPOINTS,
    readModule,
  );
  const forbidden = FORBIDDEN_PACKED_ASSETS.filter((entry) => packedPaths.includes(entry));
  const forbiddenPrefixed = packedPaths.filter((entry) =>
    FORBIDDEN_PACKED_PREFIXES.some((prefix) => entry.startsWith(prefix)),
  );
  const sourceMaps = packedPaths.filter(isForbiddenPackedSourceMap);
  return [
    ...sourceMaps.map((entry) => `Forbidden packed source map: ${entry}`),
    ...forbiddenPrefixed.map((entry) => `Forbidden packed asset: ${entry}`),
    ...missing.map((entry) => `Missing runtime asset: ${entry}`),
    ...missingModules,
    ...forbidden.map((entry) => `Forbidden packed asset: ${entry}`),
  ];
}
