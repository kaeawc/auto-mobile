import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import contract from "../../schemas/prototype-asset-contract.json";
import {
  BUNDLE_ERROR_CODES,
  BUNDLE_MAX_ENTRIES,
  BUNDLE_MAX_SPEC_BYTES,
  BUNDLE_MAX_MANIFEST_BYTES,
  BUNDLE_MAX_EXPANDED_BYTES,
  BUNDLE_MAX_COMPRESSED_BYTES,
  BUNDLE_MAX_RATIO,
} from "../../src/features/prototype/prototypeBundle";
import {
  structuralCases,
  manifestCases,
  assetCases,
  boundaryCases,
  makeCorpusCase,
} from "./bundleCorpusCases";
import {
  fixtureEntries,
  minimalSpec,
  assetRecord,
  referencedSpec,
  tinyAsset,
  type CorpusExportInputs,
} from "./bundleCorpusFixtures";

function goldenCases() {
  const image = assetRecord("image", "image/png");
  const font = assetRecord("font", "font/ttf");
  const spec = referencedSpec(["image"], ["font"]);
  const minimal = makeCorpusCase("golden-minimal", fixtureEntries());
  minimal.exportInputs = { specBase64: minimalSpec.toString("base64"), assets: [], fonts: [] };
  const media = makeCorpusCase("golden-image-font", fixtureEntries(spec, [image], [font]));
  const inputs: CorpusExportInputs = {
    specBase64: spec.toString("base64"),
    assets: [
      {
        id: "image",
        mediaType: "image/png",
        base64: Buffer.from(image.entry.bytes).toString("base64"),
      },
    ],
    fonts: [
      {
        id: "font",
        mediaType: "font/ttf",
        base64: Buffer.from(font.entry.bytes).toString("base64"),
      },
    ],
  };
  media.exportInputs = inputs;
  const aliases = [assetRecord("a", "image/png"), assetRecord("b", "image/png")];
  const aliasSpec = referencedSpec(["a", "b"]);
  const aliasEntries = fixtureEntries(aliasSpec, aliases).slice(0, 3);
  const alias = makeCorpusCase("golden-content-dedup", aliasEntries);
  alias.exportInputs = {
    specBase64: aliasSpec.toString("base64"),
    assets: aliases.map((a) => ({
      id: a.manifest.id,
      mediaType: a.manifest.mediaType,
      base64: Buffer.from(a.entry.bytes).toString("base64"),
    })),
    fonts: [],
  };
  // UTF-16 code-unit ordering and exact identity are intentional: Swift String's default
  // canonical-equivalence comparison must not collapse the two visually equivalent IDs.
  const unicodeIds = ["e\u0301", "é", "\u{10000}", "\ue000"];
  const unicodeAssets = unicodeIds.map((id) => assetRecord(id, "image/png"));
  const unicodeSpec = referencedSpec([...unicodeIds].reverse());
  const unicode = makeCorpusCase(
    "golden-unicode-opaque-ids",
    fixtureEntries(unicodeSpec, unicodeAssets).slice(0, 3),
  );
  unicode.notes =
    "Opaque IDs compare exactly without Unicode normalization; arrays sort by UTF-16 code units.";
  unicode.exportInputs = {
    specBase64: unicodeSpec.toString("base64"),
    assets: unicodeAssets.map((a) => ({
      id: a.manifest.id,
      mediaType: a.manifest.mediaType,
      base64: Buffer.from(a.entry.bytes).toString("base64"),
    })),
    fonts: [],
  };
  return [minimal, media, alias, unicode];
}
function maximumEntriesCase() {
  const assets = Array.from({ length: 32 }, (_, i) =>
    assetRecord(`image-${String(i).padStart(2, "0")}`, "image/png", tinyAsset("image/png", i)),
  );
  const fonts = [assetRecord("font-a", "font/ttf"), assetRecord("font-b", "font/otf")];
  const spec = referencedSpec(
    assets.map((a) => a.manifest.id),
    fonts.map((a) => a.manifest.id),
  );
  return makeCorpusCase("max-36-entries", fixtureEntries(spec, assets, fonts));
}
export function generateBundleCorpus() {
  const webp = assetRecord("webp", "image/webp");
  const jpeg = assetRecord("jpeg", "image/jpeg");
  return {
    contractLimits: contract.limits,
    caps: {
      entries: BUNDLE_MAX_ENTRIES,
      spec: BUNDLE_MAX_SPEC_BYTES,
      manifest: BUNDLE_MAX_MANIFEST_BYTES,
      expanded: BUNDLE_MAX_EXPANDED_BYTES,
      compressed: BUNDLE_MAX_COMPRESSED_BYTES,
      ratio: BUNDLE_MAX_RATIO,
    },
    errorCodes: BUNDLE_ERROR_CODES,
    cases: [
      ...goldenCases(),
      makeCorpusCase(
        "valid-deflate",
        fixtureEntries().map((entry) => ({ ...entry, method: 8 })),
      ),
      makeCorpusCase(
        "valid-jpeg-webp",
        fixtureEntries(referencedSpec(["jpeg", "webp"]), [jpeg, webp]),
      ),
      maximumEntriesCase(),
      ...structuralCases(),
      ...manifestCases(),
      ...assetCases(),
      ...boundaryCases(),
    ],
  };
}
export function serializeBundleCorpus(): string {
  return JSON.stringify(generateBundleCorpus(), null, 2) + "\n";
}
if (import.meta.main) {
  if (!process.argv.includes("--write")) {
    throw new Error("Usage: bun scripts/prototype/generate-bundle-corpus.ts --write");
  }
  const path = resolve(import.meta.dir, "../../test/fixtures/prototype-bundle/corpus.json");
  const text = serializeBundleCorpus();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(
    `Wrote ${generateBundleCorpus().cases.length} cases (${Buffer.byteLength(text)} bytes) to test/fixtures/prototype-bundle/corpus.json`,
  );
}
