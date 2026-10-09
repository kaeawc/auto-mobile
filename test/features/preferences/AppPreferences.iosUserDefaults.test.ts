import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AppPreferences,
  isIosPreferenceSdkUnavailable,
  isIosPreferenceSdkNotDispatched,
  type IosPreferenceKeyValueClient,
  type PreferenceValueType,
} from "../../../src/features/preferences/AppPreferences";
import { IOS_SDK_REDACTED_VALUE } from "../../../src/features/preferences/IosPreferenceTypes";
import { parseIosUserDefaultsPlist } from "../../../src/features/preferences/IosUserDefaultsPlist";
import {
  CtrlProxyServicePortChangedError,
  IOSCtrlProxyClient,
} from "../../../src/features/observe/ios/IOSCtrlProxyClient";
import type { KeyValueEntry, KeyValueType } from "../../../src/features/storage/storageTypes";
import type { PlistReader } from "../../../src/utils/ios-cmdline-tools/PlistClient";
import { IOS_STORAGE_MUTATION_AUTHORIZATION_HINT } from "../../../src/server/storageSdkErrors";
import { buildPlist, PlistReal } from "../../../src/utils/ios-cmdline-tools/XctestrunPlist";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createSuccessWebSocketFactory } from "../../fakes/FakeWebSocket";

const device = {
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
  name: "fake iPhone",
} as const;
const input = {
  scope: "userDefaults",
  appId: "com.Example.app",
  suite: "mt8327Suite",
  key: "kv8327",
} as const;
const container = "/fake/app container";
const fixtureXml = readFileSync(
  new URL("../../fixtures/ios-userdefaults-plist/xml-origin.plist", import.meta.url),
  "utf8",
);
const fixtureBinary = readFileSync(
  new URL("../../fixtures/ios-userdefaults-plist/binary-origin.plist", import.meta.url),
  "utf8",
);

class FakeKeyValueClient implements IosPreferenceKeyValueClient {
  connected = true;
  readonly calls: Array<{
    operation: string;
    appId: string;
    store: string;
    key: string;
    value?: string | null;
    type?: KeyValueType;
    timeoutMs?: number;
  }> = [];
  entry: KeyValueEntry | null = null;
  readError?: string | Error;
  writeError?: string | Error;
  onRead?: () => void;
  onWrite?: () => void;
  isConnected(): boolean {
    return this.connected;
  }
  async getPreference(
    appId: string,
    store: string,
    key: string,
    timeoutMs?: number,
  ): Promise<KeyValueEntry | null> {
    this.calls.push({ operation: "get", appId, store, key, timeoutMs });
    this.onRead?.();
    if (this.readError) {
      throw typeof this.readError === "string" ? new Error(this.readError) : this.readError;
    }
    return this.entry;
  }
  async setPreference(
    appId: string,
    store: string,
    key: string,
    value: string | null,
    type: KeyValueType,
    timeoutMs?: number,
  ): Promise<void> {
    this.calls.push({ operation: "set", appId, store, key, value, type, timeoutMs });
    this.onWrite?.();
    if (this.writeError) {
      throw typeof this.writeError === "string" ? new Error(this.writeError) : this.writeError;
    }
    this.entry = { key, value, type };
  }
}

class FakePlistReader implements Pick<PlistReader, "readXmlFile"> {
  readonly paths: string[] = [];
  xml = buildPlist(new Map());
  error?: string;
  async readXmlFile(path: string): Promise<string> {
    this.paths.push(path);
    if (this.error) {
      throw new Error(this.error);
    }
    return this.xml;
  }
  setValue(value: string | number | boolean, type: PreferenceValueType): void {
    this.xml = buildPlist(
      new Map([[input.key, type === "float" ? new PlistReal(Number(value)) : value]]),
    );
  }
}

class FakeContainerSimctl {
  readonly calls: Array<{ args: string[]; timeoutMs?: number }> = [];
  containerPath = container;
  containerError?: string;
  writeError?: string;
  processList = "PID\tStatus\tLabel\n";
  processListError?: string;
  onCommand?: () => void;
  async executeCommand(): Promise<{ stdout: string; stderr: string }> {
    throw new Error("Unexpected string command");
  }
  async executeCommandArgs(
    args: string[],
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ args, timeoutMs });
    this.onCommand?.();
    if (args[2] === "launchctl") {
      if (this.processListError) {
        throw new Error(this.processListError);
      }
      return { stdout: this.processList, stderr: "" };
    }
    if (args[0] === "get_app_container") {
      if (this.containerError) {
        throw new Error(this.containerError);
      }
      return { stdout: `${this.containerPath}\n`, stderr: "" };
    }
    if (args[3] !== "write") {
      throw new Error("Unexpected defaults read");
    }
    if (this.writeError) {
      throw new Error(this.writeError);
    }
    return { stdout: "", stderr: "" };
  }
}

function harness(state: "open" | "closed" | "absent" = "open") {
  const sdk = new FakeKeyValueClient();
  sdk.connected = state !== "closed";
  const simctl = new FakeContainerSimctl();
  const plist = new FakePlistReader();
  const timer = new FakeTimer();
  const preferences = new AppPreferences(device, {
    iosKeyValueClientProvider: () => (state === "absent" ? null : sdk),
    simctl,
    plistReader: plist,
    timer,
  });
  return { sdk, simctl, plist, timer, preferences };
}

const typedCases: Array<{
  type: PreferenceValueType;
  sdkType: KeyValueType;
  value: string | number | boolean;
  flag: string;
}> = [
  { type: "int", sdkType: "INT", value: 42, flag: "-int" },
  { type: "bool", sdkType: "BOOLEAN", value: true, flag: "-bool" },
  { type: "string", sdkType: "STRING", value: "  C:\\tmp\n", flag: "-string" },
  { type: "float", sdkType: "FLOAT", value: 3, flag: "-float" },
];

const unavailableMessages = [
  "Failed to connect to CtrlProxy",
  "WebSocket connection closed",
  "WebSocket is not open",
  "CtrlProxy service port changed",
  "Get preference timeout after 2500ms",
  "iOS UserDefaults request timed out after 2500ms.",
  "iOS key-value storage inspection is disabled; call UserDefaultsInspector.shared.setEnabled(true): user_defaults_inspection_disabled",
  "iOS key-value storage requires the target app to embed or upgrade the AutoMobile SDK: HTTP 404",
  "iOS key-value storage requires the target app to embed or upgrade the AutoMobile SDK: not_found",
  "iOS key-value storage requires the target app to embed the AutoMobile SDK, initialize it, and call UserDefaultsInspector.shared.setEnabled(true): Could not connect to the server.",
  "iOS key-value storage requires the target app to embed the AutoMobile SDK, initialize it, and call UserDefaultsInspector.shared.setEnabled(true): The network connection was lost.",
];
const faultMessages = [
  "app_id_mismatch",
  "app_not_active",
  "invalid_preference_value",
  "encode_failed",
  "mutation_not_authorized",
  "iOS key-value storage requires the target app to embed or upgrade the AutoMobile SDK: unknown_server_fault",
  "iOS key-value storage requires the target app to embed the AutoMobile SDK, initialize it, and call UserDefaultsInspector.shared.setEnabled(true): The data couldn’t be read because it isn’t in the correct format.",
  "iOS key-value storage inspection is disabled; call UserDefaultsInspector.shared.setEnabled(true): unknown_server_fault",
];

