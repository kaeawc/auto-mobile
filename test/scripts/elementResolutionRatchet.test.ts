import { expect, test } from "bun:test";
import {
  assertRatchetDoesNotGrow,
  assertSignatureRatchetDoesNotDrift,
} from "../../scripts/check-element-resolution-ratchet";

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
