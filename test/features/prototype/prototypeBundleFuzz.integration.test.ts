import { expect, test } from "bun:test";
import {
  BUNDLE_ERROR_CODES,
  BUNDLE_MAX_EXPANDED_BYTES,
  readPrototypeBundle,
} from "../../../src/features/prototype/prototypeBundle";
import {
  bombBundle,
  type FuzzFamily,
  fuzzBundle,
  fuzzRng,
} from "../../../scripts/prototype/bundleFuzz";
import { serializeBundleFuzzCorpus } from "../../../scripts/prototype/generate-bundle-fuzz-corpus";
import fuzzCorpusText from "../../fixtures/prototype-bundle/fuzz-corpus.json" with { type: "text" };
import { bundleCorpus, corpusBytes } from "./prototypeBundleCorpus";

// Heavier corpora than the 100 ms unit budget allows (#14159). Same seeded generators as the
// property tests and the checked-in cross-platform corpus; classified safe in
// test/integration-safe-tier.txt (pure functions, no I/O).
const CODES = new Set<string>(BUNDLE_ERROR_CODES);
const seeds = bundleCorpus()
  .cases.filter((entry) => entry.bundleBase64.length <= 3000)
  .map((entry) => corpusBytes(entry));

test("regenerating the fuzz corpus matches the checked-in text", () => {
  expect<unknown>(serializeBundleFuzzCorpus()).toBe(fuzzCorpusText);
});

for (const family of ["bytes", "structural", "json"] as FuzzFamily[]) {
  test(`${family}: 4000 seeded inputs are typed verdicts within a per-input time bound`, () => {
    const rng = fuzzRng(0x14159 + family.length);
    let slowest = 0;
    for (let i = 0; i < 4000; i++) {
      const bytes = fuzzBundle(family, rng, seeds);
      const started = performance.now();
      const result = readPrototypeBundle(bytes);
      slowest = Math.max(slowest, performance.now() - started);
      expect(result.ok || CODES.has(result.code)).toBe(true);
    }
    expect(slowest).toBeLessThan(500);
  });
}

test("a bomb at the expanded cap plus one is rejected without unbounded allocation", () => {
  const before = process.memoryUsage().rss;
  const result = readPrototypeBundle(bombBundle(BUNDLE_MAX_EXPANDED_BYTES + 1));
  expect(result.ok).toBe(false);
  expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
});

test("many cap-sized bomb entries are rejected by entry, expanded or ratio caps", () => {
  const result = readPrototypeBundle(bombBundle(1_048_576, 30));
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(["ratio_exceeded", "expanded_too_large", "entry_not_allowed"]).toContain(result.code);
  }
});