// Exact pre-dispatch messages from CommandHandler+Storage.swift, including the wire wrapper.
const appSdkRefusal = `Command execution failed: iOS key-value storage requires ${input.appId} to embed and initialize the AutoMobile SDK and call UserDefaultsInspector.shared.setEnabled(true)`;
const bareSdkRefusal =
  "Command execution failed: iOS key-value storage requires the target app to embed the AutoMobile SDK";
const notDispatchedMessages = [
  `${appSdkRefusal}: sdk_unavailable_not_dispatched`,
  appSdkRefusal,
  `${bareSdkRefusal}: sdk_unavailable_not_dispatched`,
  bareSdkRefusal,
];

// Pin the existing IOS_PLIST_WRITE_WARNING without changing the public result.
const containerWriteWarning =
  "defaults write to an absolute path bypasses the preferences daemon. A running app may not see the change, and cfprefsd may later overwrite it with cached state until the app restarts. verified: true proves only file content, not the running app's state.";

describe("SDK not-dispatched classification", () => {
  for (const message of [
    ...notDispatchedMessages,
    "sdk_unavailable_not_dispatched",
    "future runner wording: sdk_unavailable_not_dispatched",
    appSdkRefusal.replace("Command execution failed: ", ""),
    bareSdkRefusal.replace("Command execution failed: ", ""),
  ]) {
    test(`recognizes only a known refusal or trailing code: ${message}`, () => {
      expect(isIosPreferenceSdkNotDispatched(new Error(message))).toBe(true);
      expect(isIosPreferenceSdkUnavailable(new Error(message))).toBe(true);
    });
  }
  for (const message of [
    ...unavailableMessages,
    ...faultMessages,
    `${appSdkRefusal}: unexpected_error`,
    `${bareSdkRefusal}, initialize it, and call UserDefaultsInspector.shared.setEnabled(true): Could not connect to the server.`,
    `${appSdkRefusal} later failed`,
    `unrelated prefix: ${appSdkRefusal}`,
    `${appSdkRefusal}: sdk_unavailable_not_dispatched_suffix`,
    `${appSdkRefusal}: sdk_unavailable_not_dispatched: network failure`,
    `Command execution failed: iOS key-value storage requires ${input.appId} to be the foreground app`,
    "iOS key-value storage app id mismatch",
  ]) {
    test(`does not authorize write fallback: ${message}`, () => {
      expect(isIosPreferenceSdkNotDispatched(new Error(message))).toBe(false);
    });
  }
});

