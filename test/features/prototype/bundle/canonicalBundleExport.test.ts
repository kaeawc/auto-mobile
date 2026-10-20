import { describe, expect, test } from "bun:test";
import { crc32 } from "node:zlib";
import {
  BUNDLE_LIMITS,
  MAX_BUNDLE_COMPRESSED_BYTES,
  MAX_BUNDLE_EXPANDED_BYTES,
  MAX_BUNDLE_MANIFEST_BYTES,
  MAX_BUNDLE_SPEC_BYTES,
  MAX_BUNDLE_ENTRIES,
  MAX_BUNDLE_RATIO,
  exportCanonicalBundle,
  readPrototypeBundle,
  preflightBundleSecrets,
  parseBundleManifest,
} from "../../../../src/features/prototype/bundle";
import {
  portableBundleCrc32,
  bundleSha256,
} from "../../../../src/features/prototype/bundle/bundleIntegrity";
import { bundleReferences } from "../../../../src/features/prototype/bundle/bundleReferences";
import { readZipDirectory } from "../../../../src/features/prototype/bundle/zipDirectory";
import { inflateZipEntries } from "../../../../src/features/prototype/bundle/zipInflate";
import {
  materializeBundleRecipe,
  RECIPE_MINIMAL_SPEC,
  type BundleRecipe,
} from "../../../helpers/prototypeBundleRecipe";
import assetContract from "../../../../schemas/prototype-asset-contract.json";

const image = {
  id: "image",
  mimeType: "image/png",
  bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
} as const;
const font = { id: "font", mimeType: "font/ttf", bytes: Uint8Array.from([0, 1, 0, 0]) } as const;
const spec = {
  ...RECIPE_MINIMAL_SPEC,
  root: {
    type: "column",
    children: [
      { type: "image", asset: { light: "image", dark: "image" } },
      { type: "text", text: "Font", style: { fontFamily: { asset: "font" } } },
    ],
  },
};
function recipe(overrides: Partial<BundleRecipe> = {}): BundleRecipe {
  return { description: "boundary", base: "minimal", expected: "accept", ...overrides };
}

