import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { registerStorageTools, type IosKeyValueClient } from "../../src/server/storageTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

import { serverConfig } from "../../src/utils/ServerConfig";

isolateToolRegistry();
let embeddedSdkEnabled: boolean;
beforeEach(() => {
  embeddedSdkEnabled = serverConfig.isEmbeddedSdkEnabled();
  serverConfig.setEmbeddedSdkEnabled(true);
});
afterEach(() => serverConfig.setEmbeddedSdkEnabled(embeddedSdkEnabled));

const device: BootedDevice = { deviceId: "isolated-ios", name: "Fake", platform: "ios" };

test("storage handlers retain independent client dependencies across concurrent calls", async () => {
  const calls: string[] = [];
  const client = (owner: string): IosKeyValueClient => ({
    setPreference: async () => {
      calls.push(owner);
      return { resolvedStore: owner };
    },
    removePreference: async () => {},
    clearPreferenceStore: async () => {},
  });
  registerStorageTools({ iosClientFactory: () => client("first") });
  const first = ToolRegistry.getTool("setKeyValue")!.deviceAwareHandler!;
  registerStorageTools({ iosClientFactory: () => client("second") });
  const second = ToolRegistry.getTool("setKeyValue")!.deviceAwareHandler!;
  const args = {
    appId: "example.app",
    name: "standard",
    key: "key",
    value: "v",
    type: "STRING" as const,
  };
  await Promise.all([first(device, args), second(device, args), first(device, args)]);
  expect(calls).toEqual(["first", "second", "first"]);
});