describe("runner SDK refusals before dispatch", () => {
  for (const message of notDispatchedMessages) {
    for (const suite of ["Standard", input.suite]) {
      test(`write falls back once for ${suite}: ${message}`, async () => {
        const { preferences, sdk, simctl, plist } = harness();
        sdk.writeError = message;
        simctl.onCommand = () => {
          if (simctl.calls.at(-1)?.args[3] === "write") {
            plist.setValue("container value", "string");
          }
        };
        const result = await preferences.setPreference({
          ...input,
          suite,
          value: "container value",
          type: "string",
        });
        const domain = join(
          container,
          "Library",
          "Preferences",
          suite === "Standard" ? input.appId : suite,
        );
        expect(result).toMatchObject({
          success: true,
          found: true,
          verified: true,
          value: "container value",
          type: "string",
          resolvedStore: suite === "Standard" ? "standard" : suite,
          storeRoute: "container-plist",
          warning: containerWriteWarning,
        });
        expect(sdk.calls.map((call) => call.operation)).toEqual(["set"]);
        expect(simctl.calls.map((call) => call.args)).toEqual([
          ["get_app_container", device.deviceId, input.appId, "data"],
          [
            "spawn",
            device.deviceId,
            "defaults",
            "write",
            domain,
            input.key,
            "-string",
            "container value",
          ],
        ]);
        expect(plist.paths).toEqual([`${domain}.plist`]);
      });
    }
    test(`read falls back: ${message}`, async () => {
      const { preferences, sdk, simctl, plist } = harness();
      sdk.readError = message;
      plist.setValue(42, "int");
      expect(await preferences.getPreference(input)).toMatchObject({
        found: true,
        value: 42,
        storeRoute: "container-plist",
        warning: expect.stringContaining("on-disk plist"),
      });
      expect(sdk.calls.map((call) => call.operation)).toEqual(["get"]);
      expect(simctl.calls.map((call) => call.args)).toEqual([
        ["get_app_container", device.deviceId, input.appId, "data"],
      ]);
      expect(plist.paths).toEqual([
        join(container, "Library", "Preferences", `${input.suite}.plist`),
      ]);
    });
    test(`app-group refusal still requires SDK: ${message}`, async () => {
      const { preferences, sdk, simctl, plist } = harness();
      sdk.writeError = message;
      sdk.readError = message;
      const group = { ...input, suite: "group.com.example" };
      await expect(preferences.setPreference({ ...group, value: 42, type: "int" })).rejects.toThrow(
        "Connect the app's runner before writing.",
      );
      expect(await preferences.getPreference(group)).toMatchObject({
        found: false,
        value: null,
        storeRoute: "container-plist",
        resolvedStore: group.suite,
        warning: expect.stringContaining("only reachable through the embedded SDK"),
      });
      expect(simctl.calls).toEqual([]);
      expect(plist.paths).toEqual([]);
    });
  }
  for (const message of [
    "Command execution failed: iOS key-value storage failed: connection lost after dispatch",
    "iOS key-value storage requires the target app to embed the AutoMobile SDK, initialize it, and call UserDefaultsInspector.shared.setEnabled(true): The network connection was lost.",
    "iOS key-value storage requires the target app to embed or upgrade the AutoMobile SDK: not_found",
    "iOS key-value storage app id mismatch",
    "app_not_active",
    "unknown SDK error",
  ]) {
    test(`dispatched or unsafe write remains terminal: ${message}`, async () => {
      const { preferences, sdk, simctl, plist } = harness();
      sdk.writeError = message;
      await expect(preferences.setPreference({ ...input, value: 42, type: "int" })).rejects.toThrow(
        `iOS UserDefaults SDK write failed: ${message}. The write may or may not have been applied. Read the value through the SDK before retrying; no container write was attempted.`,
      );
      expect(sdk.calls.map((call) => call.operation)).toEqual(["set"]);
      expect(simctl.calls).toEqual([]);
      expect(plist.paths).toEqual([]);
    });
  }
  describe("foreground refusal (#10794)", () => {
    const foregroundRefusal = `Command execution failed: iOS key-value storage requires ${input.appId} to be the foreground app`;
    const launchctlRunning = `PID\tStatus\tLabel\n4242\t0\tUIKitApplication:${input.appId}[0x1a2b][rb-legacy]\n`;
    test("seeds the container plist when the app has no process", async () => {
      const { preferences, sdk, simctl, plist } = harness();
      sdk.writeError = foregroundRefusal;
      simctl.onCommand = () => {
        if (simctl.calls.at(-1)?.args[3] === "write") {
          plist.setValue(7, "int");
        }
      };
      const result = await preferences.setPreference({ ...input, value: 7, type: "int" });
      expect(result).toMatchObject({
        success: true,
        verified: true,
        storeRoute: "container-plist",
      });
      expect(simctl.calls.map((call) => call.args[0] + ":" + call.args[3])).toEqual([
        "spawn:list",
        "get_app_container:data",
        "spawn:write",
      ]);
    });
    test("keeps refusing when the app is running in the background", async () => {
      const { preferences, sdk, simctl, plist } = harness();
      sdk.writeError = foregroundRefusal;
      simctl.processList = launchctlRunning;
      await expect(preferences.setPreference({ ...input, value: 7, type: "int" })).rejects.toThrow(
        "no container write was attempted",
      );
      expect(simctl.calls.map((call) => call.args[3])).toEqual(["list"]);
      expect(plist.paths).toEqual([]);
    });
    test("fails closed when the process probe errors", async () => {
      const { preferences, sdk, simctl } = harness();
      sdk.writeError = foregroundRefusal;
      simctl.processListError = "launchctl unavailable";
      await expect(preferences.setPreference({ ...input, value: 7, type: "int" })).rejects.toThrow(
        "no container write was attempted",
      );
      expect(simctl.calls.map((call) => call.args[3])).toEqual(["list"]);
    });
  });
  test("mutation authorization takes precedence over the fallback token", async () => {
    const { preferences, sdk, simctl } = harness();
    sdk.writeError = "mutation_not_authorized: sdk_unavailable_not_dispatched";
    await expect(preferences.setPreference({ ...input, value: 42, type: "int" })).rejects.toThrow(
      IOS_STORAGE_MUTATION_AUTHORIZATION_HINT,
    );
    expect(simctl.calls).toEqual([]);
  });
  test("physical device rejects writes before consulting the SDK", async () => {
    const sdk = new FakeKeyValueClient();
    sdk.writeError = notDispatchedMessages[0];
    const provider = spyOn({ get: () => sdk }, "get");
    const simctl = new FakeContainerSimctl();
    const preferences = new AppPreferences(
      { ...device, deviceId: "physical-device" },
      {
        iosKeyValueClientProvider: provider,
        simctl,
        timer: new FakeTimer(),
      },
    );
    await expect(preferences.setPreference({ ...input, value: 42, type: "int" })).rejects.toThrow(
      "iOS physical devices are not supported for UserDefaults preferences yet.",
    );
    expect(provider).not.toHaveBeenCalled();
    expect(sdk.calls).toEqual([]);
    expect(simctl.calls).toEqual([]);
    provider.mockRestore();
  });
  test("SDK read-back refusal after a successful write never retries the write", async () => {
    const { preferences, sdk, simctl, plist } = harness();
    sdk.readError = notDispatchedMessages[0];
    await expect(preferences.setPreference({ ...input, value: 42, type: "int" })).rejects.toThrow(
      "write completed but read-back verification failed",
    );
    expect(sdk.calls.map((call) => call.operation)).toEqual(["set", "get"]);
    expect(simctl.calls).toEqual([]);
    expect(plist.paths).toEqual([]);
  });
  for (const failure of ["missing app", "defaults write", "read-back"] as const) {
    test(`fallback surfaces its own ${failure} failure`, async () => {
      const { preferences, sdk, simctl, plist } = harness();
      sdk.writeError = notDispatchedMessages[0];
      const expected =
        failure === "missing app"
          ? "not installed on this simulator"
          : failure === "defaults write"
            ? "defaults permission denied"
            : "plist permission denied";
      if (failure === "missing app") {
        simctl.containerError = "Application not found.";
      }
      if (failure === "defaults write") {
        simctl.writeError = "defaults permission denied";
      }
      if (failure === "read-back") {
        plist.error = "plist permission denied";
      }
      await expect(preferences.setPreference({ ...input, value: 42, type: "int" })).rejects.toThrow(
        expected,
      );
      expect(sdk.calls.map((call) => call.operation)).toEqual(["set"]);
      expect(simctl.calls.some((call) => call.args[3] === "write")).toBe(failure !== "missing app");
    });
  }
});

