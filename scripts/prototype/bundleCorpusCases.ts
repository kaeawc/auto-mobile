import { deflateRawSync } from "node:zlib";
import type { BundleErrorCode } from "../../src/features/prototype/prototypeBundle";
import { bundleSha256 } from "../../src/features/prototype/bundle/bundleManifest";
import {
  BUNDLE_MAX_SPEC_BYTES,
  BUNDLE_MAX_MANIFEST_BYTES,
} from "../../src/features/prototype/prototypeBundle";
import {
  MAX_PROTOTYPE_ASSET_BYTES,
  MAX_PROTOTYPE_FONT_ASSET_BYTES,
} from "../../src/features/prototype/prototypeAssets";
import { corpusZip, type CorpusZipEntry, type CorpusZipOptions } from "./bundleCorpusZip";
import {
  assetRecord,
  fixtureEntries,
  minimalSpec,
  referencedSpec,
  tinyAsset,
  boundaryBytes,
  zeroBoundaryBytes,
  type CorpusExportInputs,
} from "./bundleCorpusFixtures";

export interface BundleCorpusCase {
  name: string;
  expect: "accept" | "reject";
  code?: BundleErrorCode;
  path?: string;
  bundleBase64: string;
  notes: string;
  exportInputs?: CorpusExportInputs;
}
export function makeCorpusCase(
  name: string,
  entries: CorpusZipEntry[],
  code?: BundleErrorCode,
  path?: string,
  options?: CorpusZipOptions,
  notes = "Generated ZIP32 probe.",
): BundleCorpusCase {
  return {
    name,
    expect: code ? "reject" : "accept",
    ...(code ? { code } : {}),
    ...(path === undefined ? {} : { path }),
    bundleBase64: corpusZip(entries, options).toString("base64"),
    notes,
  };
}
export function structuralCases(): BundleCorpusCase[] {
  const base = fixtureEntries();
  const modify = (patch: Partial<CorpusZipEntry>): CorpusZipEntry[] => [
    { ...base[0], ...patch },
    ...base.slice(1),
  ];
  const cases: BundleCorpusCase[] = [];
  for (const name of [
    "../spec.json",
    "/spec.json",
    "assets\\bad.png",
    "bad\0name",
    "café",
    "__MACOSX/x",
    "assets/",
  ]) {
    cases.push(
      makeCorpusCase(
        `forbidden-${JSON.stringify(name)}`,
        modify({ name }),
        "entry_name_forbidden",
        name,
      ),
    );
  }
  cases.push(
    makeCorpusCase(
      "outside-allowlist",
      modify({ name: "library.json" }),
      "entry_not_allowed",
      "library.json",
    ),
  );
  cases.push(
    makeCorpusCase("duplicate-exact", [...base, base[0]], "duplicate_entry", "bundle.json"),
  );
  cases.push(
    makeCorpusCase(
      "duplicate-case",
      [...base, { ...base[0], name: "BUNDLE.JSON" }],
      "duplicate_entry",
      "BUNDLE.JSON",
    ),
  );
  for (const [name, attrs] of [
    ["symlink", 0xa0000000],
    ["fifo", 0x10000000],
    ["socket", 0xc0000000],
    ["directory-mode", 0x40000000],
  ] as const) {
    cases.push(makeCorpusCase(name, modify({ attrs }), "link_entry", "bundle.json"));
  }
  cases.push(makeCorpusCase("regular-unix-mode", modify({ attrs: 0x81a40000 })));
  for (const flags of [1, 64]) {
    cases.push(
      makeCorpusCase(`encrypted-${flags}`, modify({ flags }), "encrypted_entry", "bundle.json"),
    );
  }
  cases.push(
    makeCorpusCase(
      "descriptor-only",
      modify({ flags: 8, localExpanded: 0, localCompressed: 0, localCrc: 0 }),
      "header_mismatch",
      "bundle.json",
    ),
  );
  cases.push(
    makeCorpusCase(
      "method-unsupported",
      modify({ method: 99 }),
      "method_unsupported",
      "bundle.json",
    ),
  );
  cases.push(makeCorpusCase("multi-disk-eocd", base, "multi_disk", undefined, { disk: 1 }));
  cases.push(makeCorpusCase("multi-disk-entry", modify({ disk: 1 }), "multi_disk", "bundle.json"));
  cases.push(makeCorpusCase("zip64-eocd", base, "zip64_unsupported", undefined, { zip64: true }));
  cases.push(
    makeCorpusCase(
      "zip64-entry",
      modify({ expanded: 0xffffffff }),
      "zip64_unsupported",
      "bundle.json",
    ),
  );
  cases.push(
    makeCorpusCase(
      "extra-field-central",
      modify({ extra: 4 }),
      "extra_field_forbidden",
      "bundle.json",
    ),
  );
  cases.push(
    makeCorpusCase(
      "extra-field-local",
      modify({ localExtra: 4 }),
      "extra_field_forbidden",
      "bundle.json",
    ),
  );
  cases.push(
    makeCorpusCase("archive-comment", base, "extra_field_forbidden", undefined, {
      comment: Buffer.from("no"),
    }),
  );
  for (const [name, patch] of [
    ["local-name", { localName: "spec.json" }],
    ["local-method", { localMethod: 8 }],
    ["local-size", { localExpanded: 1 }],
    ["local-compressed", { localCompressed: 1 }],
    ["local-crc", { localCrc: 1 }],
  ] as const) {
    cases.push(makeCorpusCase(name, modify(patch), "header_mismatch", "bundle.json"));
  }
  cases.push(
    makeCorpusCase(
      "overlap",
      [base[0], { ...base[1], localOffset: 0 }],
      "header_mismatch",
      "spec.json",
    ),
  );
  cases.push(
    makeCorpusCase("trailing-bytes", base, "trailing_bytes", undefined, {
      trailing: Buffer.from([1]),
    }),
  );
  cases.push(
    makeCorpusCase("two-eocd", base, "not_a_zip", undefined, {
      trailing: Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    }),
  );
  cases.push({
    name: "no-eocd",
    expect: "reject",
    code: "not_a_zip",
    bundleBase64: Buffer.from("not zip").toString("base64"),
    notes: "Not a ZIP.",
  });
  cases.push(
    makeCorpusCase(
      "too-many-entries-37",
      Array.from({ length: 37 }, () => ({ name: "spec.json", bytes: Buffer.alloc(0) })),
      "too_many_entries",
    ),
  );
  cases.push(makeCorpusCase("crc-lie", modify({ crc: 1 }), "crc_mismatch", "bundle.json"));
  for (const method of [0, 8]) {
    for (const delta of [-1, 1]) {
      cases.push(
        makeCorpusCase(
          `size-lie-${method}-${delta}`,
          modify({ method, expanded: base[0].bytes.length + delta }),
          "size_mismatch",
          "bundle.json",
        ),
      );
    }
  }
  const encoded = Buffer.concat([deflateRawSync(base[0].bytes), Buffer.from([0])]);
  cases.push(
    makeCorpusCase(
      "unused-deflate-input",
      modify({ method: 8, encoded }),
      "size_mismatch",
      "bundle.json",
    ),
  );
  cases.push(
    makeCorpusCase(
      "broken-deflate",
      modify({ method: 8, encoded: Buffer.from([255]) }),
      "size_mismatch",
      "bundle.json",
    ),
  );
  for (const delta of [0, 1]) {
    // With this legal JSON padding, zlib emits 127 compressed spec bytes plus 142 manifest bytes.
    // (26758 + 142) / (127 + 142) == 100, and one more actual output byte crosses the bound.
    const spec = Buffer.from(
      minimalSpec.toString() + " ".repeat(26758 + delta - minimalSpec.length),
    );
    const entries = fixtureEntries(spec);
    entries[1] = { ...entries[1], method: 8, encoded: deflateRawSync(spec) };
    cases.push(
      makeCorpusCase(
        `ratio-100${delta ? "-plus-one-byte" : "-exact"}`,
        entries,
        delta ? "ratio_exceeded" : undefined,
        delta ? "spec.json" : undefined,
      ),
    );
  }
  return cases;
}
export function manifestCases(): BundleCorpusCase[] {
  const base = fixtureEntries();
  const cases: BundleCorpusCase[] = [];
  const modify = (name: string, text: string, code: BundleErrorCode = "manifest_invalid"): void => {
    cases.push(
      makeCorpusCase(
        name,
        [{ name: "bundle.json", bytes: Buffer.from(text) }, base[1]],
        code,
        "bundle.json",
      ),
    );
  };
  const text = Buffer.from(base[0].bytes).toString();
  modify(
    "manifest-duplicate-key",
    text.replace('"bundleFormatVersion":1', '"bundleFormatVersion":1,"bundleFormatVersion":1'),
  );
  modify(
    "manifest-escaped-duplicate",
    text.replace(
      '"bundleFormatVersion":1',
      '"bundleFormatVersion":1,"bundleFormatVersi\\u006fn":1',
    ),
  );
  for (const key of [
    "label",
    "source",
    "storage",
    "library",
    "sourceUrl",
    "lastOpenedAt",
    "thumbnail",
    "unknown",
  ]) {
    modify(
      `manifest-extra-${key}`,
      text.replace('"bundleFormatVersion":1', `"${key}":null,"bundleFormatVersion":1`),
    );
  }
  modify("manifest-version", text.replace('"bundleFormatVersion":1', '"bundleFormatVersion":2'));
  modify("manifest-not-json", "{");
  modify("manifest-depth", "[".repeat(65) + "0" + "]".repeat(65));
  for (const requires of [["z", "a"], ["a", "a"], ["Bad Name"], [1], "a"]) {
    modify(
      `requires-${JSON.stringify(requires)}`,
      text.replace('"requires":[]', `"requires":${JSON.stringify(requires)}`),
      "requires_invalid",
    );
  }
  cases.push(
    makeCorpusCase("manifest-bom", [
      { ...base[0], bytes: Buffer.concat([Buffer.from([239, 187, 191]), base[0].bytes]) },
      base[1],
    ]),
  );
  cases.push(
    makeCorpusCase(
      "spec-sha-mismatch",
      [base[0], { name: "spec.json", bytes: Buffer.from("{}") }],
      "spec_sha_mismatch",
      "spec.json",
    ),
  );
  for (const [name, spec] of [
    ["spec-not-json", "{"],
    ["spec-duplicate-key", '{"id":"a","id":"b"}'],
    ["spec-depth", "[".repeat(65) + "0" + "]".repeat(65)],
  ]) {
    cases.push(
      makeCorpusCase(name, fixtureEntries(Buffer.from(spec)), "spec_invalid_json", "spec.json"),
    );
  }
  cases.push(
    makeCorpusCase(
      "spec-invalid-schema",
      fixtureEntries(Buffer.from("{}")),
      "spec_invalid",
      "spec.json",
    ),
  );
  cases.push(
    makeCorpusCase(
      "spec-bom",
      fixtureEntries(Buffer.concat([Buffer.from([239, 187, 191]), minimalSpec])),
    ),
  );
  cases.push(
    makeCorpusCase(
      "spec-invalid-utf8",
      fixtureEntries(Buffer.from([255])),
      "spec_invalid_json",
      "spec.json",
    ),
  );
  return cases;
}
export function assetCases(): BundleCorpusCase[] {
  const image = assetRecord("image", "image/png");
  const font = assetRecord("font", "font/ttf");
  const withImage = referencedSpec(["image"]);
  const cases: BundleCorpusCase[] = [
    makeCorpusCase("missing-image", fixtureEntries(withImage), "asset_missing", "image"),
    makeCorpusCase(
      "missing-font",
      fixtureEntries(referencedSpec([], ["font"])),
      "font_missing",
      "font",
    ),
    makeCorpusCase(
      "manifest-without-zip",
      fixtureEntries(withImage, [image]).slice(0, 2),
      "manifest_entry_missing",
      image.entry.name,
    ),
    makeCorpusCase(
      "zip-without-manifest",
      [...fixtureEntries(), image.entry],
      "manifest_entry_missing",
      image.entry.name,
    ),
    makeCorpusCase(
      "listed-unreferenced",
      fixtureEntries(minimalSpec, [image]),
      "unreferenced_asset",
      "image",
    ),
  ];
  const wrongSha = {
    manifest: { ...image.manifest, file: `assets/${"0".repeat(64)}.png`, sha256: "0".repeat(64) },
    entry: { ...image.entry, name: `assets/${"0".repeat(64)}.png` },
  };
  cases.push(
    makeCorpusCase(
      "wrong-sha-stem",
      fixtureEntries(withImage, [wrongSha]),
      "sha256_mismatch",
      wrongSha.entry.name,
    ),
  );
  const wrongType = assetRecord("image", "image/png", tinyAsset("image/jpeg"));
  cases.push(
    makeCorpusCase(
      "wrong-media-magic",
      fixtureEntries(withImage, [wrongType]),
      "asset_type_mismatch",
      wrongType.entry.name,
    ),
  );
  const badFont = assetRecord("font", "font/ttf", tinyAsset("font/otf"));
  cases.push(
    makeCorpusCase(
      "wrong-font-tag",
      fixtureEntries(referencedSpec([], ["font"]), [], [badFont]),
      "asset_type_mismatch",
      badFont.entry.name,
    ),
  );
  const badPath = { ...image, manifest: { ...image.manifest, file: font.entry.name } };
  cases.push(
    makeCorpusCase(
      "manifest-file-mismatch",
      fixtureEntries(withImage, [badPath]),
      "manifest_invalid",
      font.entry.name,
    ),
  );
  const badId = { ...image, manifest: { ...image.manifest, id: "" } };
  cases.push(
    makeCorpusCase(
      "manifest-empty-id",
      fixtureEntries(withImage, [badId]),
      "manifest_invalid",
      "bundle.json",
    ),
  );
  cases.push(
    makeCorpusCase(
      "manifest-duplicate-id",
      fixtureEntries(withImage, [image, image]),
      "duplicate_entry",
      image.entry.name,
    ),
  );
  const duplicateIdEntries = fixtureEntries(
    withImage,
    [image],
    [{ ...font, manifest: { ...font.manifest, id: "image" } }],
  );
  cases.push(
    makeCorpusCase(
      "manifest-duplicate-id-across-kinds",
      duplicateIdEntries,
      "manifest_invalid",
      "image",
    ),
  );
  return cases;
}
export function boundaryCases(): BundleCorpusCase[] {
  const cases: BundleCorpusCase[] = [];
  for (const [type, cap] of [
    ["image/png", MAX_PROTOTYPE_ASSET_BYTES],
    ["font/ttf", MAX_PROTOTYPE_FONT_ASSET_BYTES],
  ] as const) {
    for (const delta of [0, 1]) {
      const bytes = delta
        ? zeroBoundaryBytes(cap + delta, tinyAsset(type))
        : boundaryBytes(cap, tinyAsset(type));
      bytes.set(tinyAsset(type));
      const font = type === "font/ttf";
      const asset = assetRecord("boundary", type, bytes);
      const spec = referencedSpec(font ? [] : ["boundary"], font ? ["boundary"] : []);
      const entries = fixtureEntries(spec, font ? [] : [asset], font ? [asset] : []).map(
        (entry) => ({ ...entry, method: 8 }),
      );
      cases.push(
        makeCorpusCase(
          `${font ? "font" : "image"}-cap${delta ? "-plus-one" : "-exact"}`,
          entries,
          delta ? "entry_too_large" : undefined,
          delta ? asset.entry.name : undefined,
        ),
      );
    }
  }
  // Whitespace is semantically inert JSON padding. A high-entropy unknown request-independent
  // string would violate the spec schema, so use legal text data to control compression ratio.
  for (const delta of [0, 1]) {
    const entropy = boundaryBytes(800000, Buffer.alloc(0)).subarray(0, 12500).toString("hex");
    const prefix = minimalSpec.toString().replace('"Hello"', JSON.stringify(entropy));
    const spec = Buffer.from(
      prefix + " ".repeat(BUNDLE_MAX_SPEC_BYTES + delta - Buffer.byteLength(prefix)),
    );
    cases.push(
      makeCorpusCase(
        `spec-cap${delta ? "-plus-one" : "-exact"}`,
        fixtureEntries(spec).map((entry) => ({ ...entry, method: 8 })),
        delta ? "entry_too_large" : undefined,
        delta ? "spec.json" : undefined,
      ),
    );
  }
  for (const delta of [0, 1]) {
    const base = fixtureEntries();
    const text = Buffer.from(base[0].bytes).toString();
    // Ratio slack from a valid stored spec protects the manifest padding boundary from ratio errors.
    const spec = Buffer.from(minimalSpec.toString() + " ".repeat(1000));
    const entries = fixtureEntries(spec);
    entries[0] = {
      name: "bundle.json",
      bytes: Buffer.from(
        Buffer.from(entries[0].bytes).toString() +
          " ".repeat(BUNDLE_MAX_MANIFEST_BYTES + delta - text.length),
      ),
      method: 8,
    };
    cases.push(
      makeCorpusCase(
        `manifest-cap${delta ? "-plus-one" : "-exact"}`,
        entries,
        delta ? "entry_too_large" : undefined,
        delta ? "bundle.json" : undefined,
      ),
    );
  }
  const bomb = {
    name: `assets/${"0".repeat(64)}.png`,
    bytes: zeroBoundaryBytes(20 * 1024 * 1024, Buffer.alloc(0)),
    expanded: 0,
    method: 8,
  };
  cases.push(
    makeCorpusCase("bomb-20m-ratio", [...fixtureEntries(), bomb], "ratio_exceeded", bomb.name),
  );
  const padding = boundaryBytes(210000, tinyAsset("image/png"));
  // STORED preceding bytes provide >20 MiB ratio allowance; the per-entry cap still stops inflation.
  cases.push(
    makeCorpusCase(
      "bomb-20m-below-ratio",
      [...fixtureEntries(), { name: `assets/${bundleSha256(padding)}.png`, bytes: padding }, bomb],
      "entry_too_large",
      bomb.name,
    ),
  );
  return cases;
}
