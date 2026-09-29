import { expect, test } from "bun:test";
import { toJSONSchema } from "zod/v4";
import { keyboardResultSchema, sendKeysResultSchema } from "../../src/server/toolOutputSchemas";

test("keyboard and sendKeys advertise their IME result fields", () => {
  const keyboard = toJSONSchema(keyboardResultSchema);
  const sendKeys = toJSONSchema(sendKeysResultSchema);
  expect(keyboard.properties).toHaveProperty("installed");
  expect(keyboard.properties).toHaveProperty("backend");
  expect(keyboard.properties).toHaveProperty("capability");
  expect(keyboard.properties).toHaveProperty("keyboard");
  expect(sendKeys.properties).toHaveProperty("commands");
});

test("IME output schemas allow absent identity details and reject incorrect backends", () => {
  expect(
    keyboardResultSchema.safeParse({
      activeImeId: null,
      installed: [
        {
          id: "com.example/.Ime",
          active: false,
          enabled: true,
          capabilities: {
            visibleKeyTap: true,
            gesture: false,
            suggestion: false,
            clipboard: false,
            semanticText: false,
          },
        },
      ],
    }).success,
  ).toBe(true);
  expect(
    keyboardResultSchema.safeParse({
      backend: "installedIme",
      capability: "visibleKeyTap",
      keyboard: { component: "com.example/.Ime", package: "com.example" },
    }).success,
  ).toBe(true);
  expect(
    sendKeysResultSchema.safeParse({
      commands: [
        {
          backend: "autoMobileIme",
          capability: "semanticText",
          keyboard: { component: "dev.example/.Ime", package: "dev.example" },
        },
      ],
    }).success,
  ).toBe(true);
  expect(sendKeysResultSchema.safeParse({ commands: [{ backend: "installedIme" }] }).success).toBe(
    false,
  );
});