describe("iOS app UserDefaults resolution", () => {
  test("bool write with a STRING override reports an unverifiable effective type", async () => {
    const { preferences, sdk } = harness();
    sdk.onRead = () => {
      sdk.entry = { key: input.key, type: "STRING", value: "forced" };
    };

    const result = await preferences.setPreference({ ...input, type: "bool", value: true });
    expect(result).toMatchObject({ found: true, value: "forced", type: "string", verified: false });
    expect(result.warning).toContain("value was written");
    expect(result.warning).toContain("different type (string vs requested bool)");
    expect(result.warning).toContain("equality was not verified");

    const fallback = harness("absent");
    fallback.plist.setValue("forced", "string");
    const fallbackResult = await fallback.preferences.setPreference({
      ...input,
      type: "bool",
      value: true,
    });
    expect(fallbackResult).toMatchObject({
      found: true,
      value: "forced",
      type: "string",
      verified: false,
    });
    expect(fallbackResult.warning).toContain("bypasses the preferences daemon");
    expect(fallbackResult.warning).toContain("different type (string vs requested bool)");
  });

  for (const { type, sdkType, value, flag } of typedCases) {
    test(`SDK ${type} write and verification use the same store`, async () => {
      const { preferences, sdk, simctl, plist } = harness();
      await sdk.setPreference(input.appId, input.suite, input.key, String(value), sdkType);
      expect(await preferences.getPreference(input)).toMatchObject({
        value,
        type,
        found: true,
        resolvedStore: input.suite,
        storeRoute: "sdk",
      });
      const result = await preferences.setPreference({ ...input, type, value });
      expect(result).toMatchObject({
        value,
        type,
        verified: true,
        resolvedStore: input.suite,
        storeRoute: "sdk",
      });
      expect(result.warning).toBeUndefined();
      expect(sdk.calls.map((call) => call.operation)).toEqual(["set", "get", "set", "get"]);
      expect(sdk.calls[2]).toMatchObject({
        appId: input.appId,
        store: input.suite,
        key: input.key,
        value: String(value),
        type: sdkType,
        timeoutMs: 2500,
      });
      expect(simctl.calls).toEqual([]);
      expect(plist.paths).toEqual([]);
    });
    for (const state of ["absent", "closed"] as const) {
      test(`${state} runner: container ${type} read and write never call SDK`, async () => {
        const { preferences, simctl, plist, sdk } = harness(state);
        plist.setValue(value, type);
        const read = await preferences.getPreference(input);
        expect(read).toMatchObject({
          value,
          type,
          found: true,
          resolvedStore: input.suite,
          storeRoute: "container-plist",
        });
        expect(read.warning).toContain("on-disk plist");
        expect(read.warning).toContain("may lag a running app");
        const write = await preferences.setPreference({ ...input, type, value });
        expect(write).toMatchObject({
          value,
          type,
          verified: true,
          resolvedStore: input.suite,
          storeRoute: "container-plist",
        });
        expect(write.warning).toContain("bypasses the preferences daemon");
        expect(write.warning).toContain("cfprefsd may later overwrite");
        expect(write.warning).toContain("proves only file content, not the running app's state");
        expect(simctl.calls.map((call) => call.args)).toEqual([
          ["get_app_container", device.deviceId, input.appId, "data"],
          ["get_app_container", device.deviceId, input.appId, "data"],
          [
            "spawn",
            device.deviceId,
            "defaults",
            "write",
            join(container, "Library", "Preferences", "mt8327Suite"),
            input.key,
            flag,
            String(value),
          ],
        ]);
        expect(plist.paths).toEqual(
          Array(2).fill(join(container, "Library", "Preferences", "mt8327Suite.plist")),
        );
        expect(sdk.calls).toEqual([]);
      });
    }
  }

  for (const suite of [
    undefined,
    "",
    "  ",
    "Standard",
    "standard",
    "STANDARD",
    input.appId,
    input.appId.toUpperCase(),
  ]) {
    test(`standard normalization: ${JSON.stringify(suite)}`, async () => {
      const sdk = harness();
      const result = await sdk.preferences.setPreference({
        ...input,
        suite,
        value: 42,
        type: "int",
      });
      expect(result).toMatchObject({ resolvedStore: "standard", storeRoute: "sdk" });
      expect(sdk.sdk.calls.map((call) => call.store)).toEqual(["Standard", "Standard"]);
      const fallback = harness("absent");
      fallback.plist.setValue(42, "int");
      expect(
        await fallback.preferences.setPreference({ ...input, suite, value: 42, type: "int" }),
      ).toMatchObject({ verified: true, resolvedStore: "standard", storeRoute: "container-plist" });
      expect(fallback.plist.paths).toEqual([
        join(container, "Library", "Preferences", `${input.appId}.plist`),
      ]);
    });
  }

  for (const state of ["absent", "closed", "open"] as const) {
    test(`production ${state} lookup is lazy and never creates/connects a runner`, async () => {
      const timer = new FakeTimer();
      const client = IOSCtrlProxyClient.createForTesting(
        device,
        8765,
        createSuccessWebSocketFactory(timer),
        timer,
      );
      const sdk = new FakeKeyValueClient();
      sdk.connected = state === "open";
      const adapter = spyOn(client, "getConnectedPreferenceClient").mockReturnValue(sdk);
      const create = spyOn(IOSCtrlProxyClient, "getInstance").mockImplementation(() => {
        throw new Error("Auto-start forbidden");
      });
      const connect = spyOn(IOSCtrlProxyClient.prototype, "ensureConnected").mockImplementation(
        () => {
          throw new Error("Auto-connect forbidden");
        },
      );
      const existing = spyOn(IOSCtrlProxyClient, "getExistingInstance").mockReturnValue(
        state === "absent" ? null : client,
      );
      try {
        new AppPreferences({ ...device, platform: "android" });
        expect(existing).not.toHaveBeenCalled();
        expect(adapter).not.toHaveBeenCalled();
        const simctl = new FakeContainerSimctl();
        const plist = new FakePlistReader();
        const preferences = new AppPreferences(device, { simctl, plistReader: plist, timer });
        const read = await preferences.getPreference(input);
        await preferences.setPreference({ ...input, value: 42, type: "int" });
        expect(existing).toHaveBeenCalledWith(device.deviceId);
        expect(read.storeRoute).toBe(state === "open" ? "sdk" : "container-plist");
        expect(sdk.calls).toHaveLength(state === "open" ? 3 : 0);
        expect(create).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
      } finally {
        create.mockRestore();
        connect.mockRestore();
        existing.mockRestore();
        adapter.mockRestore();
        await client.close();
      }
    });
  }

  test("connected-only production delegate never calls ensureConnected when a socket closes", async () => {
    const timer = new FakeTimer();
    const client = IOSCtrlProxyClient.createForTesting(
      device,
      8765,
      createSuccessWebSocketFactory(timer),
      timer,
    );
    const connect = spyOn(client, "ensureConnected").mockImplementation(() => {
      throw new Error("Auto-start forbidden");
    });
    try {
      const existing = client.getConnectedPreferenceClient();
      const connection = spyOn(client, "isConnected").mockReturnValue(true);
      try {
        const read = existing.getPreference(input.appId, "Standard", input.key, 2500);
        await Promise.resolve();
        const manager = client["getRequestManager"]();
        manager.resolve(manager.getPendingIds()[0]!, {
          success: true,
          found: true,
          entry: { key: input.key, type: "INT", value: "42" },
          totalTimeMs: 0,
        });
        expect(await read).toMatchObject({ type: "INT", value: "42" });
        const write = existing.setPreference(input.appId, "Standard", input.key, "42", "INT", 2500);
        await Promise.resolve();
        manager.resolve(manager.getPendingIds()[0]!, { success: true, totalTimeMs: 0 });
        await write;
        connection.mockReturnValue(false);
      } finally {
        connection.mockRestore();
      }
      expect(existing.isConnected()).toBe(false);
      await expect(
        existing.getPreference(input.appId, "Standard", input.key, 2500),
      ).rejects.toThrow("Failed to connect to CtrlProxy");
      await expect(
        existing.setPreference(input.appId, "Standard", input.key, "42", "INT", 2500),
      ).rejects.toThrow("Failed to connect to CtrlProxy");
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      await client.close();
    }
  });

  test("SDK missing key is authoritative", async () => {
    const { preferences, simctl } = harness();
    expect(await preferences.getPreference(input)).toMatchObject({
      found: false,
      value: null,
      resolvedStore: input.suite,
      storeRoute: "sdk",
    });
    expect(simctl.calls).toEqual([]);
  });

  for (const message of unavailableMessages) {
    test(`read fallback but never double-write: ${message}`, async () => {
      expect(isIosPreferenceSdkUnavailable(new Error(message))).toBe(true);
      const read = harness();
      read.sdk.readError = message;
      read.plist.setValue(42, "int");
      const result = await read.preferences.getPreference(input);
      expect(result).toMatchObject({ value: 42, storeRoute: "container-plist" });
      expect(result.warning).toContain("may lag a running app");
      const write = harness();
      write.sdk.writeError = message;
      await expect(
        write.preferences.setPreference({ ...input, value: 42, type: "int" }),
      ).rejects.toThrow("may or may not have been applied");
      expect(write.simctl.calls).toEqual([]);
      expect(write.plist.paths).toEqual([]);
    });
  }
  for (const message of faultMessages) {
    test(`SDK faults surface without read fallback: ${message}`, async () => {
      expect(isIosPreferenceSdkUnavailable(new Error(message))).toBe(false);
      const { preferences, sdk, simctl } = harness();
      sdk.readError = message;
      await expect(preferences.getPreference(input)).rejects.toThrow(
        message === "mutation_not_authorized" ? IOS_STORAGE_MUTATION_AUTHORIZATION_HINT : message,
      );
      expect(simctl.calls).toEqual([]);
    });
  }
  test("mutation refusal preserves authorization advice without writing the plist", async () => {
    const { preferences, sdk, simctl } = harness();
    sdk.writeError = "mutation_not_authorized";
    await expect(preferences.setPreference({ ...input, value: 42, type: "int" })).rejects.toThrow(
      IOS_STORAGE_MUTATION_AUTHORIZATION_HINT,
    );
    expect(simctl.calls).toEqual([]);
  });
  test("write timeout is bounded and never falls back", async () => {
    const { preferences, sdk, timer, simctl } = harness();
    sdk.onWrite = () => timer.advanceTime(2500);
    await expect(preferences.setPreference({ ...input, value: 42, type: "int" })).rejects.toThrow(
      "may or may not have been applied",
    );
    expect(sdk.calls[0].timeoutMs).toBe(2500);
    expect(simctl.calls).toEqual([]);
  });
  test("read timeout is bounded and falls back with the staleness warning", async () => {
    const { preferences, sdk, timer, simctl } = harness();
    sdk.onRead = () => timer.advanceTime(2500);
    const result = await preferences.getPreference(input);
    expect(result.storeRoute).toBe("container-plist");
    expect(result.warning).toContain("on-disk plist");
    expect(simctl.calls).toHaveLength(1);
  });
  test("SDK write verification connection loss stays on SDK", async () => {
    const { preferences, sdk, simctl } = harness();
    sdk.readError = "WebSocket connection closed";
    await expect(preferences.setPreference({ ...input, type: "int", value: 42 })).rejects.toThrow(
      "WebSocket connection closed",
    );
    expect(simctl.calls).toEqual([]);
    expect(sdk.calls.map((call) => call.operation)).toEqual(["set", "get"]);
  });
  test("write verification reports the actual read-back type", async () => {
    const { preferences, sdk } = harness();
    sdk.onRead = () => {
      sdk.entry = { key: input.key, type: "DOUBLE", value: "42" };
    };
    expect(await preferences.setPreference({ ...input, type: "int", value: 42 })).toMatchObject({
      verified: true,
      type: "float",
      value: 42,
    });
  });
  test("SDK write verification miss reports verified false", async () => {
    const { preferences, sdk } = harness();
    sdk.onRead = () => {
      sdk.entry = null;
    };
    expect(await preferences.setPreference({ ...input, type: "int", value: 42 })).toMatchObject({
      found: false,
      verified: false,
      storeRoute: "sdk",
    });
  });
  test("app-group fallback returns a warning/miss; writes require the SDK", async () => {
    const { preferences, simctl, plist } = harness("absent");
    const group = { ...input, suite: "group.com.example" };
    const result = await preferences.getPreference(group);
    expect(result).toMatchObject({
      found: false,
      resolvedStore: group.suite,
      storeRoute: "container-plist",
    });
    expect(result.warning).toContain("group container");
    expect(result.warning).toContain("only reachable through the embedded SDK");
    await expect(preferences.setPreference({ ...group, type: "int", value: 42 })).rejects.toThrow(
      "Connect the app's runner",
    );
    expect(simctl.calls).toEqual([]);
    expect(plist.paths).toEqual([]);
  });
  test("connected SDK can read and write an app-group suite", async () => {
    const { preferences, sdk, simctl } = harness();
    expect(
      await preferences.setPreference({
        ...input,
        suite: "group.com.example",
        type: "int",
        value: 42,
      }),
    ).toMatchObject({ verified: true, storeRoute: "sdk" });
    expect(sdk.calls[0].store).toBe("group.com.example");
    expect(simctl.calls).toEqual([]);
  });
  for (const message of [
    "Application not found.",
    "No such file or directory",
    "NSPOSIXErrorDomain, code=2",
  ]) {
    test(`genuine missing app: ${message}`, async () => {
      const { preferences, simctl } = harness("absent");
      simctl.containerError = message;
      await expect(preferences.getPreference(input)).rejects.toThrow(
        "not installed on this simulator",
      );
    });
  }
  for (const message of [
    "simctl timed out after 10000ms",
    "Invalid device: unavailable",
    "permission denied",
  ]) {
    test(`container failures preserve retry advice: ${message}`, async () => {
      const { preferences, simctl } = harness("absent");
      simctl.containerError = message;
      await expect(preferences.getPreference(input)).rejects.toThrow(message);
      await expect(preferences.getPreference(input)).rejects.toThrow(
        "Check simulator availability and retry",
      );
    });
  }
  test("empty container is a resolution failure, not app-not-installed", async () => {
    const { preferences, simctl } = harness("absent");
    simctl.containerPath = "";
    await expect(preferences.getPreference(input)).rejects.toThrow("empty data container path");
  });
  test("container lookup timeout prevents writes and identifies a resolution failure", async () => {
    const { preferences, timer, simctl } = harness("absent");
    simctl.onCommand = () => timer.advanceTime(10000);
    await expect(preferences.setPreference({ ...input, type: "int", value: 42 })).rejects.toThrow(
      "Check simulator availability and retry",
    );
    expect(simctl.calls).toHaveLength(1);
  });
  test("missing plist/key warns; malformed XML/permissions surface", async () => {
    const { preferences, plist } = harness("absent");
    expect(await preferences.getPreference(input)).toMatchObject({ found: false });
    plist.error = "plutil failed: No such file or directory";
    expect((await preferences.getPreference(input)).warning).toContain("on-disk plist");
    plist.error = "plutil failed: permission denied";
    await expect(preferences.getPreference(input)).rejects.toThrow("permission denied");
    plist.error = undefined;
    plist.xml = "<plist><array/></plist>";
    await expect(preferences.getPreference(input)).rejects.toThrow("must contain a dictionary");
    plist.xml = "<plist><dict><key>unpaired</key></dict></plist>";
    await expect(preferences.getPreference(input)).rejects.toThrow("key/value pair");
  });
  test("path traversal rejected before any route", async () => {
    const { preferences, sdk, simctl } = harness();
    for (const suite of ["../x", "/tmp/x", "foo/bar", "foo\\bar", "a..b"]) {
      await expect(preferences.getPreference({ ...input, suite })).rejects.toThrow(
        "suite must be an identifier",
      );
      await expect(
        preferences.setPreference({ ...input, suite, type: "int", value: 42 }),
      ).rejects.toThrow("suite must be an identifier");
    }
    await expect(
      preferences.getPreference({ ...input, suite: "Standard", appId: "../../escape" }),
    ).rejects.toThrow("identifier");
    expect(sdk.calls).toEqual([]);
    expect(simctl.calls).toEqual([]);
  });
  test("global defaults rejects flag-like domains before simctl", async () => {
    const { preferences, simctl } = harness();
    const global = { scope: "userDefaults", suite: "-flag", key: "k" } as const;
    await expect(preferences.getPreference(global)).rejects.toThrow("must not start with '-'");
    await expect(preferences.setPreference({ ...global, type: "int", value: 42 })).rejects.toThrow(
      "must not start with '-'",
    );
    expect(simctl.calls).toEqual([]);
  });
  test("missing global domain gives appId guidance and separate route", async () => {
    const simctl = new FakeSimCtlClient();
    simctl.setCommandError(
      `spawn ${device.deviceId} defaults read globalSuite k`,
      new Error("Domain 'globalSuite' not found"),
    );
    const preferences = new AppPreferences(device, { simctl, timer: new FakeTimer() });
    const result = await preferences.getPreference({
      scope: "userDefaults",
      suite: "globalSuite",
      key: "k",
    });
    expect(result).toMatchObject({
      found: false,
      resolvedStore: "globalSuite",
      storeRoute: "defaults",
    });
    expect(result.warning).toContain("appId");
  });
});

