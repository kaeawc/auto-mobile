import { toolJson, toolIsError } from "../helpers/toolResponse";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerStorageTools, type IosKeyValueClient } from "../../src/server/storageTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { BootedDevice } from "../../src/models";
import type { KeychainItemSelector } from "../../src/features/observe/ios/CtrlProxyStorage";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "ios-test", name: "iPhone", platform: "ios" };
const selector: KeychainItemSelector = {
  itemClass: "genericPassword",
  service: "test.service",
  account: "fixture",
  accessGroup: "TEAMID.test.app",
};

describe("deleteKeychainItem", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    serverConfig.setEmbeddedSdkEnabled(true);
    registerStorageTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    serverConfig.setEmbeddedSdkEnabled(false);
  });

  test("requires an exact nonempty selector and explicit confirmation", () => {
    const schema = ToolRegistry.getTool("deleteKeychainItem")!.schema;
    expect(
      schema.parse({ platform: "ios", appId: "test.app", selector, confirm: true }),
    ).toMatchObject({
      selector,
    });
    expect(() => schema.parse({ platform: "ios", appId: "test.app", selector })).toThrow();
    expect(() =>
      schema.parse({ platform: "ios", appId: "test.app", selector, confirm: false }),
    ).toThrow();
    expect(() =>
      schema.parse({
        platform: "ios",
        appId: "test.app",
        selector: { ...selector, account: "" },
        confirm: true,
      }),
    ).toThrow();
    expect(() =>
      schema.parse({
        platform: "ios",
        appId: "test.app",
        selector: { ...selector, accessGroup: "" },
        confirm: true,
      }),
    ).toThrow();
  });

  test("relays a structured deletion outcome without secret values", async () => {
    const calls: Array<{ appId: string; selector: KeychainItemSelector; confirm: boolean }> = [];
    const fake: IosKeyValueClient = {
      setPreference: async () => {},
      removePreference: async () => {},
      clearPreferenceStore: async () => {},
      deleteKeychainItemForIos: async (appId, selected, confirm) => {
        calls.push({ appId, selector: selected, confirm });
        return { outcome: "deleted", deletedScope: selected };
      },
    };
    registerStorageTools({ iosClientFactory: () => fake });
    const tool = ToolRegistry.getTool("deleteKeychainItem")!;
    const result = await tool.deviceAwareHandler!(device, {
      appId: "test.app",
      selector,
      confirm: true,
    });
    expect(calls).toEqual([{ appId: "test.app", selector, confirm: true }]);
    expect(toolJson(result)).toEqual({
      appId: "test.app",
      outcome: "deleted",
      deletedScope: selector,
    });
    expect(result).not.toHaveProperty("isError");
  });

  test.each([
    "mutation_not_authorized",
    "scope_not_authorized",
    "not_found",
    "keychain_error",
  ] as const)("returns %s as a structured error", async (outcome) => {
    const fake: IosKeyValueClient = {
      setPreference: async () => {},
      removePreference: async () => {},
      clearPreferenceStore: async () => {},
      deleteKeychainItemForIos: async () => ({ outcome, deletedScope: null }),
    };
    registerStorageTools({ iosClientFactory: () => fake });
    const result = await ToolRegistry.getTool("deleteKeychainItem")!.deviceAwareHandler!(device, {
      appId: "test.app",
      selector,
      confirm: true,
    });
    expect(toolIsError(result)).toBe(true);
    expect(toolJson(result)).toEqual({
      success: false,
      appId: "test.app",
      outcome,
      deletedScope: null,
    });
  });

  test("rejects Android before constructing an iOS client", async () => {
    let constructed = false;
    registerStorageTools({
      iosClientFactory: () => {
        constructed = true;
        throw new Error("unexpected factory");
      },
    });
    const tool = ToolRegistry.getTool("deleteKeychainItem")!;
    await expect(
      tool.deviceAwareHandler!(
        { ...device, platform: "android" },
        { appId: "test.app", selector, confirm: true },
      ),
    ).rejects.toThrow("requires iOS");
    expect(constructed).toBe(false);
  });
});
