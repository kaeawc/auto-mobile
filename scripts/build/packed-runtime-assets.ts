import { findMissingBundleModules, type PackedModuleReader } from "./bundle-module-graph";
import { PRUNE_CLASSES } from "../release/trim-bundled-deps";

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

/**
 * Byte budget for the bundled node_modules after the prepack prune (#17686). The pruned
 * closure is ~2.28 MB; an unpruned one (~8.2 MB) or a regression that stops pruning
 * docs/tests/browser builds (~2.7 MB) fails it. Raise it only for new runtime code.
 */
export const BUNDLED_NODE_MODULES_MAX_BYTES = 2_500_000;

/** Declarations and maps are never runtime-loaded, so the prune always removes them. */
const INERT_PRUNE_CLASSES = PRUNE_CLASSES.filter((pruneClass) => pruneClass.runtimeInert);

export function findBundledDependencyViolations(
  files: readonly { path: string; size: number }[],
  maxBytes = BUNDLED_NODE_MODULES_MAX_BYTES,
): string[] {
  const bundled = files.filter((file) => file.path.startsWith("node_modules/"));
  const bytes = bundled.reduce((sum, file) => sum + file.size, 0);
  const inert = bundled.flatMap((file) => {
    const basename = file.path.split("/").at(-1)!;
    const pruneClass = INERT_PRUNE_CLASSES.find((candidate) =>
      candidate.matches({
        packageName: "",
        relative: basename,
        directories: [],
        basename,
        hasDist: false,
        browserTargets: new Set(),
      }),
    );
    return pruneClass ? [`Unpruned bundled ${pruneClass.id} file: ${file.path}`] : [];
  });
  return [
    ...inert,
    ...(bytes > maxBytes
      ? [
          `Bundled node_modules ${bytes} bytes exceeds ${maxBytes} bytes; run the pack with AUTOMOBILE_TRIM_BUNDLED_DEPS=true and check scripts/release/trim-bundled-deps.ts list`,
        ]
      : []),
  ];
}
