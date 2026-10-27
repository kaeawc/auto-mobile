import { describe, expect, test } from "bun:test";

/**
 * The boundary harness every tier's hasher is run through (#11975).
 *
 * - Differential tests (the lower bound): change one real input at a time and assert the hash
 *   changes. A mutation that leaves it unchanged is a false-hit bug.
 * - Stability tests (the upper bound): change things that must not matter and assert the hash is
 *   identical. Drift here is leaky canonicalization and a collapsed hit rate.
 */
export interface HashHarness<I> {
  /** A fresh, valid input; the harness mutates copies, never the base. */
  base(): I;
  hash(input: I): Promise<string> | string;
  /** Each entry changes exactly one real input. */
  mutations: Record<string, (input: I) => I>;
  /** Each entry changes something that must not matter. */
  perturbations: Record<string, (input: I) => I>;
}

export function describeHashBoundary<I>(name: string, harness: HashHarness<I>): void {
  describe(`${name}: hash boundary`, () => {
    test("the base input hashes the same twice", async () => {
      expect(await harness.hash(harness.base())).toBe(await harness.hash(harness.base()));
    });

    describe("differential: a changed input changes the hash", () => {
      for (const [mutation, apply] of Object.entries(harness.mutations)) {
        test(mutation, async () => {
          const before = await harness.hash(harness.base());
          const after = await harness.hash(apply(harness.base()));
          expect(after).not.toBe(before);
        });
      }
    });

    describe("stability: a change that must not matter leaves the hash alone", () => {
      for (const [perturbation, apply] of Object.entries(harness.perturbations)) {
        test(perturbation, async () => {
          const before = await harness.hash(harness.base());
          const after = await harness.hash(apply(harness.base()));
          expect(after).toBe(before);
        });
      }
    });

    test("no mutation collides with another", async () => {
      const hashes = new Map<string, string>();
      hashes.set("base", await harness.hash(harness.base()));
      for (const [mutation, apply] of Object.entries(harness.mutations)) {
        hashes.set(mutation, await harness.hash(apply(harness.base())));
      }
      expect(new Set(hashes.values()).size).toBe(hashes.size);
    });
  });
}
