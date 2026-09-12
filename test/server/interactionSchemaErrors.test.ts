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
});
