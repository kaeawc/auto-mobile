import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import {
  assertSendKeysRunnerCompatible,
  registerInteractionTools,
  sendKeysSchema,
  setSendKeysFactory,
  resetSendKeysFactory,
} from "../../src/server/interactionTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { SendKeys } from "../../src/features/action/SendKeys";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";

isolateToolRegistry();

describe("sendKeysSchema", () => {
  const scoped = {
    selector: { elementId: "quantity" },
    container: { elementId: "item_42", container: { elementId: "cart_A", index: 0 } },
    selectionStrategy: "unique",
    commands: [{ action: "type", text: "3" }],
  };
  test("accepts nested field scope and every resolver strategy", () => {
    for (const selectionStrategy of ["first", "random", "unique"]) {
      expect(sendKeysSchema.parse({ ...scoped, selectionStrategy })).toMatchObject({
        container: scoped.container,
        selectionStrategy,
      });
    }
  });
  test("advertises nested scope, strategies, and selector dependencies", () => {
    registerInteractionTools();
    const schema = ToolRegistry.getToolDefinitions().find(
      (tool) => tool.name === "sendKeys",
    )?.inputSchema;
    expect(schema).toMatchObject({
      properties: {
        container: { description: expect.stringContaining("Nested container scope") },
        selectionStrategy: { enum: ["first", "random", "unique"] },
      },
      dependentRequired: { container: ["selector"], selectionStrategy: ["selector"] },
    });
  });
  test("handler forwards scope options and preserves structured focus failure as isError", async () => {
    let handler: Parameters<typeof ToolRegistry.registerDeviceAware>[3] | undefined;
    const registration = spyOn(ToolRegistry, "registerDeviceAware").mockImplementation(
      (...args) => {
        if (args[0] === "sendKeys") {
          handler = args[3];
        }
      },
    );
    const capability = spyOn(
      AndroidCtrlProxyClient.prototype,
      "getSupportedCommands",
    ).mockResolvedValue(["request_insert_text"]);
    const calls: Parameters<SendKeys["execute"]>[] = [];
    const error =
      "Container level 2 ambiguous: item_42; Candidates: resourceId=item_42 text=item_42 bounds=[0,0,100,20]";
    setSendKeysFactory(() => ({
      execute: async (...args) => {
        calls.push(args);
        return { success: false, completedCommands: 0, failedIndex: 0, commands: [], error };
      },
    }));
    try {
      registerInteractionTools();
      expect(handler).toBeDefined();
      const args = sendKeysSchema.parse({ ...scoped, display: "external" });
      const response = await handler!(
        { deviceId: "fake-handler-scope", name: "Field", platform: "android" },
        args,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toEqual(scoped.selector);
      expect(calls[0][4]).toBe("external");
      expect(calls[0][5]).toEqual({ container: scoped.container, selectionStrategy: "unique" });
      expect(response).toMatchObject({
        isError: true,
        content: [expect.objectContaining({ text: expect.stringContaining(error) })],
      });
    } finally {
      resetSendKeysFactory();
      capability.mockRestore();
      registration.mockRestore();
    }
  });
  test.each(["container", "selectionStrategy"] as const)(
    "%s requires a field selector",
    (field) => {
      const parsed = sendKeysSchema.safeParse({
        commands: scoped.commands,
        [field]: scoped[field],
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues).toContainEqual(
          expect.objectContaining({
            path: [field],
            message: `${field} requires a selector naming the field to focus`,
          }),
        );
      }
    },
  );
  test.each([
    {},
    { elementId: "" },
    { text: "   " },
    { elementId: "item_42", unknown: true },
    { elementId: "item_42", container: {} },
    { elementId: "item_42", container: { text: "Cart", sibling: true } },
    { elementId: "item_42", index: -1 },
    { elementId: "item_42", index: 0.5 },
  ])("rejects malformed or unsupported recursive scopes: %j", (container) => {
    expect(sendKeysSchema.safeParse({ ...scoped, container }).success).toBe(false);
  });
  test("rejects unknown strategy, leaf index, sibling, and accessibility link", () => {
    for (const extra of [
      { selectionStrategy: "last" },
      { index: 0 },
      { selector: { sibling: true } },
      { selector: { accessibilityLink: "Terms" } },
    ]) {
      expect(sendKeysSchema.safeParse({ ...scoped, ...extra }).success).toBe(false);
    }
  });
  test("accepts device, session, and bound-session targeting without a platform", () => {
    for (const target of [{ deviceId: "emulator-5554" }, { sessionUuid: "session-1" }, {}]) {
      const parsed = sendKeysSchema.parse({
        ...target,
        commands: [{ action: "type", text: "Bluetooth" }],
      });
      expect(parsed.platform).toBeUndefined();
      expect(parsed).toMatchObject(target);
    }
  });

  test("accepts mixed commands and applies type defaults", () => {
    const parsed = sendKeysSchema.parse({
      platform: "android",
      selector: { elementId: "com.example:id/name" },
      commands: [
        { action: "type", text: "Ada" },
        { action: "key", key: "tab", modifiers: ["shift"] },
        { action: "key", key: "next", modifiers: ["meta"] },
        { action: "clear" },
      ],
    });

    expect(parsed.commands[0]).toEqual({
      action: "type",
      text: "Ada",
      operation: "insert",
      mode: "auto",
    });
  });

  test("accepts keyboard profiles only with automatic or IME delivery", () => {
    registerInteractionTools();
    for (const mode of [undefined, "auto", "ime"]) {
      expect(
        sendKeysSchema.safeParse({
          platform: "android",
          commands: [
            { action: "type", text: "value", ...(mode ? { mode } : {}), keyboardProfile: "gboard" },
          ],
        }).success,
      ).toBe(true);
    }
    expect(
      sendKeysSchema.safeParse({
        platform: "android",
        commands: [{ action: "type", text: "value", mode: "a11y", keyboardProfile: "gboard" }],
      }).success,
    ).toBe(false);
    expect(
      sendKeysSchema.safeParse({
        platform: "android",
        commands: [{ action: "type", text: "value", keyboardProfile: "unknown" }],
      }).success,
    ).toBe(false);

    const sendKeysTool = ToolRegistry.getToolDefinitions().find((tool) => tool.name === "sendKeys");
    expect(sendKeysTool).toBeDefined();
    const inputSchema = sendKeysTool!.inputSchema as {
      properties: {
        commands: {
          items: {
            anyOf: Array<{
              properties?: { action?: { const?: string } };
              dependentSchemas?: {
                keyboardProfile?: { properties?: { mode?: { enum?: string[] } } };
              };
            }>;
          };
        };
      };
    };
    const typeCommand = inputSchema.properties.commands.items.anyOf.find(
      (branch) => branch.properties?.action?.const === "type",
    );
    const modeValues = typeCommand?.dependentSchemas?.keyboardProfile?.properties?.mode?.enum;
    expect(modeValues).toEqual(expect.arrayContaining(["auto", "ime"]));
    expect(modeValues).toHaveLength(2);
  });

  test("accepts an optional auto, ime or a11y clear mode and leaves it unset by default", () => {
    for (const mode of ["auto", "ime", "a11y"]) {
      expect(
        sendKeysSchema.parse({ platform: "android", commands: [{ action: "clear", mode }] })
          .commands[0],
      ).toEqual({ action: "clear", mode });
    }
    expect(
      sendKeysSchema.parse({ platform: "android", commands: [{ action: "clear" }] }).commands[0],
    ).toEqual({ action: "clear" });
    for (const mode of ["eventAll", "imeKeyEvents", "unknown"]) {
      expect(
        sendKeysSchema.safeParse({ platform: "android", commands: [{ action: "clear", mode }] })
          .success,
      ).toBe(false);
    }
  });

  test("rejects empty sequences and sequences over 100 commands", () => {
    expect(sendKeysSchema.safeParse({ platform: "ios", commands: [] }).success).toBe(false);
    expect(
      sendKeysSchema.safeParse({
        platform: "ios",
        commands: Array.from({ length: 101 }, () => ({ action: "clear" })),
      }).success,
    ).toBe(false);
  });

  test("rejects unknown keys, modifiers, and command fields", () => {
    expect(
      sendKeysSchema.safeParse({
        platform: "android",
        commands: [{ action: "key", key: "space" }],
      }).success,
    ).toBe(false);
    expect(
      sendKeysSchema.safeParse({
        platform: "android",
        commands: [{ action: "key", key: "enter", modifiers: ["super"] }],
      }).success,
    ).toBe(false);
    expect(
      sendKeysSchema.safeParse({
        platform: "android",
        commands: [{ action: "clear", text: "not allowed" }],
      }).success,
    ).toBe(false);
  });

  test("accepts every typing mode in cross-platform iOS plans", () => {
    for (const mode of [
      "auto",
      "a11y",
      "eventLast",
      "eventAll",
      "eventOnly",
      "ime",
      "imeKeyEvents",
    ]) {
      expect(
        sendKeysSchema.safeParse({
          platform: "ios",
          commands: [{ action: "type", text: "value", mode }],
        }).success,
      ).toBe(true);
    }
  });

  test("preflights platform runner capabilities before execution", async () => {
    const android = {
      deviceId: "android",
      name: "Android",
      platform: "android",
    } satisfies BootedDevice;
    const ios = {
      deviceId: "ios",
      name: "iOS",
      platform: "ios",
    } satisfies BootedDevice;

    await expect(
      assertSendKeysRunnerCompatible(android, () => ({
        getSupportedCommands: async () => ["request_insert_text"],
      })),
    ).resolves.toBeUndefined();
    await expect(
      assertSendKeysRunnerCompatible(ios, () => ({
        getSupportedCommands: async () => ["request_press_key"],
      })),
    ).resolves.toBeUndefined();
    await expect(
      assertSendKeysRunnerCompatible(android, () => ({
        getSupportedCommands: async () => [],
      })),
    ).rejects.toThrow("request_insert_text is unavailable");
    await expect(
      assertSendKeysRunnerCompatible(ios, () => ({
        getSupportedCommands: async () => null,
      })),
    ).rejects.toThrow("request_press_key is unavailable");
  });
});
