import { expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeContractPatterns } from "../../../src/features/prototype/prototypeContractPatterns";
import {
  keySchema,
  stateKeySchema,
  pointerSchema,
} from "../../../src/features/prototype/prototypeActionValues";
import { isPrototypeDataPointer } from "../../../src/features/prototype/prototypeData";
import fixture from "../../fixtures/prototype-spec/patterns.json";

test("pattern corpus covers every contract pattern", () => {
  expect(Object.keys(fixture).sort()).toEqual(Object.keys(contract.patterns).sort());
});

for (const name of Object.keys(fixture) as (keyof typeof fixture)[]) {
  for (const verdict of ["accepted", "rejected"] as const) {
    for (const value of fixture[name][verdict]) {
      test(`${name} ${verdict} ${JSON.stringify(value)}`, () => {
        expect(prototypeContractPatterns[name].test(value)).toBe(verdict === "accepted");
        if (name === "stateKey") {
          expect(keySchema.safeParse(value).success).toBe(verdict === "accepted");
        }
        if (name === "boundKey") {
          expect(stateKeySchema.safeParse(value).success).toBe(verdict === "accepted");
        }
        if (name === "pointer") {
          expect(pointerSchema.safeParse(value).success).toBe(verdict === "accepted");
          expect(isPrototypeDataPointer(value)).toBe(verdict === "accepted");
        }
      });
    }
  }
}

test("bound keys reject long invalid route placeholder runs without backtracking", () => {
  const value = "{route.a}".repeat(40) + "-";
  const started = performance.now();
  expect(prototypeContractPatterns.boundKey.test(value)).toBe(false);
  expect(performance.now() - started).toBeLessThan(50);
});
