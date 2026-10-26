import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  BUNDLE_ERROR_CODES,
  BUNDLE_MAX_EXPANDED_BYTES,
  exportPrototypeBundle,
  readPrototypeBundle,
} from "../../../src/features/prototype/prototypeBundle";
import { parseBundleJson } from "../../../src/features/prototype/bundle/bundleJson";
import { BundleFailure } from "../../../src/features/prototype/bundle/bundleContract";
import {
  bombBundle,
  fuzzBundle,
  fuzzRng,
  hostileJsonText,
  mutateBytes,
} from "../../../scripts/prototype/bundleFuzz";
import type { FuzzCorpusCase } from "../../../scripts/prototype/generate-bundle-fuzz-corpus";
import fuzzCorpus from "../../fixtures/prototype-bundle/fuzz-corpus.json";
import { bundleCorpus, corpusBytes } from "./prototypeBundleCorpus";

// Pinned seed (see test/utils/Backoff.property.test.ts): failures reproduce exactly. The 100 ms
// unit budget keeps run counts small; the integration sweep runs the same properties wider.
const RUN = { seed: 14_159, numRuns: 60 } as const;
const CODES = new Set<string>(BUNDLE_ERROR_CODES);
const seeds = bundleCorpus()
  .cases.filter((entry) => entry.bundleBase64.length <= 3000)
  .map((entry) => corpusBytes(entry));

function verdictOf(bytes: Uint8Array): string {
  const result = readPrototypeBundle(bytes);
  return result.ok ? "accept" : `${result.code}:${result.path ?? ""}`;
}
function typedVerdict(bytes: Uint8Array): boolean {
  const result = readPrototypeBundle(bytes);
  return result.ok || CODES.has(result.code);
}

describe("bundle import fuzz (property-based)", () => {
  test("shared fuzz corpus verdicts reproduce on the TS reader", () => {
    const mismatches = (fuzzCorpus.cases as FuzzCorpusCase[])
      .filter((entry) => {
        const expected = entry.expect === "accept" ? "accept" : `${entry.code}:${entry.path ?? ""}`;
        return verdictOf(Buffer.from(entry.bundleBase64, "base64")) !== expected;
      })
      .map((entry) => entry.name);
    expect(mismatches).toEqual([]);
  });

  test("arbitrary bytes are a typed verdict and never throw", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (data) => typedVerdict(data)),
      RUN,
    );
  });

  test("arbitrary bytes behind a ZIP signature never throw", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (data) =>
        typedVerdict(Buffer.concat([Buffer.from("PK\u0003\u0004"), data])),
      ),
      RUN,
    );
  });

  test("seeded mutations of valid and hostile corpus bundles are typed verdicts", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0x7fffffff }), (seed) =>
        typedVerdict(mutateBytes(fuzzRng(seed), fuzzRng(seed).pick(seeds))),
      ),
      RUN,
    );
  });

  test("generated ZIP structure and JSON families are typed verdicts", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0x7fffffff }),
        fc.constantFrom("structural", "json"),
        (seed, family) => typedVerdict(fuzzBundle(family, fuzzRng(seed), seeds)),
      ),
      RUN,
    );
  });

  test("a verdict is deterministic for identical bytes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0x7fffffff }), (seed) => {
        const bytes = mutateBytes(fuzzRng(seed), fuzzRng(seed ^ 5).pick(seeds));
        return verdictOf(bytes) === verdictOf(Buffer.from(bytes));
      }),
      RUN,
    );
  });

  test("an accepted bundle re-exports to a canonical bundle that imports identically", () => {
    const accepted = (fuzzCorpus.cases as FuzzCorpusCase[]).filter(
      (entry) => entry.expect === "accept",
    );
    expect(accepted.length).toBeGreaterThan(0);
    for (const entry of accepted) {
      const first = readPrototypeBundle(Buffer.from(entry.bundleBase64, "base64"));
      expect(first.ok).toBe(true);
      if (!first.ok) {
        continue;
      }
      const exported = exportPrototypeBundle({
        specBytes: first.bundle.spec,
        assets: (id) => first.bundle.assets.get(id),
        fonts: (id) => first.bundle.fonts.get(id),
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) {
        continue;
      }
      const second = readPrototypeBundle(exported.bytes);
      expect(second).toEqual(first);
    }
  });
});

describe("bundle zip bombs", () => {
  test.each([1_048_576 + 1, 2_000_000, 17_000_000])(
    "a %i byte zero-filled spec.json is rejected by a size or ratio cap",
    (size) => {
      const result = readPrototypeBundle(bombBundle(size));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(["entry_too_large", "ratio_exceeded", "expanded_too_large"]).toContain(result.code);
      }
    },
  );

  test("many bomb entries cannot exceed the entry or expanded budget", () => {
    const result = readPrototypeBundle(bombBundle(65_536, 40));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["too_many_entries", "ratio_exceeded", "expanded_too_large"]).toContain(result.code);
    }
    expect(BUNDLE_MAX_EXPANDED_BYTES).toBeGreaterThan(65_536);
  });
});

describe("bundle JSON parsing (property-based)", () => {
  const verdict = (bytes: Uint8Array): "ok" | "rejected" => {
    try {
      parseBundleJson(bytes, "manifest_invalid", "bundle.json");
      return "ok";
    } catch (error) {
      if (error instanceof BundleFailure) {
        return "rejected";
      }
      throw error;
    }
  };

  test("arbitrary bytes either parse or raise a BundleFailure", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (data) => verdict(data) !== undefined),
      RUN,
    );
  });

  test("arbitrary text either parses or raises a BundleFailure", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 120 }),
        (text) => verdict(Buffer.from(text)) !== undefined,
      ),
      RUN,
    );
  });

  test("hostile JSON catalogue never raises anything but BundleFailure", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0x7fffffff }),
        (seed) => verdict(hostileJsonText(fuzzRng(seed))) !== undefined,
      ),
      { seed: RUN.seed, numRuns: 100 },
    );
  });

  test("nesting is accepted through 64 levels below a leaf and rejected beyond", () => {
    // The shared contract measures the depth of every value, leaves included. An empty innermost
    // container is itself a value at the container's depth, so `[]` x65 is the one accepted
    // exception; all three ports agree on it (see the spec-depth corpus case).
    const nest = (depth: number) => Buffer.from(`${"[".repeat(depth)}0${"]".repeat(depth)}`);
    expect(verdict(nest(64))).toBe("ok");
    expect(verdict(nest(65))).toBe("rejected");
    expect(verdict(nest(20_000))).toBe("rejected");
  });

  test("a duplicate key is rejected at any depth, even through escapes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.stringMatching(/^[a-z]{1,4}$/),
        (depth, key) => {
          const escaped = [...key].map((c) => `\\u00${c.charCodeAt(0).toString(16)}`).join("");
          const inner = `{"${key}":1,"${escaped}":2}`;
          const text = "[".repeat(depth) + inner + "]".repeat(depth);
          return verdict(Buffer.from(text)) === "rejected";
        },
      ),
      RUN,
    );
  });

  test("invalid UTF-8 is rejected, one BOM is stripped and two are not", () => {
    expect(verdict(Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))).toBe("rejected");
    expect(verdict(Buffer.from([0xc0, 0xaf]))).toBe("rejected");
    expect(verdict(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]))).toBe("ok");
    expect(
      verdict(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from("{}")]),
      ),
    ).toBe("rejected");
  });
});
