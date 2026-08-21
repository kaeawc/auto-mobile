#!/usr/bin/env bun
/**
 * Generate / verify the pinned runtime dependency graph (issue #5421).
 *
 *   bun scripts/release/pin-runtime-deps.ts --write   # apply pins + manifest
 *   bun scripts/release/pin-runtime-deps.ts --check    # CI drift-guard (no writes)
 *
 * `--write` rewrites `package.json` so the published `dependencies` are the
 * exact, right-sized runtime graph (runtime roots + pure-transitive closure),
 * moves build-only/inlined dependencies to `devDependencies`, and refreshes the
 * committed manifest `scripts/release/runtime-graph.json`.
 *
 * `--check` recomputes the intended graph from `bun.lock` + the manifest roots
 * and fails if `package.json` or the manifest have drifted from it — the refresh
 * point the release/update procedure gates on. It is hermetic (no build, no
 * network) so CI can run it cheaply; the clean-room install that resolves the
 * packed artifact lives in `scripts/ci/verify-pinned-runtime-graph.sh`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  computePins,
  isExactVersion,
  parseBunLock,
  repartitionDependencies,
} from "./lib/runtime-pins";
import { deriveRootsFromDist } from "./lib/runtime-roots";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const PACKAGE_JSON = path.join(REPO_ROOT, "package.json");
const BUN_LOCK = path.join(REPO_ROOT, "bun.lock");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const DIST_ENTRY = path.join(DIST_DIR, "src/index.js");
const MANIFEST = path.join(REPO_ROOT, "scripts/release/runtime-graph.json");

interface Manifest {
  description: string;
  issue: number;
  roots: string[];
  dependencies: Record<string, string>;
  residualUnpinned: string[];
  multiVersion: Record<string, string[]>;
}

function loadPackageJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as Record<
    string,
    unknown
  >;
}

/** Type declarations and platform-native sharp packages stay out of runtime deps. */
const EXCLUDE_PREFIXES = ["@types/", "@img/sharp-"];

interface Intended {
  roots: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  residualUnpinned: string[];
  multiVersion: Record<string, string[]>;
}

function computeIntended(roots: string[]): Intended {
  const pkg = loadPackageJson();
  const lock = parseBunLock(readFileSync(BUN_LOCK, "utf8"));
  const pins = computePins(lock, roots, { excludePrefixes: EXCLUDE_PREFIXES });
  // Fail closed: non-empty roots that resolve to an empty closure means the lock
  // could not be walked (e.g. a future bun.lock format change parseBunLock does
  // not understand). Without this, --write would move every dependency to
  // devDependencies and every gate would pass vacuously against an empty graph.
  if (roots.length > 0 && Object.keys(pins.dependencies).length === 0) {
    throw new Error(
      `Runtime roots [${roots.join(", ")}] resolved to an empty closure from bun.lock — ` +
        "refusing to compute an empty runtime graph (is bun.lock parseable / current?).",
    );
  }
  const repartition = repartitionDependencies({
    currentDependencies: (pkg.dependencies as Record<string, string>) ?? {},
    currentDevDependencies:
      (pkg.devDependencies as Record<string, string>) ?? {},
    roots,
    closurePins: pins.dependencies,
    previousRuntimeDependencies: loadManifest()?.dependencies,
  });
  return {
    roots,
    dependencies: repartition.dependencies,
    devDependencies: repartition.devDependencies,
    residualUnpinned: repartition.residualUnpinned,
    multiVersion: pins.multiVersion,
  };
}

function loadManifest(): Manifest | undefined {
  if (!existsSync(MANIFEST)) {
    return undefined;
  }
  return JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
}

function assertAllExact(dependencies: Record<string, string>): void {
  const ranged = Object.entries(dependencies).filter(
    ([, spec]) => !isExactVersion(spec),
  );
  if (ranged.length > 0) {
    throw new Error(
      `Runtime dependencies must be exact-pinned, found ranges: ${ranged
        .map(([n, s]) => `${n}@${s}`)
        .join(", ")}`,
    );
  }
}

