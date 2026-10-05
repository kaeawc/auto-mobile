import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  registerStorageTools,
  resetStorageToolsDependencies,
  setStorageToolsDependenciesForTesting,
  type AndroidKeyValueClient,
} from "../../src/server/storageTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { ActionableError, type BootedDevice } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";

const device: BootedDevice = { deviceId: "fake-device", name: "Fake", platform: "android" };
const args = {
  appId: "com.example.app",
  name: "settings",
  key: "key",
  value: "value",
  type: "STRING",
  adapterName: "adapter",
};
const toolNames = [
  "setKeyValue",
  "listDataStores",
  "getDataStore",
  "removeKeyValue",
  "clearKeyValueFile",
];

function handler(name: string) {
  const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find(
    (tool) => tool.name === name,
  );
  if (!tool?.deviceAwareHandler) {
    throw new Error(`Missing ${name}`);
  }
  return tool.deviceAwareHandler;
}

function fakeClient(failure?: Error): AndroidKeyValueClient {
  const write = async () => {
    if (failure) {
      throw failure;
    }
  };
  return {
    setPreference: write,
    removePreference: write,
    clearPreferenceStore: write,
    listDataStores: async () => {
      await write();
      return ["settings"];
    },
    getDataStore: async () => {
      await write();
      return { key: "value" };
    },
  };
}

beforeEach(() => {
  ToolRegistry.clearTools();
  const adb = new FakeAdbExecutor();
  setStorageToolsDependenciesForTesting({
    androidClientFactory: () => fakeClient(),
    adbClientFactory: { create: () => adb },
  });
  registerStorageTools();
});

afterEach(() => {
  ToolRegistry.clearTools();
  resetStorageToolsDependencies();
});

test("preserves registration order", () => {
  expect(ToolRegistry.getAllTools({ includeUnavailable: true }).map((tool) => tool.name)).toEqual(
    toolNames,
  );
});

test.each(["listDataStores", "getDataStore"])("%s preserves the read result", async (name) => {
  const result = await handler(name)(device, args);
  const content = result.content[0];
  if (content.type !== "text") {
    throw new Error("Expected text result");
  }
  expect(JSON.parse(content.text)).toEqual(
    name === "listDataStores"
      ? {
          success: true,
          appId: args.appId,
          adapterName: args.adapterName,
          stores: ["settings"],
        }
      : {
          success: true,
          appId: args.appId,
          adapterName: args.adapterName,
          name: args.name,
          entries: { key: "value" },
        },
  );
});

test.each(["listDataStores", "getDataStore"])("%s explains disabled inspection", async (name) => {
  setStorageToolsDependenciesForTesting({
    androidClientFactory: () => fakeClient(new Error("SharedPreferences inspection is disabled")),
  });
  await expect(handler(name)(device, args)).rejects.toThrow("inspection");
});

test.each(toolNames)("%s preserves ActionableError identity", async (name) => {
  const failure = new ActionableError("failed");
  setStorageToolsDependenciesForTesting({ androidClientFactory: () => fakeClient(failure) });
  await expect(handler(name)(device, args)).rejects.toBe(failure);
});

test.each(toolNames)("%s wraps unrelated client failures", async (name) => {
  const failure = new Error("failed");
  setStorageToolsDependenciesForTesting({ androidClientFactory: () => fakeClient(failure) });
  const result = handler(name)(device, args);
  await expect(result).rejects.toBeInstanceOf(ActionableError);
  await expect(result).rejects.toMatchObject({ cause: failure });
});

test.each(["listDataStores", "getDataStore"])(
  "%s rejects iOS before creating a client",
  async (name) => {
    let created = false;
    setStorageToolsDependenciesForTesting({
      androidClientFactory: () => {
        created = true;
        return fakeClient();
      },
    });
    await expect(handler(name)({ ...device, platform: "ios" }, args)).rejects.toThrow(
      "Android-only",
    );
    expect(created).toBe(false);
  },
);

test.each(["setKeyValue", "removeKeyValue", "clearKeyValueFile"])(
  "%s waits for mutation before emitting the entries update",
  async (name) => {
    const events: string[] = [];
    let finish!: () => void;
    const mutation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const write = async () => {
      events.push("mutation");
      await mutation;
      events.push("completed");
    };
    setStorageToolsDependenciesForTesting({
      androidClientFactory: () => ({
        ...fakeClient(),
        setPreference: write,
        removePreference: write,
        clearPreferenceStore: write,
      }),
    });
    const notify = spyOn(ResourceRegistry, "notifyResourceUpdated").mockImplementation(
      async (uri) => {
        events.push(uri);
      },
    );
    try {
      const result = handler(name)(device, args);
      expect(events).toEqual(["mutation"]);
      finish();
      await result;
      expect(events).toEqual([
        "mutation",
        "completed",
        "automobile:devices/fake-device/storage/com.example.app/settings/entries",
      ]);
    } finally {
      notify.mockRestore();
    }
  },
);

test("null set values remove Android preferences without validating a write-only type", async () => {
  const calls: string[] = [];
  setStorageToolsDependenciesForTesting({
    androidClientFactory: () => ({
      ...fakeClient(),
      setPreference: async () => {
        calls.push("set");
      },
      removePreference: async (...values) => {
        calls.push(values.join("/"));
      },
    }),
  });
  await handler("setKeyValue")(device, { ...args, value: null, type: "UNKNOWN" });
  expect(calls).toEqual(["com.example.app/settings/key"]);
});
