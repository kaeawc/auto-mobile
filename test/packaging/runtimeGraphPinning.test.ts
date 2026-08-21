import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findBundledGraphMismatches } from "../../scripts/ci/assert-installed-runtime-graph";
import { isExactVersion } from "../../scripts/release/lib/runtime-pins";

/**
 * Runtime dependency-graph pinning contract (issue #5421).
 *
 * A clean `bun install -g @kaeawc/auto-mobile@<version>` must resolve the same
 * runtime graph after later compatible releases appear in the registry. The
 * published `dependencies` are therefore the exact, right-sized runtime graph:
 *  - every runtime dependency is an exact version (no caret/tilde/range), so the
 *    package manager cannot re-resolve it (AC1/AC2);
 *  - dependencies that the build inlines into `dist/` (and only needs to
 *    build/test the repo) live in `devDependencies`, so consumers never install
 *    them — this is what made the staged `@peculiar/asn1-*` publish an outage;
 *  - a committed manifest mirrors the pinned graph and is regenerable, giving the
 *    release/update procedure a package-manager-compatible refresh point (AC4).
 *
 * The clean-room install that resolves the packed artifact and asserts the graph
 * (AC3) lives in `scripts/ci/verify-pinned-runtime-graph.sh`.
 */
describe("runtime dependency graph is pinned (#5421)", () => {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const pkg = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    optionalDependencies: Record<string, string>;
    bundledDependencies?: string[];
  };
  const manifestPath = path.join(
    repoRoot,
    "scripts/release/runtime-graph.json",
  );

  // Packages the build inlines into dist/src/index.js (build.ts externalizes only
  // the jimp/sharp families). Consumers must not install these, so they must not
  // appear in `dependencies`. `werift` is the one that pulled in `@peculiar/asn1-*`.
  const INLINED_NOT_RUNTIME = [
    "werift",
    "@anthropic-ai/sdk",
    "@modelcontextprotocol/sdk",
    "js-tiktoken",
    "ws",
  ];

  // The packages the built artifact actually imports from node_modules at runtime:
  // the jimp/sharp image backends (dynamic imports in the bundle) plus kysely,
  // which every DB migration `.ts` copied into dist/ imports for its `sql` tag and
  // which the migrator loads from disk at runtime (not bundled into index.js).
  const RUNTIME_ROOTS = ["jimp", "@jimp/core", "sharp", "kysely"];

  test("every runtime dependency is pinned to an exact version", () => {
    const ranged = Object.entries(pkg.dependencies).filter(
      ([, spec]) => !isExactVersion(spec),
    );
    expect(ranged).toEqual([]);
  });

  test("the runtime roots the artifact imports are present in dependencies", () => {
    for (const root of RUNTIME_ROOTS) {
      expect(pkg.dependencies[root]).toBeDefined();
    }
  });

  test("build-inlined packages are not shipped to consumers as runtime deps", () => {
    const leaked = INLINED_NOT_RUNTIME.filter(
      (name) => name in pkg.dependencies,
    );
    expect(leaked).toEqual([]);
  });

  test("no package appears in both dependencies and devDependencies", () => {
    const both = Object.keys(pkg.dependencies).filter(
      (name) => name in (pkg.devDependencies ?? {}),
    );
    expect(both).toEqual([]);
  });

  test("platform-native @img/* optional deps stay exact-pinned", () => {
    const img = Object.entries(pkg.optionalDependencies ?? {}).filter(([n]) =>
      n.startsWith("@img/"),
    );
    expect(img.length).toBeGreaterThan(0);
    expect(img.filter(([, spec]) => !isExactVersion(spec))).toEqual([]);
  });

  test("a committed manifest mirrors the pinned dependency graph", () => {
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      roots: string[];
      dependencies: Record<string, string>;
      bundledRuntimeDependencies: Record<string, string[]>;
    };
    for (const root of RUNTIME_ROOTS) {
      expect(manifest.roots).toContain(root);
    }
    // The manifest's pinned graph is exactly package.json's dependencies.
    expect(manifest.dependencies).toEqual(pkg.dependencies);
    expect(manifest.bundledRuntimeDependencies).toEqual({
      pixelmatch: expect.any(Array),
      pngjs: expect.any(Array),
      xml2js: expect.any(Array),
      zod: expect.any(Array),
    });
  });

  test("runtime packages with conflicting build versions are bundled, not left to re-resolve", () => {
    expect(pkg.bundledDependencies).toEqual(
      expect.arrayContaining([
        "@jimp/diff",
        "@jimp/js-png",
        "@jimp/plugin-blit",
        "parse-bmfont-xml",
      ]),
    );
  });

  test("the clean-room verifier rejects an absent or drifted bundled package", () => {
    expect(
      findBundledGraphMismatches(
        { pngjs: ["6.0.0", "7.0.0"], zod: ["3.25.76"] },
        { pngjs: new Set(["7.0.0"]) },
      ),
    ).toEqual([
      {
        name: "pngjs",
        expected: ["6.0.0", "7.0.0"],
        resolved: ["7.0.0"],
      },
      {
        name: "zod",
        expected: ["3.25.76"],
        resolved: [],
      },
    ]);
  });
});
