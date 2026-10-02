import { expect, test } from "bun:test";
import {
  findMissingPackedAssets,
  findPackedAssetViolations,
  REQUIRED_PACKED_RUNTIME_ASSETS,
  FORBIDDEN_PACKED_ASSETS,
} from "../../scripts/build/packed-runtime-assets";

const completeManifest = REQUIRED_PACKED_RUNTIME_ASSETS.map((entry) =>
  entry.endsWith("/") ? `${entry}2025_12_28_000_initial_schema.ts` : entry,
);

test("runtime manifest includes both entrypoints, disk schemas, migrations and vendor tools", () => {
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

test("directory prefixes require a file and do not match similarly named directories", () => {
  expect(
    findMissingPackedAssets(
      ["dist/src/db/migrations/", "dist/src/db/migrations-old/a.ts"],
      ["dist/src/db/migrations/"],
    ),
  ).toEqual(["dist/src/db/migrations/"]);
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
