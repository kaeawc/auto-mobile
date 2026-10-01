import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AppPreferences,
  isIosPreferenceSdkUnavailable,
  type IosPreferenceKeyValueClient,
  type PreferenceValueType,
} from "../../../src/features/preferences/AppPreferences";
import { parseIosUserDefaultsPlist } from "../../../src/features/preferences/IosUserDefaultsPlist";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios/IOSCtrlProxyClient";
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
  new URL("../../fixtures/ios-userdefaults-plist/xml-origin.xml", import.meta.url),
  "utf8",
);
const fixtureBinary = readFileSync(
  new URL("../../fixtures/ios-userdefaults-plist/binary-origin.xml", import.meta.url),
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
  readError?: string;
  writeError?: string;
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
      throw new Error(this.readError);
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
      throw new Error(this.writeError);
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
    if (args[0] === "get_app_container") {
      if (this.containerError) {
        throw new Error(this.containerError);
      }
      return { stdout: `${this.containerPath}\n`, stderr: "" };
    }
    if (args[3] !== "write") {
      throw new Error("Unexpected defaults read");
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

describe("iOS app UserDefaults resolution", () => {
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
            `${container}/Library/Preferences/mt8327Suite`,
            input.key,
            flag,
            String(value),
          ],
        ]);
        expect(plist.paths).toEqual(
          Array(2).fill(`${container}/Library/Preferences/mt8327Suite.plist`),
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
        `${container}/Library/Preferences/${input.appId}.plist`,
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
