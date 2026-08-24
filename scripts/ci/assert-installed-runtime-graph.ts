#!/usr/bin/env bun
/**
 * Assert that a clean install of the packed artifact resolved the intended
 * pinned runtime graph (issue #5421, acceptance criterion 3).
 *
 *   bun scripts/ci/assert-installed-runtime-graph.ts <package-root> <consumer-node-modules>
 *
 * The consumer dir is a throwaway project that installed the packed
 * `@kaeawc/auto-mobile` tarball with an empty cache. Every exact pin in the
 * committed manifest must resolve to that exact version. Conflicting Jimp
 * transitives are carried inside the packed artifact and checked recursively, so
 * they cannot re-resolve after publication.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findGraphMismatches } from "../release/lib/runtime-pins";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const MANIFEST = path.join(REPO_ROOT, "scripts/release/runtime-graph.json");

interface Manifest {
  dependencies: Record<string, string>;
  bundledRuntimeDependencies: Record<string, string[]>;
  bundledRuntimeDependencyOwners: Record<string, Record<string, string[]>>;
}

function resolveInstalledVersion(nodeModulesDirs: string[], name: string): string | undefined {
  for (const nodeModulesDir of nodeModulesDirs) {
    const pkgJson = path.join(nodeModulesDir, name, "package.json");
    if (!existsSync(pkgJson)) {
      continue;
    }
    try {
      return (JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: string }).version;
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface BundledOwnerMismatch {
  owner: string;
  dependency: string;
  expected: string[];
  resolved: string | undefined;
}

export function findBundledOwnerMismatches(
  expected: Record<string, Record<string, string[]>>,
  resolved: Record<string, Record<string, string | undefined>>,
): BundledOwnerMismatch[] {
  return Object.entries(expected)
    .flatMap(([owner, dependencies]) =>
      Object.entries(dependencies).flatMap(([dependency, expectedVersions]) => {
        const actual = resolved[owner]?.[dependency];
        const wanted = [...expectedVersions].sort();
        return actual && wanted.includes(actual)
          ? []
          : [{ owner, dependency, expected: wanted, resolved: actual }];
      }),
    )
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.dependency.localeCompare(b.dependency));
}

function collectBundledOwnerVersions(
  packageNodeModules: string,
  expected: Record<string, Record<string, string[]>>,
): Record<string, Record<string, string | undefined>> {
  return Object.fromEntries(
    Object.entries(expected).map(([owner, dependencies]) => [
      owner,
      Object.fromEntries(
        Object.keys(dependencies).map((dependency) => [
          dependency,
          resolveBundledOwnerVersion(
            packageNodeModules,
            path.join(packageNodeModules, owner),
            dependency,
          ),
        ]),
      ),
    ]),
  );
}

/**
 * Resolve a dependency as Node would from a bundled owner, but search only
 * locations within the packed AutoMobile package. npm can hoist a bundled
 * owner's dependency to the package's own node_modules; searching the consumer
 * node_modules here would recreate the registry-resolution false positive.
 */
function resolveBundledOwnerVersion(
  packageNodeModules: string,
  ownerDirectory: string,
  dependency: string,
): string | undefined {
  const nodeModulesDirs: string[] = [];
  let current = ownerDirectory;
  while (current === packageNodeModules || current.startsWith(`${packageNodeModules}${path.sep}`)) {
    nodeModulesDirs.push(path.join(current, "node_modules"));
    current = path.dirname(current);
  }
  nodeModulesDirs.push(packageNodeModules);
  return resolveInstalledVersion([...new Set(nodeModulesDirs)], dependency);
}

export function assertInstalledRuntimeGraph(
  packageRoot: string,
  consumerNodeModules: string,
): void {
  if (!packageRoot || !consumerNodeModules) {
    console.error(
      "Usage: assert-installed-runtime-graph.ts <package-root> <consumer-node-modules>",
    );
    process.exit(2);
  }
  if (!existsSync(MANIFEST)) {
    console.error(
      `Missing manifest ${MANIFEST}. Run: bun scripts/release/pin-runtime-deps.ts --write`,
    );
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
  const packageNodeModules = path.join(packageRoot, "node_modules");

  const resolved: Record<string, string | undefined> = {};
  for (const name of Object.keys(manifest.dependencies)) {
    resolved[name] = resolveInstalledVersion([packageNodeModules, consumerNodeModules], name);
  }

  const mismatches = findGraphMismatches(manifest.dependencies, resolved);
  if (mismatches.length > 0) {
    console.error("Clean-room install did NOT reproduce the pinned runtime graph (#5421):");
    for (const m of mismatches) {
      console.error(`  - ${m.name}: expected ${m.expected}, resolved ${m.resolved ?? "(absent)"}`);
    }
    process.exit(1);
  }

  const bundledMismatches = findBundledOwnerMismatches(
    manifest.bundledRuntimeDependencyOwners,
    collectBundledOwnerVersions(packageNodeModules, manifest.bundledRuntimeDependencyOwners),
  );
  if (bundledMismatches.length > 0) {
    console.error("Clean-room install did NOT reproduce the bundled runtime graph (#5421):");
    for (const mismatch of bundledMismatches) {
      console.error(
        `  - ${mismatch.owner} -> ${mismatch.dependency}: expected [${mismatch.expected.join(", ")}], resolved ${mismatch.resolved ?? "(absent)"}`,
      );
    }
    process.exit(1);
  }

  console.log(
    `Clean-room install reproduced all ${Object.keys(manifest.dependencies).length} pinned runtime dependencies.`,
  );
  if (Object.keys(manifest.bundledRuntimeDependencies).length > 0) {
    console.log(
      `Clean-room install reproduced ${Object.keys(manifest.bundledRuntimeDependencyOwners).length} bundled runtime dependency owners.`,
    );
  }
}

if (import.meta.main) {
  assertInstalledRuntimeGraph(process.argv[2] ?? "", process.argv[3] ?? "");
}