describe("canonical bundle export", () => {
  test("round trips images and fonts by SHA and preserves authored spec", () => {
    const bytes = exportCanonicalBundle({
      spec,
      assets: [image],
      fonts: [font],
      requires: ["prototype_data_model_v1"],
    });
    const read = readPrototypeBundle(bytes);
    expect(JSON.parse(read.specJson)).toEqual(spec);
    expect(read.assets.get(bundleSha256(image.bytes))).toEqual(image.bytes);
    expect(read.fonts.get(bundleSha256(font.bytes))).toEqual(font.bytes);
    expect(read.manifest.requires).toEqual(["prototype_data_model_v1"]);
    expect(
      exportCanonicalBundle({
        spec: JSON.parse(read.specJson),
        assets: [image],
        fonts: [font],
        requires: read.manifest.requires,
      }),
    ).toEqual(bytes);
  });
  test("exports are byte-identical across object order and ignored uploads", () => {
    const first = exportCanonicalBundle({ spec, assets: [image], fonts: [font] });
    const second = exportCanonicalBundle({
      spec: { root: spec.root, window: spec.window, id: spec.id },
      fonts: [font],
      assets: [{ ...image, id: "ignored", bytes: Uint8Array.from([9]) }, image],
    });
    expect(second).toEqual(first);
  });
  test("rebuilds from spec without local storage, metadata or unreferenced bytes", () => {
    const stored = {
      ...RECIPE_MINIMAL_SPEC,
      storage: { stored: "stored-secret" },
      label: "stored-label",
      library: { saved: "library-secret" },
      source: "source-secret",
      sourceUrl: "url-secret",
      lastOpenedAt: "time-secret",
      thumbnail: "thumbnail-secret",
    };
    const bytes = exportCanonicalBundle({
      spec: stored,
      assets: [{ ...image, bytes: Buffer.from("unused-secret") }],
    });
    const read = readPrototypeBundle(bytes);
    expect(JSON.parse(read.specJson)).toEqual(RECIPE_MINIMAL_SPEC);
    expect(read.assets.size).toBe(0);
    for (const value of [
      "stored-secret",
      "stored-label",
      "library-secret",
      "source-secret",
      "url-secret",
      "time-secret",
      "thumbnail-secret",
      "unused-secret",
    ]) {
      expect(Buffer.from(bytes).includes(value)).toBe(false);
    }
  });
  test("reuses stable JSON ordering for numeric keys and preserves authored values", () => {
    const value = {
      ...RECIPE_MINIMAL_SPEC,
      data: { "10": "ten", "2": "two", z: "last", a: "first" },
    };
    const read = readPrototypeBundle(exportCanonicalBundle({ spec: value }));
    expect(read.specJson).toContain('"data":{"2":"two","10":"ten","a":"first","z":"last"}');
    expect(JSON.parse(read.specJson)).toEqual(value);
  });
  test("refuses unknown spec fields, absent references and duplicate IDs", () => {
    expect(() =>
      exportCanonicalBundle({ spec: { ...spec, typo: true }, assets: [image], fonts: [font] }),
    ).toThrow("spec_invalid");
    expect(() => exportCanonicalBundle({ spec })).toThrow("missing_entry");
    expect(() => exportCanonicalBundle({ spec, assets: [image, image], fonts: [font] })).toThrow(
      "manifest_invalid",
    );
  });
  test("shares identical bytes for distinct opaque IDs", () => {
    const shared = {
      ...spec,
      root: {
        type: "column",
        children: [
          { type: "image", asset: "image" },
          { type: "image", asset: "alias" },
        ],
      },
    };
    const read = readPrototypeBundle(
      exportCanonicalBundle({ spec: shared, assets: [image, { ...image, id: "alias" }] }),
    );
    expect(read.manifest.assets).toHaveLength(2);
    expect(read.assets.size).toBe(1);
  });
  test("refuses font bytes whose signature disagrees with their declared MIME type", () => {
    expect(() =>
      exportCanonicalBundle({
        spec,
        assets: [image],
        fonts: [{ ...font, bytes: Buffer.from("OTTO") }],
      }),
    ).toThrow("manifest_invalid");
  });
  test("reference walk covers item images, span fonts and conditional styles only", () => {
    const refs = bundleReferences({
      root: {
        type: "column",
        children: [
          {
            type: "image",
            asset: { light: "light", dark: "dark" },
            onTap: [{ type: "emit", payload: { asset: "opaque" } }],
          },
          {
            type: "text",
            spans: [{ text: "x", style: { fontFamily: { asset: "span" } } }],
            styleWhen: [{ style: { fontFamily: { asset: "conditional" } } }],
          },
          { type: "carousel", items: [{ image: "item" }] },
        ],
      },
      data: { asset: "opaque-data" },
    });
    expect([...refs.assets].sort()).toEqual(["dark", "item", "light"]);
    expect([...refs.fonts].sort()).toEqual(["conditional", "span"]);
  });
  test("strict manifest validates groups, hash paths and unique IDs/capabilities", () => {
    const manifest = readPrototypeBundle(
      exportCanonicalBundle({ spec, assets: [image], fonts: [font] }),
    ).manifest;
    expect(() => parseBundleManifest({ ...manifest, sourceUrl: "x" })).toThrow("manifest_invalid");
    expect(() => parseBundleManifest({ ...manifest, fonts: manifest.assets })).toThrow(
      "manifest_invalid",
    );
    expect(() =>
      parseBundleManifest({ ...manifest, assets: [{ ...manifest.assets[0], file: "wrong" }] }),
    ).toThrow("manifest_invalid");
    expect(() => parseBundleManifest({ ...manifest, requires: ["a", "a"] })).toThrow(
      "manifest_invalid",
    );
  });
  test("CRC fallback matches standard vector and runtime CRC", () => {
    const bytes = Buffer.from("123456789");
    expect(portableBundleCrc32(bytes)).toBe(0xcbf43926);
    expect(portableBundleCrc32(bytes)).toBe(crc32(bytes));
  });
});

