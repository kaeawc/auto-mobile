import { describe, expect, test } from "bun:test";
import {
  BUNDLE_LIMITS,
  readPrototypeBundle,
  MAX_BUNDLE_SPEC_BYTES,
  MAX_BUNDLE_MANIFEST_BYTES,
} from "../../../../src/features/prototype/bundle";
import { writePrototypeZip } from "../../../../src/features/prototype/bundle/prototypeZipWriter";
import { entryExpandedCap } from "../../../../src/features/prototype/bundle/bundleLimits";
import { readZipDirectory } from "../../../../src/features/prototype/bundle/zipDirectory";
import { inflateZipEntries } from "../../../../src/features/prototype/bundle/zipInflate";
import {
  RECIPE_MINIMAL_SPEC,
  materializeBundleRecipe,
} from "../../../helpers/prototypeBundleRecipe";

const names = [
  "bundle.json",
  "spec.json",
  `assets/${"0".repeat(64)}.png`,
  `fonts/${"0".repeat(64)}.ttf`,
];
describe("per-entry expanded limits", () => {
  for (const name of names) {
    test(`${name}: exact cap and cap + 1`, () => {
      const cap = entryExpandedCap(name);
      const build = (count: number): Buffer =>
        Buffer.from(
          materializeBundleRecipe({
            description: "single entry boundary",
            expected: "accept",
            entries: [{ name, repeat: { byte: 32, count } }],
          }),
        );
      const bytes = build(cap);
      expect(
        inflateZipEntries(bytes, readZipDirectory(bytes, BUNDLE_LIMITS), BUNDLE_LIMITS).get(name)
          ?.length,
      ).toBe(cap);
      const larger = build(cap + 1);
      expect(() =>
        inflateZipEntries(larger, readZipDirectory(larger, BUNDLE_LIMITS), BUNDLE_LIMITS),
      ).toThrow("expanded_too_large");
    });
  }
  test.each([0, 1])("separate asset-total budget at boundary + %i byte(s)", (lastBytes) => {
    const records = Array.from({ length: 5 }, (_, index) => {
      const sha256 = String(index).padStart(64, "0");
      return { id: `image${index}`, file: `assets/${sha256}.png`, sha256, mediaType: "image/png" };
    });
    const spec = {
      ...RECIPE_MINIMAL_SPEC,
      root: {
        type: "column",
        children: records.map((item) => ({ type: "image", asset: item.id })),
      },
    };
    const build = (lastBytes: number): Uint8Array =>
      materializeBundleRecipe({
        description: "asset-total boundary",
        base: "minimal",
        expected: "accept",
        spec,
        manifest: { assets: records },
        entries: records.map((item, index) => ({
          name: item.file,
          repeat: { byte: index, count: index < 4 ? 16 : lastBytes },
        })),
      });
    // Hashes are deliberately wrong: at the boundary we reach hash validation;
    // one extra byte must instead stop at the independent aggregate asset cap.
    expect(() => readPrototypeBundle(build(lastBytes), { maxAssetBytes: 64 })).toThrow(
      lastBytes === 0 ? "sha_mismatch" : "expanded_too_large",
    );
  });
  test("writer rejects aggregate excess before making payload copies", () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024);
    const entries = new Map(
      Array.from(
        { length: 5 },
        (_, index) => [`assets/${String(index).padStart(64, "0")}.png`, bytes] as const,
      ),
    );
    expect(() => writePrototypeZip(entries)).toThrow("expanded_too_large");
  });
  test("metadata cap identities remain explicit", () => {
    expect(entryExpandedCap("bundle.json")).toBe(MAX_BUNDLE_MANIFEST_BYTES);
    expect(entryExpandedCap("spec.json")).toBe(MAX_BUNDLE_SPEC_BYTES);
  });
});
