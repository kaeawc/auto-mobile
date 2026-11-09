import { expect, test } from "bun:test";
import {
  findMissingPackedAssets,
  findPackedAssetViolations,
  REQUIRED_PACKED_RUNTIME_ASSETS,
  FORBIDDEN_PACKED_ASSETS,
} from "../../scripts/build/packed-runtime-assets";

/** Fixture modules carry no chunk imports, so the module-graph walk finds nothing missing. */
const noImports = (): string => "";

const completeManifest = REQUIRED_PACKED_RUNTIME_ASSETS.map((entry) =>
  entry.endsWith("/") ? `${entry}2025_12_28_000_initial_schema.ts` : entry,
);

test("runtime manifest includes entrypoints, disk schemas and vendor tools", () => {
  expect(findPackedAssetViolations(completeManifest, noImports)).toEqual([]);
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
  expect(findPackedAssetViolations(paths, noImports)).toEqual([
    "Missing runtime asset: dist/src/index.js",
    "Forbidden packed asset: schemas/tool-definitions.json",
    "Forbidden packed asset: dist/schemas/tool-definitions.json",
  ]);
});

test("rejects a raw migrations folder packed beside the static bundle", () => {
  expect(
    findPackedAssetViolations(
      [...completeManifest, "dist/src/db/migrations/2026_01_01_000.ts"],
      noImports,
    ),
  ).toEqual(["Forbidden packed asset: dist/src/db/migrations/2026_01_01_000.ts"]);
});

test("packed dist source maps are forbidden but dependency maps are not inspected", () => {
  expect(
    findPackedAssetViolations([...completeManifest, "dist/src/index.js.map"], noImports),
  ).toEqual(["Forbidden packed source map: dist/src/index.js.map"]);
  expect(
    findPackedAssetViolations([...completeManifest, "node_modules/x/y.js.map"], noImports),
  ).toEqual([]);
});

test("reports a chunk the packed entrypoint imports but the tarball dropped", () => {
  const modules: Record<string, string> = {
    "dist/src/index.js": 'import{a}from"./chunk-aaaa.js";',
    "dist/src/chunk-aaaa.js": 'export const a=1;import.meta.require("./chunk-bbbb.js");',
  };
  const read = (path: string): string => modules[path] ?? "";
  const packed = [...completeManifest, "dist/src/chunk-aaaa.js"];
  expect(findPackedAssetViolations(packed, read)).toEqual([
    "Missing bundle module: dist/src/chunk-bbbb.js (imported by dist/src/chunk-aaaa.js)",
  ]);
  expect(findPackedAssetViolations([...packed, "dist/src/chunk-bbbb.js"], read)).toEqual([]);
});
