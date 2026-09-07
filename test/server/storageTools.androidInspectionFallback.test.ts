import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerStorageTools,
  resetStorageToolsDependencies,
  setStorageToolsDependenciesForTesting,
  type AndroidKeyValueClient,
} from "../../src/server/storageTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { serverConfig } from "../../src/utils/ServerConfig";
import { ActionableError } from "../../src/models";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";

// Issue #6292: setPreference always writes the on-device SharedPreferences XML file
// directly and never needs the SDK's SharedPreferencesInspector capability.
// setKeyValue/removeKeyValue/clearKeyValueFile normally route through that SDK
// capability instead, but when it's disabled they must fall back to the same
// direct-file path setPreference uses — a caller who can write a preference must
// also be able to delete or clear it, for the same app + file.

const ANDROID_DEVICE: BootedDevice = {
  name: "a",
  deviceId: "emulator-5554",
  platform: "android",
};

const APP_ID = "dev.jasonpearson.automobile.playground";
const FILE_NAME = "settings";

const INSPECTION_DISABLED_ERROR = () => new Error("SharedPreferences inspection is disabled");

function inspectionDisabledClient(
  overrides: Partial<AndroidKeyValueClient> = {},
): AndroidKeyValueClient {
  return {
    setPreference: async () => {
      throw INSPECTION_DISABLED_ERROR();
    },
    removePreference: async () => {
      throw INSPECTION_DISABLED_ERROR();
    },
    clearPreferenceStore: async () => {
      throw INSPECTION_DISABLED_ERROR();
    },
    listDataStores: async () => {
      throw INSPECTION_DISABLED_ERROR();
    },
    getDataStore: async () => {
      throw INSPECTION_DISABLED_ERROR();
    },
    ...overrides,
  };
}

function singleAdbFactory(adb: FakeAdbExecutor): AdbClientFactory {
  return { create: () => adb };
}

function toolHandler(name: string) {
  const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find((t) => t.name === name);
  if (!tool?.deviceAwareHandler) {
    throw new Error(`${name} tool not registered`);
  }
  return tool.deviceAwareHandler;
}

