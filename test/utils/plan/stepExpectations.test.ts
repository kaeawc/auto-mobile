import { describe, expect, test } from "bun:test";
import {
  describeExpectation,
  expectationFailureMessage,
  expectationQuery,
} from "../../../src/utils/plan/stepExpectations";

describe("expectationQuery (#16817)", () => {
  test.each([
    [{ type: "elementVisible", selector: { testTag: "a" } }, { testTag: "a" }],
    [
      { type: "elementVisible", selector: { resourceId: "a", text: "Go" } },
      { elementId: "a", text: "Go" },
    ],
    [
      { type: "elementAbsent", selector: { className: "Spinner" }, timeoutMs: 0 },
      { absent: { className: "Spinner" }, timeout: 0 },
    ],
    [
      { type: "textEquals", selector: { elementId: "n" }, text: "3" },
      { elementId: "n", text: "3", textMatch: "exact", textSource: "displayed" },
    ],
    [
      { type: "textContains", text: "Hi" },
      { text: "Hi", textMatch: "contains", textSource: "displayed" },
    ],
  ])("%j becomes observe.waitFor %j", (expectation, waitFor) => {
    expect(expectationQuery(expectation)).toMatchObject({ kind: "evaluate", waitFor });
  });

  test.each([
    [{ type: "elementVisible" }, "elementVisible requires a selector"],
    [
      { type: "elementVisible", selector: { elementId: "a", resourceId: "b" } },
      "two different ids",
    ],
    [{ type: "elementVisible", selector: { xpath: "//a" } }, "selector.xpath is not supported"],
    [
      { type: "elementVisible", selector: { text: "" } },
      "selector.text must be a non-empty string",
    ],
    [{ type: "textEquals", selector: { testTag: "a" } }, "textEquals requires a non-empty `text`"],
    [{ type: "textEquals", selector: { text: "a" }, text: "b" }, "not `selector.text`"],
    [{ type: "elementVisible", selector: { text: "a" }, timeoutMs: -1 }, "timeoutMs"],
    ["elementVisible", "must be an object with a `type`"],
  ])("%j is invalid", (expectation, message) => {
    const query = expectationQuery(expectation);
    expect(query.kind).toBe("invalid");
    expect(query.kind === "invalid" ? query.error : "").toContain(message);
  });

  test("an unknown type is unsupported, not invalid", () => {
    expect(expectationQuery({ type: "hasAccessibilityIssues" })).toEqual({
      kind: "unsupported",
      label: "hasAccessibilityIssues",
      type: "hasAccessibilityIssues",
    });
  });

  test("describeExpectation lists the type, selector and text", () => {
    expect(describeExpectation({ type: "textEquals", selector: { testTag: "n" }, text: "3" })).toBe(
      'textEquals testTag="n" text="3"',
    );
  });

  test("the failure message caps observed texts", () => {
    const texts = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const message = expectationFailureMessage({ index: 0, total: 1, label: "x" }, "nope", {
      visibleTexts: texts,
    });
    expect(message).toContain('"t7"');
    expect(message).not.toContain('"t8"');
  });
});
