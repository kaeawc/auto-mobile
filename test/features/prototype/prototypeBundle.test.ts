import { beforeAll, describe, expect, test } from "bun:test";
import { crc32 } from "node:zlib";
import contract from "../../../schemas/prototype-asset-contract.json";
import {
  readPrototypeBundle,
  exportPrototypeBundle,
  BUNDLE_ERROR_CODES,
  BUNDLE_MAX_COMPRESSED_BYTES,
  BUNDLE_MAX_ENTRIES,
  BUNDLE_MAX_SPEC_BYTES,
  BUNDLE_MAX_MANIFEST_BYTES,
  BUNDLE_MAX_EXPANDED_BYTES,
  BUNDLE_MAX_RATIO,
} from "../../../src/features/prototype/prototypeBundle";
import { bundleCorpus, corpusBytes, exportInput } from "./prototypeBundleCorpus";
import { canonicalBundleFiles } from "../../../src/features/prototype/bundle/bundleExport";
import { fixtureEntries, minimalSpec } from "../../../scripts/prototype/bundleCorpusFixtures";

const corpus = bundleCorpus();
beforeAll(() => {
  for (const entry of corpus.cases) {
    corpusBytes(entry);
  }
});
describe("shared prototype bundle corpus", () => {
  test("contract, caps and closed error vocabulary stay shared", () => {
    expect(corpus.contractLimits).toEqual(contract.limits);
    expect(corpus.errorCodes).toEqual([...BUNDLE_ERROR_CODES]);
    expect(corpus.caps).toEqual({
      entries: BUNDLE_MAX_ENTRIES,
      spec: BUNDLE_MAX_SPEC_BYTES,
      manifest: BUNDLE_MAX_MANIFEST_BYTES,
      expanded: BUNDLE_MAX_EXPANDED_BYTES,
      compressed: BUNDLE_MAX_COMPRESSED_BYTES,
      ratio: BUNDLE_MAX_RATIO,
    });
    expect(new Set(corpus.errorCodes).size).toBe(corpus.errorCodes.length);
    expect(JSON.stringify(corpus).length).toBeLessThan(600 * 1024);
  });
  for (const entry of corpus.cases) {
    test(entry.name, () => {
      const result = readPrototypeBundle(corpusBytes(entry));
      expect(result.ok).toBe(entry.expect === "accept");
      if (!result.ok) {
        expect<unknown>(result.code).toBe(entry.code);
        expect(result.path).toBe(entry.path);
        expect(result.message.length).toBeGreaterThan(0);
      }
    });
    if (entry.exportInputs) {
      const input = entry.exportInputs;
      test(`${entry.name} export byte equality and read/export roundtrip`, () => {
        const result = exportPrototypeBundle(exportInput(input));
        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }
        expect(Buffer.from(result.bytes).toString("base64")).toBe(entry.bundleBase64);
        const read = readPrototypeBundle(result.bytes);
        expect(read.ok).toBe(true);
        if (!read.ok) {
          return;
        }
        expect(Buffer.from(read.bundle.spec).toString("base64")).toBe(input.specBase64);
        expect([...read.bundle.assets.keys()]).toEqual(input.assets.map((a) => a.id));
        expect([...read.bundle.fonts.keys()]).toEqual(input.fonts.map((a) => a.id));
        const again = exportPrototypeBundle({
          specBytes: read.bundle.spec,
          assets: (id) => read.bundle.assets.get(id),
          fonts: (id) => read.bundle.fonts.get(id),
        });
        expect(again.ok && Buffer.from(again.bytes).equals(Buffer.from(result.bytes))).toBe(true);
      });
    }
  }
});

test("every truncation is a typed rejection and never throws", () => {
  const bytes = corpusBytes(corpus.cases[0]);
  for (let offset = 0; offset < bytes.length; offset++) {
    expect(readPrototypeBundle(bytes.subarray(0, offset)).ok).toBe(false);
  }
});
test("offset views and caller mutation cannot alter imported bytes", () => {
  const bytes = corpusBytes(corpus.cases[0]);
  const padded = Buffer.concat([Buffer.from([0]), bytes, Buffer.from([0])]);
  const result = readPrototypeBundle(padded.subarray(1, -1));
  padded.fill(0);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(Buffer.from(result.bundle.spec).equals(minimalSpec)).toBe(true);
  }
});
test("archive cap plus one is rejected before ZIP parsing", () => {
  expect(readPrototypeBundle(new Uint8Array(BUNDLE_MAX_COMPRESSED_BYTES + 1))).toMatchObject({
    ok: false,
    code: "archive_too_large",
  });
});
test("whole archive at exactly the file cap reaches structural validation", () => {
  expect(readPrototypeBundle(new Uint8Array(BUNDLE_MAX_COMPRESSED_BYTES))).toMatchObject({
    ok: false,
    code: "not_a_zip",
  });
});
test("missing referenced export image and font are named", () => {
  const golden = corpus.cases.find((c) => c.name === "golden-image-font")!;
  const input = exportInput(golden.exportInputs!);
  expect(exportPrototypeBundle({ ...input, assets: () => undefined })).toMatchObject({
    ok: false,
    code: "asset_missing",
    path: "image",
  });
  expect(exportPrototypeBundle({ ...input, fonts: () => undefined })).toMatchObject({
    ok: false,
    code: "asset_missing",
    path: "font",
  });
});
test("exports whitelist record fields, ignore unreferenced lookups and preserve spec bytes", () => {
  const golden = corpus.cases.find((c) => c.name === "golden-image-font")!;
  const input = exportInput(golden.exportInputs!);
  const privateFields = {
    storage: "DO_NOT_SHARE",
    library: "DO_NOT_SHARE",
    sourceUrl: "DO_NOT_SHARE",
    lastOpenedAt: "DO_NOT_SHARE",
    thumbnail: "DO_NOT_SHARE",
  };
  const seen: string[] = [];
  const result = exportPrototypeBundle({
    ...input,
    ...privateFields,
    assets: (id) => {
      seen.push(id);
      const asset = input.assets(id);
      return asset ? { ...asset, ...privateFields } : undefined;
    },
  });
  expect(result.ok).toBe(true);
  expect(seen).toEqual(["image"]);
  if (result.ok) {
    const text = Buffer.from(result.bytes).toString();
    for (const key of Object.keys(privateFields)) {
      expect(text.includes(key)).toBe(false);
    }
    expect(text.includes("DO_NOT_SHARE")).toBe(false);
  }
});
test("CRC primitive uses the standard ZIP check vector", () => {
  expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
});
test("canonical JSON is compact without newline and key/entry ordering is fixed", () => {
  const files = canonicalBundleFiles({
    specBytes: minimalSpec,
    assets: () => undefined,
    fonts: () => undefined,
  });
  expect([...files.keys()]).toEqual(["bundle.json", "spec.json"]);
  expect(Buffer.from(files.get("bundle.json")!).toString()).toBe(
    Buffer.from(fixtureEntries()[0].bytes).toString(),
  );
});
test("deterministic malformed-byte fuzz samples never escape the reader", () => {
  const bytes = corpusBytes(corpus.cases[0]);
  for (let offset = 0; offset < bytes.length; offset += 7) {
    const changed = Buffer.from(bytes);
    changed[offset] ^= 0xff;
    const result = readPrototypeBundle(changed);
    expect(typeof result.ok).toBe("boolean");
    if (!result.ok) {
      expect(BUNDLE_ERROR_CODES).toContain(result.code);
    }
  }
});