describe("storageTools Android SharedPreferences-inspection fallback (#6292)", () => {
  beforeEach(() => {
    ToolRegistry.clearTools();
    serverConfig.setEmbeddedSdkEnabled(true);
    registerStorageTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    serverConfig.setEmbeddedSdkEnabled(false);
    resetStorageToolsDependencies();
  });

  test("setKeyValue falls back to the direct-file path and succeeds when the SDK reports inspection disabled", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(`cat shared_prefs/${FILE_NAME}.xml`, createExecResult("<map/>", ""));

    setStorageToolsDependenciesForTesting({
      androidClientFactory: () => inspectionDisabledClient(),
      adbClientFactory: singleAdbFactory(adb),
    });

    const result = await toolHandler("setKeyValue")(ANDROID_DEVICE, {
      appId: APP_ID,
      name: FILE_NAME,
      key: "probeB",
      value: "2",
      type: "STRING",
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
    // Issue #6292: a direct-XML fallback edit on a possibly-running app warns that the
    // change may be overwritten from the app's in-memory cache until it is relaunched.
    expect(parsed.warning).toMatch(/relaunch/i);
    expect(parsed.warning).toContain(APP_ID);

    const writeCommand = adb
      .getExecutedCommands()
      .find((cmd) => cmd.includes(`base64 -d > shared_prefs/${FILE_NAME}.xml`));
    expect(writeCommand).toBeDefined();
  });

  test("no relaunch warning on the happy path when the SDK inspection capability is enabled", async () => {
    const adb = new FakeAdbExecutor();
    setStorageToolsDependenciesForTesting({
      // A client whose setPreference SUCCEEDS never trips the fallback, so no warning.
      androidClientFactory: () => inspectionDisabledClient({ setPreference: async () => {} }),
      adbClientFactory: singleAdbFactory(adb),
    });

    const result = await toolHandler("setKeyValue")(ANDROID_DEVICE, {
      appId: APP_ID,
      name: FILE_NAME,
      key: "probeB",
      value: "2",
      type: "STRING",
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.warning).toBeUndefined();
    // The SDK path handled it; no direct-file write was attempted.
    expect(adb.getExecutedCommands()).toHaveLength(0);
  });

  test("removeKeyValue falls back and removes a key the direct-file setPreference path wrote, for the same app+file", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence(`cat shared_prefs/${FILE_NAME}.xml`, [
      createExecResult('<map><string name="probeA">1</string></map>', ""),
    ]);

    setStorageToolsDependenciesForTesting({
      androidClientFactory: () => inspectionDisabledClient(),
      adbClientFactory: singleAdbFactory(adb),
    });

    const result = await toolHandler("removeKeyValue")(ANDROID_DEVICE, {
      appId: APP_ID,
      name: FILE_NAME,
      key: "probeA",
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);

    const writeCommand = adb
      .getExecutedCommands()
      .find((cmd) => cmd.includes(`base64 -d > shared_prefs/${FILE_NAME}.xml`));
    expect(writeCommand).toBeDefined();
    const match = writeCommand!.match(/([A-Za-z0-9+/=]{24,})/);
    const writtenXml = Buffer.from(match![1], "base64").toString("utf8");
    expect(writtenXml).not.toContain("probeA");
  });

  test("clearKeyValueFile falls back and succeeds when the SDK reports inspection disabled", async () => {
    const adb = new FakeAdbExecutor();

    setStorageToolsDependenciesForTesting({
      androidClientFactory: () => inspectionDisabledClient(),
      adbClientFactory: singleAdbFactory(adb),
    });

    const result = await toolHandler("clearKeyValueFile")(ANDROID_DEVICE, {
      appId: APP_ID,
      name: FILE_NAME,
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
  });

  test("does not fall back on an unrelated SDK failure — the real cause is surfaced", async () => {
    const adb = new FakeAdbExecutor();
    setStorageToolsDependenciesForTesting({
      androidClientFactory: () =>
        inspectionDisabledClient({
          removePreference: async () => {
            throw new Error("WebSocket not connected");
          },
        }),
      adbClientFactory: singleAdbFactory(adb),
    });

    await expect(
      toolHandler("removeKeyValue")(ANDROID_DEVICE, {
        appId: APP_ID,
        name: FILE_NAME,
        key: "probeA",
      }),
    ).rejects.toThrow(/WebSocket not connected/);

    // No direct-file fallback was attempted for a non-"inspection disabled" failure.
    expect(adb.getExecutedCommands()).toHaveLength(0);
  });

  test("a genuinely unavailable capability (direct-file fallback also fails) still reports an actionable message", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(
      `shell run-as ${APP_ID} cat shared_prefs/${FILE_NAME}.xml`,
      new Error("run-as: package not debuggable"),
    );

    setStorageToolsDependenciesForTesting({
      androidClientFactory: () => inspectionDisabledClient(),
      adbClientFactory: singleAdbFactory(adb),
    });

    await expect(
      toolHandler("removeKeyValue")(ANDROID_DEVICE, {
        appId: APP_ID,
        name: FILE_NAME,
        key: "probeA",
      }),
    ).rejects.toThrow(ActionableError);
    await expect(
      toolHandler("removeKeyValue")(ANDROID_DEVICE, {
        appId: APP_ID,
        name: FILE_NAME,
        key: "probeA",
      }),
    ).rejects.toThrow(/debuggable\/test build/);
  });

  test("listDataStores rewrites the disabled-inspection error with actionable guidance (no filesystem fallback exists for DataStore)", async () => {
    setStorageToolsDependenciesForTesting({
      androidClientFactory: () => inspectionDisabledClient(),
    });

    await expect(
      toolHandler("listDataStores")(ANDROID_DEVICE, {
        appId: APP_ID,
        adapterName: "settings",
      }),
    ).rejects.toThrow(/SharedPreferencesInspector\.setEnabled/);
  });
});
