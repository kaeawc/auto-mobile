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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { findGraphMismatches } from "../release/lib/runtime-pins";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const MANIFEST = path.join(REPO_ROOT, "scripts/release/runtime-graph.json");

interface Manifest {
  dependencies: Record<string, string>;
  bundledRuntimeDependencies: Record<string, string[]>;
}

function resolveInstalledVersion(
  nodeModulesDirs: string[],
  name: string,
): string | undefined {
  for (const nodeModulesDir of nodeModulesDirs) {
    const pkgJson = path.join(nodeModulesDir, name, "package.json");
    if (!existsSync(pkgJson)) {
      continue;
    }
    try {
      return (JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: string })
        .version;
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface BundledGraphMismatch {
  name: string;
  expected: string[];
  resolved: string[];
}

export function findBundledGraphMismatches(
  expected: Record<string, string[]>,
  resolved: Record<string, Set<string>>,
): BundledGraphMismatch[] {
  return Object.entries(expected)
    .flatMap(([name, expectedVersions]) => {
      const actual = [...(resolved[name] ?? new Set<string>())].sort();
      const wanted = [...expectedVersions].sort();
      return JSON.stringify(actual) === JSON.stringify(wanted)
        ? []
        : [{ name, expected: wanted, resolved: actual }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function collectInstalledVersions(
  packageRoot: string,
): Record<string, Set<string>> {
  const versions: Record<string, Set<string>> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile() && entry.name === "package.json") {
        try {
          const pkg = JSON.parse(readFileSync(fullPath, "utf8")) as {
            name?: string;
            version?: string;
          };
          if (pkg.name && pkg.version) {
            (versions[pkg.name] ??= new Set()).add(pkg.version);
          }
        } catch {
          // A malformed unrelated package cannot establish a version match.
        }
      }
    }
  };
  if (existsSync(packageRoot)) {
    visit(packageRoot);
  }
  return versions;
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
    resolved[name] = resolveInstalledVersion(
      [packageNodeModules, consumerNodeModules],
      name,
    );
  }

  const mismatches = findGraphMismatches(manifest.dependencies, resolved);
  if (mismatches.length > 0) {
    console.error(
      "Clean-room install did NOT reproduce the pinned runtime graph (#5421):",
    );
    for (const m of mismatches) {
      console.error(
        `  - ${m.name}: expected ${m.expected}, resolved ${m.resolved ?? "(absent)"}`,
      );
    }
    process.exit(1);
  }

  const bundledMismatches = findBundledGraphMismatches(
    manifest.bundledRuntimeDependencies,
    collectInstalledVersions(packageNodeModules),
  );
  if (bundledMismatches.length > 0) {
    console.error(
      "Clean-room install did NOT reproduce the bundled runtime graph (#5421):",
    );
    for (const mismatch of bundledMismatches) {
      console.error(
        `  - ${mismatch.name}: expected [${mismatch.expected.join(", ")}], resolved [${mismatch.resolved.join(", ") || "(absent)"}]`,
      );
    }
    process.exit(1);
  }

  console.log(
    `Clean-room install reproduced all ${Object.keys(manifest.dependencies).length} pinned runtime dependencies.`,
  );
  if (Object.keys(manifest.bundledRuntimeDependencies).length > 0) {
    console.log(
      `Clean-room install reproduced ${Object.keys(manifest.bundledRuntimeDependencies).length} bundled runtime package names.`,
    );
  }
}

if (import.meta.main) {
  assertInstalledRuntimeGraph(process.argv[2] ?? "", process.argv[3] ?? "");
}
