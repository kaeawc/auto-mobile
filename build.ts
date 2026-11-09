#!/usr/bin/env bun

/**
 * Build script using Bun's built-in TypeScript transpiler
 * Replaces the previous tsc-based build process
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  optimizeSourceMap,
  selectSourceMaps,
  shouldStripSources,
  type SourceMap,
} from "./scripts/build/optimize-sourcemap";
import {
  builtEntryPath,
  EARLY_EVALUATED_ENTRYPOINTS,
  findEntryEvaluationOrderViolations,
} from "./scripts/build/entry-evaluation-order";
import { stripToolOutputSchemas } from "./scripts/build/strip-tool-output-schemas";

// Clean dist directory
const distPath = join(import.meta.dir, "dist");
if (existsSync(distPath)) {
  console.log("Cleaning dist directory...");
  rmSync(distPath, { recursive: true, force: true });
}

// Build with Bun - transpile TypeScript to JavaScript
console.log("Building with Bun...");
const result = await Bun.build({
  // The CtrlProxy bundle-extraction worker (issue #6574) is a second, real
  // entrypoint — not auto-discovered from `new Worker(new URL(...))` in
  // src/index.ts's graph, so `adm-zip` (a devDependency, absent from a
  // packaged install's node_modules) must be inlined by listing the worker
  // here explicitly, the same way src/index.ts inlines its dependencies.
  // EARLY_EVALUATED_ENTRYPOINTS are entrypoints only so that splitting gives each
  // its own dependency-free chunk that dist/src/index.js imports first.
  entrypoints: [
    "./src/index.ts",
    "./src/utils/workers/iosBundleExtractWorker.ts",
    ...EARLY_EVALUATED_ENTRYPOINTS,
  ],
  outdir: "./dist/src",
  target: "bun",
  format: "esm",
  // Keep native/asset-backed image dependencies external so sharp's @img
  // packages and jimp resolve their runtime assets from node_modules.
  external: ["sharp", "@img/sharp-*", "jimp", "@jimp/*"],
  sourcemap: "external",
  minify: true,
  // Split the bundle so startup parses only the chunks it loads; code behind a
  // dynamic import() (daemon, tools, platform managers) stays unparsed until used.
  // Chunks are hashed dist/src/chunk-*.js siblings of index.js, so every
  // import.meta.url-relative lookup still resolves from dist/src.
  splitting: true,
  // Fold tiny side-effect-free chunks to keep the file count down.
  minChunkSize: 16384,
  plugins: [
    {
      name: "static-tool-definitions",
      setup(build) {
        const definitionsPath = join(import.meta.dir, "schemas", "tool-definitions.json");
        build.onLoad({ filter: /[/\\]schemas[/\\]tool-definitions\.json$/ }, (args) => {
          if (args.path !== definitionsPath) {
            return;
          }
          const definitions = JSON.parse(readFileSync(args.path, "utf8")) as Record<
            string,
            unknown
          >[];
          return { contents: JSON.stringify(stripToolOutputSchemas(definitions)), loader: "json" };
        });
      },
    },
  ],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`✓ Built ${result.outputs.length} files`);

const bundleDir = join(distPath, "src");
const orderViolations = findEntryEvaluationOrderViolations(
  "index.js",
  EARLY_EVALUATED_ENTRYPOINTS.map(builtEntryPath),
  (relativePath) => readFileSync(join(bundleDir, relativePath), "utf8"),
);
if (orderViolations.length > 0) {
  console.error("Build failed: entry evaluation order is not guaranteed:");
  for (const violation of orderViolations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

const sourcemapOptions = {
  includeDependencySources: process.env.AUTOMOBILE_SOURCEMAP_INCLUDE_DEPS === "true",
  stripSources: shouldStripSources(process.env),
};
for (const { path: sourcemapPath, options } of selectSourceMaps(
  result.outputs.map((output) => output.path),
  join(distPath, "src", "index.js.map"),
  sourcemapOptions,
)) {
  try {
    const rawMap = readFileSync(sourcemapPath, "utf8");
    const { map, trimmedCount } = optimizeSourceMap(JSON.parse(rawMap) as SourceMap, options);
    writeFileSync(sourcemapPath, JSON.stringify(map));
    console.log(
      `✓ Minified sourcemap ${sourcemapPath} (trimmed ${trimmedCount} ${options.stripSources ? "embedded" : "dependency"} sources${options.stripSources ? "; nulled sourcesContent" : ""})`,
    );
  } catch (error) {
    console.warn("Failed to optimize sourcemap:", error);
  }
}

// Copy bundled native tools for runtime lookup from the published dist package.
const vendorSource = join(import.meta.dir, "vendor");
const vendorDest = join(import.meta.dir, "dist", "vendor");
if (existsSync(vendorSource)) {
  mkdirSync(vendorDest, { recursive: true });
  cpSync(vendorSource, vendorDest, { recursive: true });
  console.log("✓ Copied bundled vendor tools");
}

// The iOS screen-capture helper is NOT shipped in the npm payload. A supported
// macOS install downloads a prebuilt, sha256-verified universal binary from the
// GitHub release at runtime (ScreenCaptureHelperProvider, issue #4392); a repo
// checkout builds it from ios/screen-capture. Copying the Swift package source
// into dist/ would bloat the tarball with source that installs never build.

// Copy schemas for runtime validation (PlanSchemaValidator reads from disk)
const schemasSource = join(import.meta.dir, "schemas");
const schemasDest = join(import.meta.dir, "dist", "schemas");
if (existsSync(schemasSource)) {
  mkdirSync(schemasDest, { recursive: true });
  cpSync(schemasSource, schemasDest, {
    recursive: true,
    filter: (source) => source !== join(schemasSource, "tool-definitions.json"),
  });
  console.log("✓ Copied validation schemas");
} else {
  console.warn(`Validation schemas not found at ${schemasSource}`);
}

console.log("Build completed successfully!");
