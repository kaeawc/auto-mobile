import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import corpus from "../../test/fixtures/prototype-bundle/corpus.json";
import { readPrototypeBundle } from "../../src/features/prototype/prototypeBundle";
import { type FuzzFamily, fuzzBundle, fuzzRng } from "./bundleFuzz";

/**
 * Shared differential fuzz corpus (#14159). Seeded mutations of the #13616 corpus plus generated
 * hostile ZIP structure and JSON; TS records its verdict and Kotlin/Swift must reproduce the
 * accept/reject decision and error code. Regenerate with:
 *   bun scripts/prototype/generate-bundle-fuzz-corpus.ts --write
 */
export const FUZZ_CORPUS_SEED = 14159;
const FAMILIES: readonly FuzzFamily[] = ["bytes", "structural", "json"];
const PER_FAMILY = 120;
const MAX_SEED_BASE64 = 3000;

export interface FuzzCorpusCase {
  name: string;
  family: FuzzFamily;
  bundleBase64: string;
  expect: "accept" | "reject";
  code?: string;
  path?: string;
}

export function generateBundleFuzzCorpus() {
  const seeds = corpus.cases
    .filter((entry) => entry.bundleBase64.length <= MAX_SEED_BASE64)
    .map((entry) => Buffer.from(entry.bundleBase64, "base64"));
  const seen = new Set<string>();
  const cases: FuzzCorpusCase[] = [];
  for (const family of FAMILIES) {
    const rng = fuzzRng(FUZZ_CORPUS_SEED + FAMILIES.indexOf(family));
    for (let made = 0, attempts = 0; made < PER_FAMILY && attempts < PER_FAMILY * 20; attempts++) {
      const bytes = fuzzBundle(family, rng, seeds);
      const base64 = bytes.toString("base64");
      if (base64.length > MAX_SEED_BASE64 * 2 || seen.has(base64)) {
        continue;
      }
      seen.add(base64);
      const result = readPrototypeBundle(bytes);
      cases.push({
        name: `${family}-${String(made++).padStart(3, "0")}`,
        family,
        bundleBase64: base64,
        ...(result.ok
          ? { expect: "accept" as const }
          : {
              expect: "reject" as const,
              code: result.code,
              ...(result.path === undefined ? {} : { path: result.path }),
            }),
      });
    }
  }
  return { seed: FUZZ_CORPUS_SEED, cases };
}
export function serializeBundleFuzzCorpus(): string {
  return JSON.stringify(generateBundleFuzzCorpus(), null, 2) + "\n";
}
if (import.meta.main) {
  if (!process.argv.includes("--write")) {
    throw new Error("Usage: bun scripts/prototype/generate-bundle-fuzz-corpus.ts --write");
  }
  writeFileSync(
    resolve(import.meta.dir, "../../test/fixtures/prototype-bundle/fuzz-corpus.json"),
    serializeBundleFuzzCorpus(),
  );
}
