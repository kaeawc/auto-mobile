import { beforeAll, expect, test } from "bun:test";
import {
  BUNDLE_MAX_SPEC_BYTES,
  BUNDLE_MAX_MANIFEST_BYTES,
  BUNDLE_MAX_EXPANDED_BYTES,
  BUNDLE_MAX_COMPRESSED_BYTES,
  readPrototypeBundle,
} from "../../../src/features/prototype/prototypeBundle";
import { MAX_PROTOTYPE_ASSET_BYTES } from "../../../src/features/prototype/prototypeAssets";
import {
  assetRecord,
  boundaryBytes,
  fixtureEntries,
  referencedSpec,
  tinyAsset,
} from "../../../scripts/prototype/bundleCorpusFixtures";
import { corpusZip } from "../../../scripts/prototype/bundleCorpusZip";

let archiveExact: Buffer;
let exact: Buffer;
let over: Buffer;
let overPath: string;
beforeAll(() => {
  const assets = Array.from({ length: 4 }, (_, i) => {
    const bytes = boundaryBytes(MAX_PROTOTYPE_ASSET_BYTES, tinyAsset("image/png", i));
    return assetRecord(`image-${i}`, "image/png", bytes);
  });
  const font = assetRecord("font", "font/ttf");
  overPath = font.entry.name;
  const input = referencedSpec(assets.map((a) => a.manifest.id));
  const make = (withFont: boolean) => {
    const json = withFont
      ? referencedSpec(
          assets.map((a) => a.manifest.id),
          ["font"],
        )
      : input;
    const spec = Buffer.concat([json, Buffer.alloc(BUNDLE_MAX_SPEC_BYTES - json.length, 32)]);
    const entries = fixtureEntries(spec, assets, withFont ? [font] : []);
    entries[0] = {
      ...entries[0],
      bytes: Buffer.concat([
        entries[0].bytes,
        Buffer.alloc(BUNDLE_MAX_MANIFEST_BYTES - entries[0].bytes.length, 32),
      ]),
    };
    return corpusZip(entries.map((entry) => ({ ...entry, method: 8 })));
  };
  exact = make(false);
  over = make(true);
  const storedSpec = Buffer.concat([input, Buffer.alloc(BUNDLE_MAX_SPEC_BYTES - input.length, 32)]);
  const paddedEntries = (records: typeof assets) => {
    const entries = fixtureEntries(storedSpec, records);
    entries[0] = {
      ...entries[0],
      bytes: Buffer.concat([
        entries[0].bytes,
        Buffer.alloc(BUNDLE_MAX_MANIFEST_BYTES - entries[0].bytes.length, 32),
      ]),
    };
    return entries;
  };
  const tooBig = corpusZip(paddedEntries(assets));
  const overhead = tooBig.length - BUNDLE_MAX_COMPRESSED_BYTES;
  const last = assets[3];
  const adjusted = [
    ...assets.slice(0, 3),
    assetRecord(
      last.manifest.id,
      "image/png",
      Buffer.from(last.entry.bytes.subarray(0, last.entry.bytes.length - overhead)),
    ),
  ];
  archiveExact = corpusZip(paddedEntries(adjusted));
});
test("exact expanded cap is accepted using actual bytes across entries", () => {
  const result = readPrototypeBundle(exact);
  expect(result.ok).toBe(true);
  if (result.ok) {
    const assetBytes = [...result.bundle.assets.values()].reduce(
      (sum, a) => sum + a.bytes.length,
      0,
    );
    expect(assetBytes + BUNDLE_MAX_SPEC_BYTES + BUNDLE_MAX_MANIFEST_BYTES).toBe(
      BUNDLE_MAX_EXPANDED_BYTES,
    );
  }
});
test("combined expanded cap stops a subsequent individually valid font", () => {
  expect(readPrototypeBundle(over)).toMatchObject({
    ok: false,
    code: "expanded_too_large",
    path: overPath,
  });
});

test("a valid archive exactly at the whole-file cap is accepted", () => {
  expect(archiveExact.length).toBe(BUNDLE_MAX_COMPRESSED_BYTES);
  expect(readPrototypeBundle(archiveExact).ok).toBe(true);
});
test("valid whole-file cap archive plus one byte fails before parsing", () => {
  const bytes = Buffer.concat([archiveExact, Buffer.from([0])]);
  expect(readPrototypeBundle(bytes)).toMatchObject({ ok: false, code: "archive_too_large" });
});
