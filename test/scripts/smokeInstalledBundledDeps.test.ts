import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  collectBundledPackages,
  type BundledPackage,
} from "../../scripts/release/trim-bundled-deps";
import {
  formatFailures,
  importSkipReason,
  smokeInstalledBundledDeps,
} from "../../scripts/ci/smoke-installed-bundled-deps";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skip rule distinguishes declarations, commands, and importable entries", () => {
  expect(importSkipReason({ name: "types" }, ["index.d.ts"])).toBe(
    "no runtime entry (types-only package)",
  );
  expect(importSkipReason({ name: "cli", bin: "cli.js" }, ["cli.js"])).toBe(
    "bin-only package (no importable entry)",
  );
  for (const entry of [
    { main: "missing.js" },
    { module: "esm.js" },
    { exports: { bun: "./src.ts" } },
    { exports: {} },
  ]) {
    expect(importSkipReason({ name: "pkg", ...entry }, [])).toBeUndefined();
  }
  for (const ext of ["js", "mjs", "cjs", "ts", "mts", "cts", "json", "node"]) {
    expect(importSkipReason({ name: "pkg", bin: "cli.js" }, [`index.${ext}`])).toBeUndefined();
  }
});

test("shared closure traversal imports every nested version from its own directory", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bundle-smoke-"));
  roots.push(root);
  const put = (directory: string, metadata: object) => {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, directory, "package.json"), JSON.stringify(metadata));
  };
  put("", { bundledDependencies: ["a", "dep"] });
  put("node_modules/a", {
    name: "a",
    version: "1",
    main: "index.js",
    dependencies: { dep: "2", types: "1" },
  });
  put("node_modules/dep", { name: "dep", version: "1", main: "index.js" });
  put("node_modules/a/node_modules/dep", { name: "dep", version: "2", exports: "./index.js" });
  put("node_modules/types", { name: "types", version: "1" });
  const calls: BundledPackage[] = [];
  const result = await smokeInstalledBundledDeps(root, {
    collect: collectBundledPackages,
    filenames: () => [],
    importer: async (pkg) => {
      calls.push(pkg);
    },
  });
  expect(calls.map((pkg) => path.relative(root, pkg.directory))).toEqual([
    "node_modules/a",
    "node_modules/a/node_modules/dep",
    "node_modules/dep",
  ]);
  expect(result.imported).toEqual(calls);
  expect(result.skipped.map(({ pkg, reason }) => [pkg.metadata.name, reason])).toEqual([
    ["types", "no runtime entry (types-only package)"],
  ]);
  expect(result.failures).toEqual([]);
});

test("all import failures are collected with name, version, directory, and error", async () => {
  const packages: BundledPackage[] = ["1", "2"].map((version) => ({
    directory: `/installed/${version}/node_modules/pkg`,
    metadata: { name: "pkg", version, main: "index.js" },
  }));
  const result = await smokeInstalledBundledDeps("/installed", {
    collect: () => packages,
    filenames: () => [],
    importer: async (pkg) => {
      if (pkg.metadata.version === "1") {
        throw new Error("missing entry");
      }
      throw "broken export";
    },
  });
  expect(result.failures).toHaveLength(2);
  expect(formatFailures(result.failures)).toBe(
    "- pkg@1 (/installed/1/node_modules/pkg): missing entry\n- pkg@2 (/installed/2/node_modules/pkg): broken export",
  );
  expect(result.imported).toEqual([]);
});