const fixtureCases = [
  ["integer", "INT", "42", "int", 42],
  ["bigInteger", "INT", "9007199254740993", "int", "9007199254740993"],
  ["real", "DOUBLE", "3", "float", 3],
  ["yes", "BOOLEAN", "true", "bool", true],
  ["no", "BOOLEAN", "false", "bool", false],
  ["string", "STRING", "  C:\\tmp\n", "string", "  C:\\tmp\n"],
  ["unicode", "STRING", "こんにちは 🌈 café", "string", "こんにちは 🌈 café"],
  ["key.with.dots", "STRING", "dotted", "string", "dotted"],
  ["date", "DATE", "2026-10-01T12:34:56.000Z", "date", "2026-10-01T12:34:56.000Z"],
  ["data", "DATA", "aGVsbG8=", "data", "aGVsbG8="],
  ["array", "ARRAY", '[1,"two",true]', "array", '[1,"two",true]'],
  [
    "dictionary",
    "DICTIONARY",
    '{"nested":3,"text":"three"}',
    "dictionary",
    '{"nested":3,"text":"three"}',
  ],
] as const;

describe("real plutil fixtures and route type consistency", () => {
  for (const [origin, xml] of [
    ["XML", fixtureXml],
    ["binary", fixtureBinary],
  ] as const) {
    test(`${origin}-origin fixture preserves all types and exact values`, async () => {
      const values = await parseIosUserDefaultsPlist(xml);
      for (const [key, , , type, value] of fixtureCases) {
        expect(values.get(key)).toEqual({ type, value });
      }
    });
  }
  for (const [key, sdkType, serialized, type, value] of fixtureCases) {
    test(`${key}: SDK/plist/defaults have the same canonical type`, async () => {
      const sdk = harness();
      sdk.sdk.entry = { key, type: sdkType, value: serialized };
      const plist = harness("absent");
      plist.plist.xml = fixtureXml;
      const simctl = new FakeSimCtlClient();
      simctl.setCommandResult(
        `spawn ${device.deviceId} defaults read globalSuite ${key}`,
        `${serialized}\n`,
      );
      const legacyType =
        sdkType === "INT"
          ? "integer"
          : sdkType === "BOOLEAN"
            ? "boolean"
            : sdkType === "DOUBLE"
              ? "float"
              : type;
      simctl.setCommandResult(
        `spawn ${device.deviceId} defaults read-type globalSuite ${key}`,
        `Type is ${legacyType}\n`,
      );
      const defaults = new AppPreferences(device, { simctl, timer: new FakeTimer() });
      expect(await sdk.preferences.getPreference({ ...input, key })).toMatchObject({
        type,
        value,
        storeRoute: "sdk",
      });
      expect(await plist.preferences.getPreference({ ...input, key })).toMatchObject({
        type,
        value,
        storeRoute: "container-plist",
      });
      expect(
        await defaults.getPreference({ scope: "userDefaults", suite: "globalSuite", key }),
      ).toMatchObject({ type, value, resolvedStore: "globalSuite", storeRoute: "defaults" });
    });
  }
  test("FLOAT and DOUBLE share float; UNKNOWN has a lowercase fallback", async () => {
    const { preferences, sdk } = harness();
    for (const sdkType of ["FLOAT", "DOUBLE"] as const) {
      sdk.entry = { key: input.key, type: sdkType, value: "3" };
      expect(await preferences.getPreference(input)).toMatchObject({ type: "float", value: 3 });
    }
    sdk.entry = { key: input.key, type: "UNKNOWN", value: null };
    expect(await preferences.getPreference(input)).toMatchObject({
      found: true,
      type: "unknown",
      value: null,
    });
  });
});

