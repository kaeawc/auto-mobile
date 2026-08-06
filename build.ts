#!/usr/bin/env bun

/**
 * Build script using Bun's built-in TypeScript transpiler
 * Replaces the previous tsc-based build process
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { copyDatabaseRuntimeFiles } from "./scripts/build/copy-db-runtime-files";

// Clean dist directory
const distPath = join(import.meta.dir, "dist");
if (existsSync(distPath)) {
  console.log("Cleaning dist directory...");
  rmSync(distPath, { recursive: true, force: true });
}

// Build with Bun - transpile TypeScript to JavaScript
console.log("Building with Bun...");
const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  outdir: "./dist/src",
  target: "bun",
  format: "esm",
  // Keep native/asset-backed image dependencies external so sharp's @img
  // packages and jimp resolve their runtime assets from node_modules.
  external: ["sharp", "@img/sharp-*", "jimp", "@jimp/*"],
  sourcemap: "external",
  minify: true,
  splitting: false,
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`✓ Built ${result.outputs.length} files`);

const sourcemapPath = join(import.meta.dir, "dist", "src", "index.js.map");
if (existsSync(sourcemapPath)) {
  try {
    const includeDependencySources = process.env.AUTOMOBILE_SOURCEMAP_INCLUDE_DEPS === "true";
    const rawMap = readFileSync(sourcemapPath, "utf8");
    const map = JSON.parse(rawMap);
    let trimmedCount = 0;

    if (!includeDependencySources && Array.isArray(map.sources) && Array.isArray(map.sourcesContent)) {
      map.sourcesContent = map.sourcesContent.map((content: string | null, index: number) => {
        const source = String(map.sources[index] ?? "");
        if (source.includes("node_modules") || source.includes("__bun")) {
          if (content) {
            trimmedCount += 1;
          }
          return null;
        }
        return content;
      });
    }

    writeFileSync(sourcemapPath, JSON.stringify(map));
    if (includeDependencySources) {
      console.log("✓ Minified sourcemap");
    } else {
      console.log(`✓ Minified sourcemap (trimmed ${trimmedCount} dependency sources)`);
    }
  } catch (error) {
    console.warn("Failed to optimize sourcemap:", error);
  }
}

// Copy raw DB runtime files for FileMigrationProvider usage.
copyDatabaseRuntimeFiles({ projectRoot: import.meta.dir });

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
  cpSync(schemasSource, schemasDest, { recursive: true });
  console.log("✓ Copied validation schemas");
} else {
  console.warn(`Validation schemas not found at ${schemasSource}`);
}

console.log("Build completed successfully!");
