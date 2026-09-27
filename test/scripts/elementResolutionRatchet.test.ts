import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertCaseInventoryDoesNotShrink,
  assertRatchetDoesNotGrow,
  assertSignatureRatchetDoesNotDrift,
} from "../../scripts/check-element-resolution-ratchet";

test("case-key ratchet preserves existing obligations while allowing additions", () => {
  expect(() => assertCaseInventoryDoesNotShrink('["a","b","c"]', '["a","b"]')).not.toThrow();
  expect(() => assertCaseInventoryDoesNotShrink('["a","c"]', '["a","b"]')).toThrow(
    "case keys may only grow",
  );
  expect(() => assertCaseInventoryDoesNotShrink('["a","a"]', '["a"]')).toThrow("Duplicate");
  expect(() => assertCaseInventoryDoesNotShrink('["a"]', undefined)).toThrow("reviewed initial");
});

test("allows only removal within the original finding", () => {
  expect(() => assertRatchetDoesNotGrow('{"B1":["a"]}', '{"B1":["a","b"]}')).not.toThrow();
  expect(() => assertRatchetDoesNotGrow('{"B1":["a","new"]}', '{"B1":["a","b"]}')).toThrow(
    "only shrink",
  );
  expect(() => assertRatchetDoesNotGrow('{"B2":["a"]}', '{"B1":["a"]}')).toThrow("only shrink");
  expect(() => assertRatchetDoesNotGrow('{"B1":["a","a"]}', '{"B1":["a"]}')).toThrow("Duplicate");
});
test("bootstrapping rejects unreviewed seeds and malformed baselines", () => {
  expect(() => assertRatchetDoesNotGrow("{}", undefined)).toThrow("reviewed initial");
  expect(() => assertRatchetDoesNotGrow('{"B1":[3]}', "{}")).toThrow("Invalid cases");
});
test("signature ratchet retains outcomes for every surviving gap", () => {
  expect(() =>
    assertSignatureRatchetDoesNotDrift('{"a":"target"}', '{"a":"target","b":null}'),
  ).not.toThrow();
  expect(() => assertSignatureRatchetDoesNotDrift('{"a":"other"}', '{"a":"target"}')).toThrow(
    "only shrink",
  );
  expect(() =>
    assertSignatureRatchetDoesNotDrift('{"a":"target","new":null}', '{"a":"target"}'),
  ).toThrow("only shrink");
});

test("ratchet cannot restore gaps removed from a later baseline", () => {
  const gaps = readFileSync("test/features/element-resolution/observeContractGaps.json", "utf8");
  const signatures = readFileSync(
    "test/features/element-resolution/observeContractGapSignatures.json",
    "utf8",
  );
  const shrunkenGaps = JSON.parse(gaps) as Record<string, string[]>;
  const finding = "F-focus-input" in shrunkenGaps ? "F-focus-input" : Object.keys(shrunkenGaps)[0];
  shrunkenGaps[finding].pop();
  expect(() => assertRatchetDoesNotGrow(gaps, JSON.stringify(shrunkenGaps))).toThrow("only shrink");
  const shrunkenSignatures = JSON.parse(signatures) as Record<string, string | null>;
  const removed = Object.keys(shrunkenSignatures).find((key) => key.includes("focus-input"))!;
  delete shrunkenSignatures[removed];
  expect(() =>
    assertSignatureRatchetDoesNotDrift(signatures, JSON.stringify(shrunkenSignatures)),
  ).toThrow("only shrink");
});
