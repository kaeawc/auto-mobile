import { describe, expect, test } from "bun:test";
import formats from "../../fixtures/prototype-spec/checks/format-parity.json";
import patterns from "../../fixtures/prototype-spec/checks/pattern-parity.json";
import rejected from "../../fixtures/prototype-spec/checks/pattern-rejected.json";
import evaluations from "../../fixtures/prototype-spec/checks/evaluate.json";
import {
  evaluateChecks,
  MAX_PROTOTYPE_CHECK_VALUE_LENGTH,
} from "../../../src/features/prototype/prototypeChecks";
import {
  parseCheckPattern,
  matchesCheckPattern,
} from "../../../src/features/prototype/prototypeCheckPattern";
import { prototypeCheckSchema } from "../../../src/features/prototype/prototypeSpec";
import { bindNodeFields } from "../../../src/features/prototype/prototypeTemplate";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

describe("language-neutral check fixtures", () => {
  for (const [index, fixture] of formats.entries()) {
    test(`format ${index}: ${fixture.format}`, () => {
      const check = prototypeCheckSchema.parse({ format: fixture.format, message: "Format" });
      expect(evaluateChecks(fixture.value, [check], "textField").valid).toBe(fixture.matches);
    });
  }
  for (const [index, fixture] of patterns.entries()) {
    test(`pattern ${index}: ${fixture.pattern}`, () => {
      expect(parseCheckPattern(fixture.pattern)).toEqual({ ok: true });
      expect(matchesCheckPattern(fixture.pattern, fixture.value)).toBe(fixture.matches);
    });
  }
  for (const [index, fixture] of rejected.entries()) {
    test(`reject pattern ${index}: ${fixture.pattern}`, () => {
      const parsed = parseCheckPattern(fixture.pattern);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) {
        throw new Error("Accepted rejected pattern");
      }
      for (const substring of fixture.messageSubstrings) {
        expect(parsed.message).toContain(substring);
      }
      expect(matchesCheckPattern(fixture.pattern, "a")).toBe(false);
    });
  }
  for (const [index, fixture] of evaluations.entries()) {
    test(`evaluate ${index}: ${fixture.nodeType}`, () => {
      expect(
        evaluateChecks(
          fixture.value,
          fixture.checks.map((check) => prototypeCheckSchema.parse(check)),
          fixture.nodeType,
        ),
      ).toEqual(fixture.expected);
    });
  }
});
test("matching is capped while length checks inspect the full value", () => {
  const value = "a".repeat(MAX_PROTOTYPE_CHECK_VALUE_LENGTH) + "!";
  expect(evaluateChecks(value, [{ pattern: "a+", message: "Bad" }], "textField")).toEqual({
    valid: true,
  });
  expect(
    evaluateChecks(
      value,
      [{ maxLength: MAX_PROTOTYPE_CHECK_VALUE_LENGTH, message: "Bad" }],
      "textField",
    ),
  ).toEqual({ valid: false, firstFailingMessage: "Bad" });
});
test("repeat and component bind validity keys, guards, and error messages, leaving patterns literal", () => {
  const input = {
    type: "textField",
    stateKey: "v_{item.id}",
    checks: [
      { required: true, message: "Enter {item.label}" },
      { pattern: "a{2}", message: "Bad" },
    ],
    enabledWhen: { all: [{ valid: ["v_{item.id}"] }] },
    onTap: [{ type: "emit", name: "save", requireValid: ["v_{item.id}"] }],
  };
  const output = bindNodeFields(input, "root", {
    binding: { alias: "item", index: true },
    values: { id: 7, label: "name" },
  });
  expect(output).toMatchObject({
    stateKey: "v_7",
    checks: [
      { required: true, message: "Enter name" },
      { pattern: "a{2}", message: "Bad" },
    ],
    enabledWhen: { all: [{ valid: ["v_7"] }] },
    onTap: [{ type: "emit", requireValid: ["v_7"] }],
  });
  expect(
    validatePrototypeSpec({
      id: "repeat",
      window: { placement: { type: "fullscreen" } },
      state: { v_7: "" },
      root: {
        type: "column",
        repeat: { items: [{ id: 7, label: "name" }], as: "item" },
        children: [input],
      },
    }),
  ).toMatchObject({ success: true });
});