describe("bundle limits", () => {
  test("caps derive from the shared asset contract", () => {
    const limits = assetContract.limits;
    expect(MAX_BUNDLE_ENTRIES).toBe(limits.MAX_PROTOTYPE_ASSET_COUNT + 4);
    expect(MAX_BUNDLE_EXPANDED_BYTES).toBe(
      limits.MAX_PROTOTYPE_ASSET_TOTAL_BYTES + MAX_BUNDLE_SPEC_BYTES + MAX_BUNDLE_MANIFEST_BYTES,
    );
    expect(MAX_BUNDLE_RATIO).toBe(64);
    expect(MAX_BUNDLE_COMPRESSED_BYTES).toBe(17899558);
  });
  test("compressed bytes accept boundary and reject plus one at real cap cheaply", () => {
    const bytes = Buffer.alloc(MAX_BUNDLE_COMPRESSED_BYTES + 1);
    expect(() => readPrototypeBundle(bytes.subarray(0, MAX_BUNDLE_COMPRESSED_BYTES))).toThrow(
      "eocd_invalid",
    );
    expect(() => readPrototypeBundle(bytes)).toThrow("compressed_too_large");
  });
  test("exact compressed, expanded and entry limits accept; one less rejects", () => {
    const bytes = materializeBundleRecipe(recipe());
    const directory = readZipDirectory(Buffer.from(bytes), BUNDLE_LIMITS);
    const expanded = directory.entries.reduce((sum, entry) => sum + entry.expanded, 0);
    expect(
      readPrototypeBundle(bytes, {
        maxEntries: 2,
        maxCompressedBytes: bytes.length,
        maxExpandedBytes: expanded,
      }),
    ).toBeDefined();
    expect(() => readPrototypeBundle(bytes, { maxCompressedBytes: bytes.length - 1 })).toThrow(
      "compressed_too_large",
    );
    expect(() => readPrototypeBundle(bytes, { maxExpandedBytes: expanded - 1 })).toThrow(
      "expanded_too_large",
    );
    expect(() => readPrototypeBundle(bytes, { maxEntries: 1 })).toThrow("too_many_entries");
  });
  test("DEFLATE ratio boundary accepts and plus one rejects", () => {
    const build = (count: number): Buffer =>
      Buffer.from(
        materializeBundleRecipe(
          recipe({
            base: undefined,
            entries: [{ name: "spec.json", method: 8, repeat: { byte: 65, count } }],
          }),
        ),
      );
    const bytes = build(10);
    const directory = readZipDirectory(bytes, BUNDLE_LIMITS);
    expect(directory.entries[0]!.compressed).toBe(5);
    expect(
      inflateZipEntries(bytes, directory, { ...BUNDLE_LIMITS, maxRatio: 2 }).get("spec.json")
        ?.length,
    ).toBe(10);
    const larger = build(11);
    expect(() =>
      inflateZipEntries(larger, readZipDirectory(larger, BUNDLE_LIMITS), {
        ...BUNDLE_LIMITS,
        maxRatio: 2,
      }),
    ).toThrow("ratio_exceeded");
  });
  test("real aggregate expanded cap accepts its boundary without compression work", () => {
    const entries = Array.from({ length: 4 }, (_, index) => ({
      name: `assets/${String(index).padStart(64, "0")}.png`,
      repeat: { byte: index, count: assetContract.limits.MAX_PROTOTYPE_ASSET_BYTES },
    }));
    entries.push(
      { name: "bundle.json", repeat: { byte: 32, count: MAX_BUNDLE_MANIFEST_BYTES } },
      { name: "spec.json", repeat: { byte: 32, count: MAX_BUNDLE_SPEC_BYTES } },
    );
    const bytes = Buffer.from(materializeBundleRecipe(recipe({ base: undefined, entries })));
    const directory = readZipDirectory(bytes, BUNDLE_LIMITS);
    const inflated = inflateZipEntries(bytes, directory, BUNDLE_LIMITS);
    expect([...inflated.values()].reduce((sum, entry) => sum + entry.length, 0)).toBe(
      MAX_BUNDLE_EXPANDED_BYTES,
    );
    expect(() =>
      inflateZipEntries(bytes, directory, {
        ...BUNDLE_LIMITS,
        maxExpandedBytes: MAX_BUNDLE_EXPANDED_BYTES - 1,
      }),
    ).toThrow("expanded_too_large");
  });
  test("real entry-count boundary permits 36 structural records and rejects 37", () => {
    const entries = Array.from({ length: 36 }, (_, index) => ({
      name: `assets/${String(index).padStart(64, "0")}.png`,
    }));
    const bytes = Buffer.from(materializeBundleRecipe(recipe({ base: undefined, entries })));
    expect(readZipDirectory(bytes, BUNDLE_LIMITS).entries).toHaveLength(36);
    const larger = Buffer.from(
      materializeBundleRecipe(
        recipe({ base: undefined, entries: [...entries, { name: "spec.json" }] }),
      ),
    );
    expect(() => readZipDirectory(larger, BUNDLE_LIMITS)).toThrow("too_many_entries");
  });
});

describe("secret preflight", () => {
  test("warns on secret headers, URL and explicit query keys, and private hosts without values", () => {
    const warnings = preflightBundleSecrets({
      root: {
        type: "button",
        onTap: [
          {
            type: "request",
            url: "https://127.1/?token=secret-value&SIG=signed",
            headers: {
              Authorization: "secret-value",
              Cookie: "secret-value",
              "X-Api-Key": "secret-value",
              Accept: "json",
            },
            query: { key: "secret-value", secret: "secret-value", page: "1" },
            onSuccess: [{ type: "request", url: "http://[::ffff:192.168.1.1]/" }],
          },
        ],
      },
    });
    expect(warnings.filter((warning) => warning.code === "secret_header")).toHaveLength(3);
    expect(warnings.filter((warning) => warning.code === "secret_query")).toHaveLength(4);
    expect(warnings.filter((warning) => warning.code === "private_host")).toHaveLength(2);
    expect(JSON.stringify(warnings)).not.toContain("secret-value");
  });
  test("covers localhost, IPv6, private ranges and leaves public requests quiet", () => {
    for (const host of [
      "localhost",
      "sub.localhost.",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.0.1",
      "[::1]",
      "[fc00::1]",
      "[fe80::1]",
    ]) {
      expect(
        preflightBundleSecrets({
          root: { type: "button", onTap: [{ type: "request", url: `http://${host}/` }] },
        }).map((warning) => warning.code),
      ).toEqual(["private_host"]);
    }
    expect(
      preflightBundleSecrets({
        root: {
          type: "button",
          onTap: [
            { type: "request", url: "https://example.com/?page=1", headers: { Accept: "json" } },
          ],
        },
        data: { type: "request", url: "http://localhost/?token=x" },
      }),
    ).toEqual([]);
  });
});
