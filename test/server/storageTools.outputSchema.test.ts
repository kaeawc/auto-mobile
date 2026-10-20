import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerStorageTools,
  type AndroidKeyValueClient,
  type StorageToolsDependencies,
} from "../../src/server/storageTools";
import {
  clearKeyValueFileResultSchema,
  getDataStoreResultSchema,
  listDataStoresResultSchema,
  removeKeyValueResultSchema,
  setKeyValueResultSchema,
} from "../../src/server/storageToolOutputSchemas";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { toolIsError, toolJson, toolStructured } from "../helpers/toolResponse";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "fake-device", name: "Fake", platform: "android" };
const args = {
  appId: "com.example.app",
  name: "settings",
  key: "key",
  value: "value",
  type: "STRING",
  adapterName: "adapter",
};

const client: AndroidKeyValueClient = {
  setPreference: async () => {},
  removePreference: async () => {},
  clearPreferenceStore: async () => {},
  listDataStores: async () => ["settings"],
  getDataStore: async () => ({ key: "value" }),
};

const cases = [
  ["setKeyValue", setKeyValueResultSchema],
  ["removeKeyValue", removeKeyValueResultSchema],
  ["clearKeyValueFile", clearKeyValueFileResultSchema],
  ["listDataStores", listDataStoresResultSchema],
  ["getDataStore", getDataStoreResultSchema],
] as const;

describe("storage tool output schemas (#11830)", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    const adb = new FakeAdbExecutor();
    const deps: Partial<StorageToolsDependencies> = {
      androidClientFactory: () => client,
      adbClientFactory: { create: () => adb },
    };
    registerStorageTools(deps);
  });
  afterEach(() => ToolRegistry.clearTools());

  test.each(cases)("%s declares its outputSchema", (name, schema) => {
    const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find(
      (candidate) => candidate.name === name,
    );
    expect(tool?.outputSchema).toBe(schema);
  });

  test.each(cases)(
    "%s keeps the text payload and validates structuredContent",
    async (name, schema) => {
      const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find(
        (candidate) => candidate.name === name,
      );
      const response = await tool!.deviceAwareHandler!(device, args);
      expect(toolIsError(response)).toBe(false);
      expect(toolJson(response)).toEqual(JSON.parse(JSON.stringify(toolStructured(response))));
      expect(schema.safeParse(toolStructured(response)).success).toBe(true);
    },
  );

  test("listDataStores payload is unchanged", async () => {
    const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find(
      (candidate) => candidate.name === "listDataStores",
    );
    const response = await tool!.deviceAwareHandler!(device, args);
    expect(toolStructured(response)).toEqual({
      success: true,
      appId: args.appId,
      adapterName: args.adapterName,
      stores: ["settings"],
    });
  });
});