describe("SDK redaction and collection encoding", () => {
  for (const [sdkType, value, type] of [
    ["STRING", IOS_SDK_REDACTED_VALUE, "string"],
    ["STRING", "hunter2", "string"],
    ["INT", "42", "int"],
    ["INT", "not-an-integer", "int"],
  ] as const) {
    test(`${sdkType} explicit redaction flag hides ${value} before parsing`, async () => {
      const { sdk, preferences } = harness();
      sdk.entry = { key: input.key, type: sdkType, value, redacted: true };
      expect(await preferences.getPreference(input)).toMatchObject({
        found: true,
        success: true,
        type,
        value: null,
        redacted: true,
        storeRoute: "sdk",
      });
    });
  }

  test("absent redaction flag preserves a normal SDK value", async () => {
    const { sdk, preferences } = harness();
    sdk.entry = { key: input.key, type: "INT", value: "42" };
    const result = await preferences.getPreference(input);
    expect(result).toMatchObject({ success: true, found: true, type: "int", value: 42 });
    expect(result.redacted).toBeUndefined();
  });

  test("flagged non-sentinel read-back reports written but not compared", async () => {
    const { sdk, preferences, simctl } = harness();
    sdk.onRead = () => {
      sdk.entry = { key: input.key, type: "INT", value: "42", redacted: true };
    };
    const result = await preferences.setPreference({ ...input, type: "int", value: 42 });
    expect(result).toMatchObject({
      success: true,
      found: true,
      type: "int",
      redacted: true,
      value: null,
      verified: false,
    });
    expect(result.warning).toContain(
      "value was written; value redacted by the SDK so not compared",
    );
    expect(sdk.calls.map((call) => call.operation)).toEqual(["set", "get"]);
    expect(simctl.calls).toEqual([]);
  });

  // Mirror StorageTests.swift's date/data and non-finite collection encodings.
  for (const [name, array, dictionary] of [
    [
      "nested date",
      '[{"date":"2023-11-14T22:13:20.123Z"}]',
      '{"outer":[{"date":"2023-11-14T22:13:20.123Z"}]}',
    ],
    [
      "nested data",
      '[{"data":"AQID","date":"2023-11-14T22:13:20.123Z"}]',
      '{"outer":[{"data":"AQID","date":"2023-11-14T22:13:20.123Z"}]}',
    ],
    [
      "non-finite strings",
      '["nan","inf","-inf","nan","inf","-inf"]',
      '{"outer":["nan","inf","-inf"]}',
    ],
  ] as const) {
    for (const [sdkType, type, value] of [
      ["ARRAY", "array", array],
      ["DICTIONARY", "dictionary", dictionary],
    ] as const) {
      test(`new SDK ${sdkType} ${name} retains canonical JSON`, async () => {
        const { sdk, preferences } = harness();
        sdk.entry = { key: input.key, type: sdkType, value };
        const result = await preferences.getPreference(input);
        expect(result).toMatchObject({ value, type, valueFormat: "canonical-json" });
        expect(result.warning).toBeUndefined();
      });
    }
  }

  for (const [type, value] of [
    ["ARRAY", '[{"nested":[9007199254740993]}]'],
    ["DICTIONARY", '{"nested":[[-9223372036854775808]]}'],
  ] as const) {
    test(`${type} nested unsafe integer is exposed as a lossy SDK description`, async () => {
      const { sdk, preferences } = harness();
      sdk.entry = { key: input.key, type, value };
      const result = await preferences.getPreference(input);
      expect(result).toMatchObject({ value, type: "unknown", valueFormat: "sdk-description" });
      expect(result.warning).toContain("unsafe integers");
    });
  }

  test("SDK numeric strings and safe boundary integers remain canonical", async () => {
    const { sdk, preferences } = harness();
    const value =
      '[{"nested":["9007199254740993","\\\"-9223372036854775808",9007199254740991,-9007199254740991,1.5]}]';
    sdk.entry = { key: input.key, type: "ARRAY", value };
    const result = await preferences.getPreference(input);
    expect(result).toMatchObject({ value, type: "array", valueFormat: "canonical-json" });
    expect(result.warning).toBeUndefined();
  });

  for (const [sdkType, type] of [
    ["INT", "int"],
    ["BOOLEAN", "bool"],
    ["DOUBLE", "float"],
    ["STRING", "string"],
  ] as const) {
    test(`${sdkType} sentinel is redacted before conversion`, async () => {
      const { sdk, preferences } = harness();
      sdk.entry = { key: "access_token", type: sdkType, value: IOS_SDK_REDACTED_VALUE };
      expect(await preferences.getPreference({ ...input, key: "access_token" })).toMatchObject({
        found: true,
        success: true,
        type,
        value: null,
        redacted: true,
        storeRoute: "sdk",
      });
    });
  }
  for (const { type, sdkType, value } of typedCases) {
    test(`${sdkType} sensitive write succeeds without comparing redacted read-back`, async () => {
      const { sdk, preferences, simctl } = harness();
      sdk.onRead = () => {
        sdk.entry = { key: "access_token", type: sdkType, value: IOS_SDK_REDACTED_VALUE };
      };
      const result = await preferences.setPreference({
        ...input,
        key: "access_token",
        type,
        value,
      });
      expect(result).toMatchObject({
        success: true,
        found: true,
        redacted: true,
        value: null,
        verified: false,
      });
      expect(result.warning).toContain(
        "value was written; value redacted by the SDK so not compared",
      );
      expect(sdk.calls.map((call) => call.operation)).toEqual(["set", "get"]);
      expect(simctl.calls).toEqual([]);
    });
  }
  test("literal sentinel stays a normal string on container-plist and defaults routes", async () => {
    const plist = harness("absent");
    plist.plist.setValue(IOS_SDK_REDACTED_VALUE, "string");
    const result = await plist.preferences.getPreference(input);
    expect(result).toMatchObject({ value: IOS_SDK_REDACTED_VALUE, type: "string" });
    expect(result.redacted).toBeUndefined();
    const simctl = new FakeSimCtlClient();
    simctl.setCommandResult(
      `spawn ${device.deviceId} defaults read globalSuite ${input.key}`,
      `${IOS_SDK_REDACTED_VALUE}\n`,
    );
    simctl.setCommandResult(
      `spawn ${device.deviceId} defaults read-type globalSuite ${input.key}`,
      "Type is string\n",
    );
    const defaults = new AppPreferences(device, { simctl, timer: new FakeTimer() });
    const global = await defaults.getPreference({
      scope: "userDefaults",
      suite: "globalSuite",
      key: input.key,
    });
    expect(global.value).toBe(IOS_SDK_REDACTED_VALUE);
    expect(global.redacted).toBeUndefined();
  });
  for (const [type, canonicalType, value] of [
    ["ARRAY", "array", '[1,"Optional(date)",true]'],
    ["ARRAY", "array", '["2023-11-14T22:13:20.123Z","AQID"]'],
    ["DICTIONARY", "dictionary", '{"nested":{"data":"aGVsbG8="}}'],
    ["DICTIONARY", "dictionary", '{"data":"AQID","date":"2023-11-14T22:13:20.123Z"}'],
  ] as const) {
    test(`${type} canonical JSON retains collection type`, async () => {
      const { sdk, preferences } = harness();
      sdk.entry = { key: input.key, type, value };
      const result = await preferences.getPreference(input);
      expect(result).toMatchObject({ value, type: canonicalType, valueFormat: "canonical-json" });
      expect(result.warning).toBeUndefined();
    });
  }
  // Constructed from older UserDefaultsInspector.encode's "\(value)" fallback;
  // Swift Array/Dictionary interpolation and Foundation NSDictionary descriptions.
  for (const [type, value] of [
    ["ARRAY", "[2026-10-01 12:34:56 +0000, 5 bytes]"],
    ["DICTIONARY", '["date": 2026-10-01 12:34:56 +0000, "data": 5 bytes]'],
    [
      "DICTIONARY",
      '{ date = "2026-10-01 12:34:56 +0000"; data = {length = 5, bytes = 0x68656c6c6f}; }',
    ],
    ["ARRAY", "[Optional(2026-10-01 12:34:56 +0000)]"],
    ["ARRAY", '{"wrongShape":true}'],
    ["DICTIONARY", "[]"],
  ] as const) {
    test(`${type} constructed-from-Swift-source description/shape ${value} is explicit`, async () => {
      const { sdk, preferences } = harness();
      sdk.entry = { key: input.key, type, value };
      const result = await preferences.getPreference(input);
      expect(result).toMatchObject({ value, type: "unknown", valueFormat: "sdk-description" });
      expect(result.warning).toContain("nested Date/Data");
      expect(result.warning).toContain("container-plist");
    });
  }
});

