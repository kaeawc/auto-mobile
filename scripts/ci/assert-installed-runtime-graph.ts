#!/usr/bin/env bun
/**
 * Assert that a clean install of the packed artifact resolved the intended
 * pinned runtime graph (issue #5421, acceptance criterion 3).
 *
 *   bun scripts/ci/assert-installed-runtime-graph.ts <consumer-node-modules-dir>
 *
 * The consumer dir is a throwaway project that installed the packed
 * `@kaeawc/auto-mobile` tarball with an empty cache. Every exact pin in the
 * committed manifest must resolve to that exact version — the pins cannot drift,
 * so this is a stable gate. Residual (transitively-resolved) names are reported
 * for visibility but are not failed on, because package.json cannot pin them
 * (documented in docs/design-docs/release/runtime-dependency-pinning.md).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findGraphMismatches } from "../release/lib/runtime-pins";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const MANIFEST = path.join(REPO_ROOT, "scripts/release/runtime-graph.json");

interface Manifest {
  roots: string[];
  dependencies: Record<string, string>;
  residualUnpinned: string[];
}

function resolveInstalledVersion(nodeModulesDir: string, name: string): string | undefined {
  const pkgJson = path.join(nodeModulesDir, name, "package.json");
  if (!existsSync(pkgJson)) {
    return undefined;
  }
  try {
    return (JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

function main(): void {
  const consumerNodeModules = process.argv[2];
  if (!consumerNodeModules) {
    console.error("Usage: assert-installed-runtime-graph.ts <consumer-node-modules-dir>");
    process.exit(2);
  }
  if (!existsSync(MANIFEST)) {
    console.error(
      `Missing manifest ${MANIFEST}. Run: bun scripts/release/pin-runtime-deps.ts --write`,
    );
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;

  const resolved: Record<string, string | undefined> = {};
  for (const name of Object.keys(manifest.dependencies)) {
    resolved[name] = resolveInstalledVersion(consumerNodeModules, name);
  }

  const mismatches = findGraphMismatches(manifest.dependencies, resolved);
  if (mismatches.length > 0) {
    console.error("Clean-room install did NOT reproduce the pinned runtime graph (#5421):");
    for (const m of mismatches) {
      console.error(`  - ${m.name}: expected ${m.expected}, resolved ${m.resolved ?? "(absent)"}`);
    }
    process.exit(1);
  }

  console.log(
    `Clean-room install reproduced all ${Object.keys(manifest.dependencies).length} pinned runtime dependencies.`,
  );
  if (manifest.residualUnpinned.length > 0) {
    const residualVersions = manifest.residualUnpinned
      .map((name) => `${name}@${resolveInstalledVersion(consumerNodeModules, name) ?? "(absent)"}`)
      .join(", ");
    console.log(`Residual (transitively-resolved, not pinnable) packages: ${residualVersions}`);
  }
}

main();