function readRootsForCheck(): string[] {
  // Prefer the committed manifest so --check is hermetic and stable when dist/
  // is absent; when it is built, checkMode also compares its roots below.
  const manifest = loadManifest();
  if (manifest) {
    return manifest.roots;
  }
  if (existsSync(DIST_ENTRY)) {
    return deriveRootsFromDist(DIST_DIR);
  }
  throw new Error(
    "Cannot determine runtime roots: generate the manifest (--write) or build dist/ first.",
  );
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeMode(): void {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(
      "dist/src/index.js not found — run `bun run build` before --write.",
    );
  }
  const roots = deriveRootsFromDist(DIST_DIR);
  if (roots.length === 0) {
    throw new Error(
      "No runtime roots derived from dist — refusing to empty the dependency graph.",
    );
  }
  const intended = computeIntended(roots);
  assertAllExact(intended.dependencies);

  const pkg = loadPackageJson();
  pkg.dependencies = intended.dependencies;
  pkg.devDependencies = intended.devDependencies;
  writeFileSync(PACKAGE_JSON, stableJson(pkg));

  const manifest: Manifest = {
    description:
      "Pinned runtime dependency graph for @kaeawc/auto-mobile. Regenerate with `bun scripts/release/pin-runtime-deps.ts --write` after a dependency or security update; see docs/design-docs/release/runtime-dependency-pinning.md.",
    issue: 5421,
    roots: intended.roots,
    dependencies: intended.dependencies,
    residualUnpinned: intended.residualUnpinned,
    multiVersion: intended.multiVersion,
  };
  writeFileSync(MANIFEST, stableJson(manifest));

  console.log(
    `Pinned ${Object.keys(intended.dependencies).length} runtime dependencies; ` +
      `moved ${Object.keys(intended.devDependencies).length} to devDependencies; ` +
      `${intended.residualUnpinned.length} residual (transitive, gate-verified).`,
  );
  console.log(
    "Run `bun install` to refresh bun.lock, then commit package.json, bun.lock, and the manifest.",
  );
}

function checkMode(): void {
  const errors: string[] = [];
  const roots = readRootsForCheck();
  const intended = computeIntended(roots);
  assertAllExact(intended.dependencies);

  const pkg = loadPackageJson();
  const currentDeps = (pkg.dependencies as Record<string, string>) ?? {};
  const currentDevDeps = (pkg.devDependencies as Record<string, string>) ?? {};

  if (JSON.stringify(currentDeps) !== JSON.stringify(intended.dependencies)) {
    errors.push(
      "package.json `dependencies` differ from the intended pinned runtime graph.",
    );
  }
  // devDependencies must be a superset (the intended dev set); order-insensitive.
  for (const [name, spec] of Object.entries(intended.devDependencies)) {
    if (currentDevDeps[name] !== spec) {
      errors.push(
        `devDependencies drift: ${name} expected ${spec}, found ${currentDevDeps[name] ?? "(absent)"}.`,
      );
    }
  }

  if (!existsSync(MANIFEST)) {
    errors.push(`Missing manifest ${path.relative(REPO_ROOT, MANIFEST)}.`);
  } else {
    const manifest = loadManifest();
    if (!manifest) {
      throw new Error(`Could not load manifest ${MANIFEST}.`);
    }
    if (
      JSON.stringify(manifest.dependencies) !==
      JSON.stringify(intended.dependencies)
    ) {
      errors.push(
        "Manifest `dependencies` are out of sync with the intended pinned graph.",
      );
    }
    // Detect roots drift against what the built artifact actually imports. --check
    // computes pins from `manifest.roots` (hermetic), so this is the only place a
    // *new* runtime import — a new migration `import`, or a build.ts externals
    // change — is caught: if it is not, a genuinely-new runtime dependency would
    // ship unpinned with the gate still green. Only possible when dist/ is built
    // (the clean-room gate builds it first); skipped in the hermetic Fast
    // Validation run where dist/ is absent.
    if (existsSync(DIST_ENTRY)) {
      const distRoots = deriveRootsFromDist(DIST_DIR);
      if (
        JSON.stringify([...distRoots].sort()) !==
        JSON.stringify([...manifest.roots].sort())
      ) {
        errors.push(
          `Manifest \`roots\` [${[...manifest.roots].sort().join(", ")}] differ from the roots ` +
            `the built artifact imports [${distRoots.join(", ")}] — run --write to refresh.`,
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error("Runtime dependency-graph pinning is out of date (#5421):");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    console.error(
      "Refresh with: bun scripts/release/pin-runtime-deps.ts --write && bun install",
    );
    process.exit(1);
  }
  console.log(
    `Pinned runtime graph is in sync (${Object.keys(intended.dependencies).length} exact deps).`,
  );
}

function main(): void {
  const mode = process.argv[2];
  if (mode === "--write") {
    writeMode();
  } else if (mode === "--check") {
    checkMode();
  } else {
    console.error("Usage: pin-runtime-deps.ts --write | --check");
    process.exit(2);
  }
}

main();