test("container-plist collections retain nested Date/Data as recursive JSON", async () => {
  const { preferences, plist } = harness("absent");
  plist.xml = buildPlist(
    new Map([
      [input.key, new Map([["leaves", [new Date("2026-10-01T12:34:56Z"), Buffer.from("hello")]]])],
    ]),
  );
  const result = await preferences.getPreference(input);
  expect(result).toMatchObject({
    type: "dictionary",
    value: '{"leaves":["2026-10-01T12:34:56.000Z","aGVsbG8="]}',
    storeRoute: "container-plist",
  });
  expect(result.valueFormat).toBeUndefined();
});

describe("non-finite plist reals", () => {
  for (const [spelling, value] of [
    ["nan", "nan"],
    ["inf", "inf"],
    ["+inf", "inf"],
    ["-inf", "-inf"],
    ["infinity", "inf"],
    ["+infinity", "inf"],
    ["-infinity", "-inf"],
  ]) {
    test(`SDK Double ${spelling} matches plist normalization in any case`, async () => {
      const { sdk, preferences } = harness();
      for (const encoded of [spelling, spelling.toUpperCase()]) {
        sdk.entry = { key: input.key, type: "DOUBLE", value: encoded };
        const result = await preferences.getPreference(input);
        expect(result).toMatchObject({ value, type: "float", storeRoute: "sdk" });
        expect(JSON.parse(JSON.stringify(result)).value).toBe(value);
      }
      await expect(
        preferences.setPreference({ ...input, type: "float", value: spelling }),
      ).rejects.toThrow();
      expect(sdk.calls.every((call) => call.operation === "get")).toBe(true);
    });
  }

  for (const filename of ["non-finite-origin.plist", "non-finite-binary-origin.plist"]) {
    const xml = readFileSync(
      new URL(`../../fixtures/ios-userdefaults-plist/${filename}`, import.meta.url),
      "utf8",
    );
    test(`captured plutil ${filename} preserves non-finite values through JSON`, async () => {
      const values = await parseIosUserDefaultsPlist(xml);
      expect(values.get("nan")).toEqual({ type: "float", value: "nan" });
      expect(values.get("positiveInfinity")).toEqual({ type: "float", value: "inf" });
      expect(values.get("negativeInfinity")).toEqual({ type: "float", value: "-inf" });
      expect(values.get("nested")).toEqual({ type: "array", value: '["nan","inf","-inf"]' });
      const { preferences, plist } = harness("absent");
      plist.xml = xml;
      const result = await preferences.getPreference({ ...input, key: "positiveInfinity" });
      expect(JSON.parse(JSON.stringify(result))).toMatchObject({
        found: true,
        type: "float",
        value: "inf",
      });
    });
  }
  for (const [spelling, value] of [
    ["nan", "nan"],
    ["inf", "inf"],
    ["+inf", "inf"],
    ["-inf", "-inf"],
    ["infinity", "inf"],
    ["+infinity", "inf"],
    ["-infinity", "-inf"],
  ]) {
    test(`constructed real input ${spelling} is canonicalized`, async () => {
      const values = await parseIosUserDefaultsPlist(
        `<plist><dict><key>k</key><real>${spelling}</real></dict></plist>`,
      );
      expect(values.get("k")).toEqual({ type: "float", value });
    });
  }
});

for (const error of [
  new Error("CtrlProxy service port changed"),
  new CtrlProxyServicePortChangedError(),
]) {
  test(`pending SDK read cancelled with ${error.name} falls back; write never does`, async () => {
    const read = harness();
    let rejectRead!: (error: Error) => void;
    const pending = new Promise<KeyValueEntry | null>((_resolve, reject) => {
      rejectRead = reject;
    });
    const get = spyOn(read.sdk, "getPreference").mockImplementation(() => pending);
    try {
      read.plist.setValue(42, "int");
      const result = read.preferences.getPreference(input);
      rejectRead(error);
      expect(await result).toMatchObject({
        value: 42,
        storeRoute: "container-plist",
        warning: expect.stringContaining("may lag a running app"),
      });
      expect(isIosPreferenceSdkUnavailable(error)).toBe(true);
    } finally {
      get.mockRestore();
    }
    const write = harness();
    write.sdk.writeError = error;
    await expect(
      write.preferences.setPreference({ ...input, value: 42, type: "int" }),
    ).rejects.toThrow("may or may not have been applied");
    expect(write.simctl.calls).toEqual([]);
    expect(write.plist.paths).toEqual([]);
  });
}
