import corpusJson from "../../fixtures/prototype-bundle/corpus.json";
import type { BundleCorpusCase } from "../../../scripts/prototype/bundleCorpusCases";
import type { BundleExportInput } from "../../../src/features/prototype/prototypeBundle";
import type { CorpusExportInputs } from "../../../scripts/prototype/bundleCorpusFixtures";

export interface BundleCorpus {
  contractLimits: Record<string, number>;
  caps: {
    entries: number;
    spec: number;
    manifest: number;
    expanded: number;
    compressed: number;
    ratio: number;
  };
  errorCodes: string[];
  cases: BundleCorpusCase[];
}
let corpus: BundleCorpus | undefined;
export function bundleCorpus(): BundleCorpus {
  return (corpus ??= corpusJson as BundleCorpus);
}
const decoded = new Map<string, Buffer>();
export function corpusBytes(entry: BundleCorpusCase): Buffer {
  let bytes = decoded.get(entry.name);
  if (!bytes) {
    bytes = Buffer.from(entry.bundleBase64, "base64");
    decoded.set(entry.name, bytes);
  }
  return bytes;
}
export function exportInput(input: CorpusExportInputs): BundleExportInput {
  const lookup =
    (records: CorpusExportInputs["assets"]): BundleExportInput["assets"] =>
    (id) => {
      const asset = records.find((entry) => entry.id === id);
      return asset
        ? { mediaType: asset.mediaType, bytes: Buffer.from(asset.base64, "base64") }
        : undefined;
    };
  return {
    specBytes: Buffer.from(input.specBase64, "base64"),
    assets: lookup(input.assets),
    fonts: lookup(input.fonts),
  };
}
