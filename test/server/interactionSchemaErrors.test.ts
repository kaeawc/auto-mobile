import { describe, expect, test } from "bun:test";
import { systemTraySchema, tapOnSchema } from "../../src/server/interactionTools";
import { formatToolParamError } from "../../src/server/toolParamError";

describe("actionable interaction schema errors", () => {
  for (const action of ["find", "tap"]) {
    test.each([
      {},
      { text: "mt sms" },
      { title: "sender" },
      { body: "mt sms" },
      { appId: "com.app" },
    ])(`systemTray ${action} names the notification object for %j`, (criteria) => {
      const input = { action, ...criteria };
      const result = systemTraySchema.safeParse(input);
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("expected invalid criteria");
      }
      expect(formatToolParamError("systemTray", result.error, input)).toContain(
        `${action} requires at least one criterion under 'notification': notification: { title | body | appId }`,
      );
    });
    test.each(["title", "body", "appId"])(`systemTray ${action} accepts notification.%s`, (key) => {
      expect(systemTraySchema.safeParse({ action, notification: { [key]: "value" } }).success).toBe(
        true,
      );
    });
  }

  test.each([{}, { elementId: "com.app:id/button" }])(
    "tapOn missing selector gives its shape for %j",
    (input) => {
      const result = tapOnSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("expected missing selector");
      }
      const message = formatToolParamError("tapOn", result.error, input);
      const hint =
        "selector is required: selector: { elementId | testTag | text | accessibilityLink | textAny }";
      expect(message).toContain(hint);
      expect(message.split(hint)).toHaveLength(2);
    },
  );

  test.each([null, 42, "button"])(
    "tapOn supplied malformed selector remains a type error: %j",
    (selector) => {
      const input = { selector };
      const result = tapOnSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("expected invalid selector");
      }
      const message = formatToolParamError("tapOn", result.error, input);
      expect(message).toContain("selector expected object");
      expect(message).not.toContain("selector is required");
    },
  );

  // #6867: a selector with two or more unknown keys concatenated every union
  // branch's unrecognized-key list, so a key ACCEPTED by one branch was named as
  // unrecognized by the others — in the same sentence that listed it as accepted.
  describe("selector unrecognized keys (#6867)", () => {
    const parseSelector = (selector: unknown) => {
      const input = { selector };
      const result = tapOnSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("expected invalid selector");
      }
      return formatToolParamError("tapOn", result.error, input, tapOnSchema);
    };

    test("a single unknown key is unchanged", () => {
      const message = parseSelector({ foo: "bar" });
      expect(message).toContain('selector Unrecognized key: "foo"');
      expect(message).toContain("Accepted: elementId, testTag, text, accessibilityLink, textAny");
      expect(message.split("Unrecognized")).toHaveLength(2);
    });

    test("a valid key beside a bad key names only the bad key", () => {
      const message = parseSelector({ text: "Clock", bogus: 1 });
      expect(message).toContain('selector Unrecognized key: "bogus"');
      expect(message).not.toContain('"text",');
      expect(message.split("Unrecognized")).toHaveLength(2);
    });

    test("a top-level parameter inside the selector names it and points one level up", () => {
      const message = parseSelector({
        elementId: "com.google.android.deskclock:id/onoff",
        index: 0,
      });
      expect(message).toContain('selector Unrecognized key: "index"');
      expect(message).not.toContain('"elementId",');
      expect(message).toContain('did you mean the top-level "index" parameter?');
      expect(message.split("Unrecognized")).toHaveLength(2);
    });

    test("keys from two different branches are reported as mutually exclusive", () => {
      const message = parseSelector({ text: "a", elementId: "b" });
      expect(message).not.toContain("Unrecognized");
      expect(message).toContain("provide exactly one");
      expect(message).toContain("Accepted: elementId, testTag, text, accessibilityLink, textAny");
    });

    test("the top-level hint is derived from the tool schema, not a fixed list", () => {
      const message = parseSelector({ elementId: "id", preTapStability: true });
      expect(message).toContain('did you mean the top-level "preTapStability" parameter?');
    });

    // PR #6882 review: the held-back conflict clause was dropped whenever ANY
    // other field rendered an error, even an unrelated one — the caller fixed
    // `duration`, retried, and only then learned the selector was still invalid.
    // A conflict is explained only by another issue from the SAME union.
    test("an unrelated field error does not hide the selector conflict", () => {
      const input = { selector: { text: "a", elementId: "b" }, duration: "bad" };
      const result = tapOnSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error("expected invalid input");
      }
      const message = formatToolParamError("tapOn", result.error, input, tapOnSchema);
      expect(message).toContain("duration expected number, received string");
      expect(message).toContain("provide exactly one");
    });

    test("without the schema no top-level hint is invented", () => {
      const input = { selector: { elementId: "id", index: 0 } };
      const result = tapOnSchema.safeParse(input);
      if (result.success) {
        throw new Error("expected invalid selector");
      }
      const message = formatToolParamError("tapOn", result.error, input);
      expect(message).toContain('selector Unrecognized key: "index"');
      expect(message).not.toContain("did you mean");
    });
  });
});
