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

test("case-key ratchet permits only the reviewed IME-covered Comments removal", () => {
  const covered = 'diff/text-input-empty.json:{"kind":"text","value":"Comments"}:84,1795,996,2085';
  expect(() =>
    assertCaseInventoryDoesNotShrink('["other"]', JSON.stringify([covered, "other"])),
  ).not.toThrow();
  expect(() =>
    assertCaseInventoryDoesNotShrink('["other"]', JSON.stringify([covered, "unrelated", "other"])),
  ).toThrow("unrelated");
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
    assertSignatureRatchetDoesNotDrift('{"a":"target"}', '{"a":"target","b":null}', '{"B1":["a"]}'),
  ).not.toThrow();
  expect(() =>
    assertSignatureRatchetDoesNotDrift('{"a":"other"}', '{"a":"target"}', '{"B1":["a"]}'),
  ).toThrow("only shrink");
  expect(() =>
    assertSignatureRatchetDoesNotDrift(
      '{"a":"target","new":null}',
      '{"a":"target"}',
      '{"B1":["a"]}',
    ),
  ).toThrow("only shrink");
});

test("signature removal requires the corresponding exception to be removed", () => {
  expect(() => assertSignatureRatchetDoesNotDrift("{}", '{"a":"target"}', '{"B1":["a"]}')).toThrow(
    "surviving exception",
  );
  expect(() => assertSignatureRatchetDoesNotDrift("{}", '{"a":"target"}', "{}")).not.toThrow();
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
    assertSignatureRatchetDoesNotDrift(signatures, JSON.stringify(shrunkenSignatures), gaps),
  ).toThrow("only shrink");
});
