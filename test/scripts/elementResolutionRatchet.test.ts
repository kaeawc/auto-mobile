import { expect, test } from "bun:test";
import { assertRatchetDoesNotGrow } from "../../scripts/check-element-resolution-ratchet";

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
