import { expect, test } from "bun:test";
import {
  BUNDLED_NODE_MODULES_MAX_BYTES,
  findBundledDependencyViolations,
  findMissingPackedAssets,
  findPackedAssetViolations,
  REQUIRED_PACKED_RUNTIME_ASSETS,
  FORBIDDEN_PACKED_ASSETS,
} from "../../scripts/build/packed-runtime-assets";

const completeManifest = REQUIRED_PACKED_RUNTIME_ASSETS.map((entry) =>
  entry.endsWith("/") ? `${entry}2025_12_28_000_initial_schema.ts` : entry,
);

test("runtime manifest includes entrypoints, disk schemas and vendor tools", () => {
  expect(findPackedAssetViolations(completeManifest)).toEqual([]);
  for (const entry of completeManifest) {
    expect(
      findMissingPackedAssets(
        completeManifest.filter((path) => path !== entry),
        REQUIRED_PACKED_RUNTIME_ASSETS,
      ),
    ).toHaveLength(1);
  }
});

test("runtime manifest does not require raw DB files", () => {
  expect(REQUIRED_PACKED_RUNTIME_ASSETS.some((entry) => entry.startsWith("dist/src/db/"))).toBe(
    false,
  );
});

test("directory prefixes require a file and do not match similarly named directories", () => {
  expect(
    findMissingPackedAssets(["assets/runtime/", "assets/runtime-old/a.ts"], ["assets/runtime/"]),
  ).toEqual(["assets/runtime/"]);
  expect(findMissingPackedAssets([], [])).toEqual([]);
});

test("reports missing and forbidden assets together with the offending paths", () => {
  const paths = [
    ...completeManifest.filter((entry) => entry !== "dist/src/index.js"),
    ...FORBIDDEN_PACKED_ASSETS,
  ];
  expect(findPackedAssetViolations(paths)).toEqual([
    "Missing runtime asset: dist/src/index.js",
    "Forbidden packed asset: schemas/tool-definitions.json",
    "Forbidden packed asset: dist/schemas/tool-definitions.json",
  ]);
});

test("rejects a raw migrations folder packed beside the static bundle", () => {
  expect(
    findPackedAssetViolations([...completeManifest, "dist/src/db/migrations/2026_01_01_000.ts"]),
  ).toEqual(["Forbidden packed asset: dist/src/db/migrations/2026_01_01_000.ts"]);
});

test("packed dist source maps are forbidden but dependency maps are not inspected", () => {
  expect(findPackedAssetViolations([...completeManifest, "dist/src/index.js.map"])).toEqual([
    "Forbidden packed source map: dist/src/index.js.map",
  ]);
  expect(findPackedAssetViolations([...completeManifest, "node_modules/x/y.js.map"])).toEqual([]);
});

test("bundled node_modules budget counts only node_modules bytes", () => {
  const files = [
    { path: "dist/src/index.js", size: 50 },
    { path: "node_modules/a/index.js", size: 6 },
    { path: "node_modules/a/LICENSE", size: 4 },
  ];
  expect(findBundledDependencyViolations(files, 10)).toEqual([]);
  expect(findBundledDependencyViolations(files, 9)).toEqual([
    expect.stringContaining("Bundled node_modules 10 bytes exceeds 9 bytes"),
  ]);
  expect(BUNDLED_NODE_MODULES_MAX_BYTES).toBeLessThan(2_690_708);
});

test("bundled declarations and maps fail the gate; dist and docs are not inspected", () => {
  expect(
    findBundledDependencyViolations([
      { path: "node_modules/a/index.d.ts", size: 1 },
      { path: "node_modules/a/index.js.map", size: 1 },
      { path: "node_modules/a/README.md", size: 1 },
      { path: "dist/src/types.d.ts", size: 1 },
    ]),
  ).toEqual([
    "Unpruned bundled type-declarations file: node_modules/a/index.d.ts",
    "Unpruned bundled source-maps file: node_modules/a/index.js.map",
  ]);
});
