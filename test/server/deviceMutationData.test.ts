import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import type {
  GetPreferenceInput,
  PreferenceResult,
} from "../../src/features/preferences/AppPreferences";
import type { KeyValueEntry } from "../../src/features/storage/storageTypes";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import {
  DataMutationPriorReader,
  type MutationDataReaders,
} from "../../src/server/deviceMutationDataPriorReader";
import { DefaultMutationPriorReader } from "../../src/server/deviceMutationPriorReader";
import { SessionDeviceMutationRecording } from "../../src/server/deviceMutationRecording";
import { SessionMutationRecorder } from "../../src/daemon/sessionBroker/mutations/recorder";
import { journaledDeviceHandler } from "../../src/server/pipeline/deviceCallDispatch";
import { FakeDeviceMutationJournal } from "../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

const ANDROID: BootedDevice = { deviceId: "phone", platform: "android", name: "Phone" };
const IOS: BootedDevice = { ...ANDROID, platform: "ios" };
const SCOPE = { sessionUuid: "broker", deviceId: "phone", incarnation: "native-1" };
const STORAGE = { appId: "com.example", name: "settings", key: "enabled" };
const PREFERENCE = {
  scope: "sharedPreferences",
  appId: "com.example",
  suite: "settings",
  key: "enabled",
} satisfies GetPreferenceInput;
const ENTRY = { key: "enabled", type: "BOOLEAN", value: "false" } satisfies KeyValueEntry;

class FakeDataReaders implements MutationDataReaders {
  entries: KeyValueEntry[] = [ENTRY];
  entryCalls: { appId: string; name: string }[] = [];
  preferenceCalls: GetPreferenceInput[] = [];
  entryError?: Error;
  preferenceError?: Error;
  connected = true;
  result: PreferenceResult = {
    success: true,
    deviceId: "phone",
    platform: "android",
    scope: "sharedPreferences",
    key: "enabled",
    found: true,
    value: false,
    type: "bool",
    userId: 0,
  };

  preferencesFor = () => {
    return {
      getPreference: async (input: GetPreferenceInput) => {
        this.preferenceCalls.push(input);
        if (this.preferenceError) {
          throw this.preferenceError;
        }
        return this.result;
      },
    };
  };

  keyValuesFor = () => {
    return this.connected
      ? {
          getPreferenceEntries: async (appId: string, name: string) => {
            this.entryCalls.push({ appId, name });
            if (this.entryError) {
              throw this.entryError;
            }
            return this.entries;
          },
        }
      : undefined;
  };
}

function harness() {
  const readers = new FakeDataReaders();
  const reader = new DataMutationPriorReader(readers);
  const defaultReader = new DefaultMutationPriorReader(
    { read: async () => ({}) },
    undefined,
    undefined,
    undefined,
    undefined,
    { dataReader: reader },
  );
  const journal = new FakeDeviceMutationJournal(new FakeTimer());
  const recording = new SessionDeviceMutationRecording(
    () => new SessionMutationRecorder(journal, SCOPE),
    defaultReader,
  );
  return { readers, reader, defaultReader, journal, recording };
}

describe("data mutation identities", () => {
  test("set/remove and name/fileName aliases share a first-write identity without storing the new value", () => {
    const set = deviceToolMutations("setKeyValue", { ...STORAGE, value: "secret", type: "STRING" });
    expect(set).toEqual(deviceToolMutations("removeKeyValue", STORAGE));
    expect(set).toEqual(
      deviceToolMutations("removeKeyValue", {
        appId: STORAGE.appId,
        fileName: STORAGE.name,
        key: STORAGE.key,
      }),
    );
    expect(set[0].key).not.toContain("secret");
    expect(set).not.toEqual(deviceToolMutations("setKeyValue", { ...STORAGE, userId: 10 }));
    expect(set).not.toEqual(deviceToolMutations("setKeyValue", { ...STORAGE, appId: "com.other" }));
    expect(set).not.toEqual(deviceToolMutations("setKeyValue", { ...STORAGE, name: "other" }));
    expect(set).not.toEqual(deviceToolMutations("clearKeyValueFile", STORAGE));
  });

  test("preference keys preserve scope, app, suite and Android user", () => {
    const original = deviceToolMutations("setPreference", PREFERENCE);
    for (const change of [
      { scope: "systemProperty" },
      { appId: "com.other" },
      { suite: "other" },
      { userId: 10 },
      { key: "other" },
    ]) {
      expect(original).not.toEqual(
        deviceToolMutations("setPreference", { ...PREFERENCE, ...change }),
      );
    }
  });

  test.each(["setKeyValue", "removeKeyValue", "clearKeyValueFile"])(
    "%s merges iOS standard-store aliases without merging Android file names",
    (name) => {
      const standard = deviceToolMutations(name, { ...STORAGE, name: "standard" }, "ios");
      for (const storeName of ["", "standard", "Standard", "STANDARD", STORAGE.appId]) {
        expect(deviceToolMutations(name, { ...STORAGE, name: storeName }, "ios")).toEqual(standard);
        expect(
          deviceToolMutations(
            name,
            { appId: STORAGE.appId, fileName: storeName, key: STORAGE.key },
            "ios",
          ),
        ).toEqual(standard);
      }
      expect(deviceToolMutations(name, STORAGE, "ios")).not.toEqual(standard);
      expect(deviceToolMutations(name, { ...STORAGE, name: "Standard" }, "android")).not.toEqual(
        deviceToolMutations(name, { ...STORAGE, name: "standard" }, "android"),
      );
      expect(deviceToolMutations(name, { ...STORAGE, name: STORAGE.appId }, "android")).not.toEqual(
        deviceToolMutations(name, { ...STORAGE, name: "standard" }, "android"),
      );
    },
  );

  test("UserDefaults standard-suite aliases share an identity, unlike Android selectors", () => {
    const args = { ...PREFERENCE, scope: "userDefaults", suite: undefined };
    const standard = deviceToolMutations("setPreference", args, "ios");
    for (const suite of ["", "Standard", "STANDARD", STORAGE.appId]) {
      expect(deviceToolMutations("setPreference", { ...args, suite }, "ios")).toEqual(standard);
    }
    expect(deviceToolMutations("setPreference", { ...args, suite: "other" }, "ios")).not.toEqual(
      standard,
    );
    for (const name of ["setKeyValue", "setPreference"]) {
      const androidArgs = name === "setKeyValue" ? STORAGE : PREFERENCE;
      expect(deviceToolMutations(name, androidArgs, "android")).not.toEqual(
        deviceToolMutations(name, { ...androidArgs, userId: 0 }, "android"),
      );
    }
    expect(
      deviceToolMutations("setPreference", { ...PREFERENCE, suite: undefined }, "android"),
    ).not.toEqual(
      deviceToolMutations("setPreference", { ...PREFERENCE, suite: "Standard" }, "android"),
    );
  });

  test.each([
    "SELECT * FROM items",
    "-- comment\nSELECT 1",
    "WITH data AS (SELECT 1) SELECT * FROM data",
    "PRAGMA user_version",
  ])("read-only SQL does not journal: %s", (query) => {
    expect(deviceToolMutations("sqlQuery", { query })).toEqual([]);
  });

  test.each([
    "UPDATE items SET value = 1",
    "SELECT 1; DELETE FROM items",
    "PRAGMA user_version = 2",
    "PRAGMA table_info(items)",
    "WITH data AS (SELECT 1) DELETE FROM items",
    "malformed SQL",
  ])("mutating or unproven SQL journals opaque database intent: %s", (query) => {
    expect(
      deviceToolMutations("sqlQuery", { appId: "com.example", databasePath: "db", query }),
    ).toEqual([{ kind: "opaque", key: JSON.stringify(["sql", "com.example", "db"]) }]);
  });

  test("network mock creation and clearing share an opaque scope", () => {
    expect(deviceToolMutations("mockNetwork", { host: "example.com", path: "/" })).toEqual(
      deviceToolMutations("clearMockNetwork", { mockId: "123" }),
    );
  });

  test("log reset includes app/container/path and snapshots distinguish capture from restore", () => {
    expect(
      deviceToolMutations("resetAppLogs", { appId: "com.example", paths: ["a.log", "b.log"] }),
    ).toEqual([
      { kind: "opaque", key: JSON.stringify(["app-logs", "com.example", "documents", "a.log"]) },
      { kind: "opaque", key: JSON.stringify(["app-logs", "com.example", "documents", "b.log"]) },
    ]);
    expect(deviceToolMutations("deviceSnapshot", { action: "capture" })).not.toEqual(
      deviceToolMutations("deviceSnapshot", { action: "restore", snapshotName: "baseline" }),
    );
  });
});

describe("data mutation prior recording", () => {
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test.each([ANDROID, IOS])(
    "key-value reads retain typed present/absent and whole-store priors on $platform",
    async (device) => {
      const { reader, readers } = harness();
      const mutations = [
        ...deviceToolMutations("setKeyValue", STORAGE),
        ...deviceToolMutations("removeKeyValue", { ...STORAGE, key: "missing" }),
        ...deviceToolMutations("clearKeyValueFile", STORAGE),
      ];
      expect(await reader.read(device, mutations)).toEqual([
        { state: "present", value: ENTRY },
        { state: "absent" },
        { state: "present", value: [ENTRY] },
      ]);
      expect(readers.entryCalls).toEqual(Array(3).fill({ appId: "com.example", name: "settings" }));
    },
  );

  test("empty stores are observable, not proof of file absence; deleted entries are absent", async () => {
    const { reader, readers } = harness();
    readers.entries = [{ ...ENTRY, value: null }];
    expect(await reader.read(ANDROID, deviceToolMutations("removeKeyValue", STORAGE))).toEqual([
      { state: "absent" },
    ]);
    expect(await reader.read(ANDROID, deviceToolMutations("clearKeyValueFile", STORAGE))).toEqual([
      { state: "present", value: [] },
    ]);
  });

  test.each([
    { ...ENTRY, redacted: true as const },
    { ...ENTRY, type: "UNKNOWN" as const },
  ])("unreadable selected entries make single-key and store priors unobservable", async (entry) => {
    const { reader, readers } = harness();
    readers.entries = [entry];
    for (const name of ["setKeyValue", "clearKeyValueFile"]) {
      expect(await reader.read(IOS, deviceToolMutations(name, STORAGE))).toEqual([
        { state: "unobservable" },
      ]);
    }
  });

  test("unrelated redaction does not discard a readable selected key", async () => {
    const { reader, readers } = harness();
    readers.entries.push({ key: "secret", type: "STRING", value: null, redacted: true });
    expect(await reader.read(IOS, deviceToolMutations("removeKeyValue", STORAGE))).toEqual([
      { state: "present", value: ENTRY },
    ]);
  });

  test("unconnected SDKs and explicitly user-scoped Android calls have no trustworthy SDK prior", async () => {
    const { reader, readers } = harness();
    expect(
      await reader.read(ANDROID, deviceToolMutations("setKeyValue", { ...STORAGE, userId: 10 })),
    ).toEqual([{ state: "unobservable" }]);
    readers.connected = false;
    expect(await reader.read(IOS, deviceToolMutations("clearKeyValueFile", STORAGE))).toEqual([
      { state: "unobservable" },
    ]);
    expect(readers.entryCalls).toEqual([]);
  });

  test("preferences preserve false and type plus resolved user or store metadata", async () => {
    const { defaultReader, readers } = harness();
    expect(
      await defaultReader.read(
        ANDROID,
        deviceToolMutations("setPreference", { ...PREFERENCE, userId: 0 }),
      ),
    ).toEqual([{ state: "present", value: { value: false, type: "bool", userId: 0 } }]);
    expect(readers.preferenceCalls[0]).toEqual({ ...PREFERENCE, userId: 0 });
    readers.result = {
      ...readers.result,
      platform: "ios",
      scope: "userDefaults",
      userId: undefined,
      storeRoute: "sdk",
      resolvedStore: "standard",
    };
    expect(
      await defaultReader.read(
        IOS,
        deviceToolMutations("setPreference", { ...PREFERENCE, scope: "userDefaults" }),
      ),
    ).toEqual([
      { state: "present", value: { value: false, type: "bool", resolvedStore: "standard" } },
    ]);
  });

  test.each(["", 0, false])(
    "observable scalar preference values do not collapse to absence: %s",
    async (value) => {
      const { reader, readers } = harness();
      readers.result.value = value;
      expect(
        (await reader.read(ANDROID, deviceToolMutations("setPreference", PREFERENCE)))[0],
      ).toMatchObject({ state: "present", value: { value } });
    },
  );

  test("preference absence requires a successful observable read", async () => {
    const { reader, readers } = harness();
    readers.result = { ...readers.result, found: false, value: null };
    expect(await reader.read(ANDROID, deviceToolMutations("setPreference", PREFERENCE))).toEqual([
      { state: "absent" },
    ]);
    readers.result.success = false;
    expect(await reader.read(ANDROID, deviceToolMutations("setPreference", PREFERENCE))).toEqual([
      { state: "unobservable" },
    ]);
  });

  test.each([
    { redacted: true as const },
    { type: "unknown" as const },
    { type: undefined },
    { value: null },
    { valueFormat: "sdk-description" as const },
    { storeRoute: "container-plist" as const },
  ])("redacted, stale or lossy preference reads are unobservable", async (change) => {
    const { reader, readers } = harness();
    Object.assign(readers.result, change);
    expect(
      await reader.read(
        IOS,
        deviceToolMutations("setPreference", { ...PREFERENCE, scope: "userDefaults" }),
      ),
    ).toEqual([{ state: "unobservable" }]);
  });

  test("data reads fail independently and warn without discarding other priors", async () => {
    const { reader, readers } = harness();
    readers.entryError = new Error("provider unavailable");
    expect(
      await reader.read(ANDROID, [
        ...deviceToolMutations("setKeyValue", STORAGE),
        ...deviceToolMutations("setPreference", PREFERENCE),
      ]),
    ).toEqual([
      { state: "unobservable" },
      { state: "present", value: { value: false, type: "bool", userId: 0 } },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "Device data prior-value read failed; recording an unobservable prior",
      readers.entryError,
    );
  });

  test.each(["setKeyValue", "removeKeyValue", "clearKeyValueFile", "setPreference"])(
    "%s records trustworthy prior before action and retains first-write wins",
    async (name) => {
      const { recording, journal, readers } = harness();
      const args = name === "setPreference" ? PREFERENCE : STORAGE;
      const expected =
        name === "setPreference"
          ? { value: false, type: "bool", userId: 0 }
          : name === "clearKeyValueFile"
            ? [ENTRY]
            : ENTRY;
      const handler = journaledDeviceHandler(
        name,
        async () => {
          expect((await journal.list(SCOPE))[0].priorValue).toEqual({
            state: "present",
            value: expected,
          });
          readers.entries = [];
          readers.result.value = true;
          return { content: [] };
        },
        recording,
      );
      await handler(ANDROID, { ...args, sessionUuid: "broker" });
      await handler(ANDROID, { ...args, sessionUuid: "broker" });
      expect(readers.entryCalls.length + readers.preferenceCalls.length).toBe(1);
    },
  );

  test.each(["setKeyValue", "setPreference"])(
    "%s preserves the original prior across iOS standard-store aliases",
    async (name) => {
      const { recording, journal, readers } = harness();
      const handler = journaledDeviceHandler(
        name,
        async () => {
          readers.entries = [];
          readers.result.value = true;
          return { content: [] };
        },
        recording,
      );
      for (const alias of [undefined, "", "standard", "Standard", STORAGE.appId]) {
        const args =
          name === "setKeyValue"
            ? { ...STORAGE, name: alias ?? "standard" }
            : { ...PREFERENCE, scope: "userDefaults", suite: alias };
        await handler(IOS, { ...args, sessionUuid: "broker" });
      }
      expect(await journal.list(SCOPE)).toHaveLength(1);
      expect((await journal.list(SCOPE))[0].priorValue).toEqual({
        state: "present",
        value: name === "setKeyValue" ? ENTRY : { value: false, type: "bool", userId: 0 },
      });
      expect(readers.entryCalls.length + readers.preferenceCalls.length).toBe(1);
    },
  );

  test("a failed preference read records unobservable before proceeding", async () => {
    const { recording, journal, readers } = harness();
    readers.preferenceError = new Error("cannot observe");
    let acted = false;
    await journaledDeviceHandler(
      "setPreference",
      async () => {
        expect((await journal.list(SCOPE))[0].priorValue).toEqual({ state: "unobservable" });
        acted = true;
        return { content: [] };
      },
      recording,
    )(ANDROID, { ...PREFERENCE, sessionUuid: "broker" });
    expect(acted).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  test("opaque data/provider tools never read data priors", async () => {
    const { reader, readers } = harness();
    expect(await reader.read(ANDROID, deviceToolMutations("mockNetwork", {}))).toEqual([
      { state: "unobservable" },
    ]);
    expect(readers.entryCalls).toEqual([]);
    expect(readers.preferenceCalls).toEqual([]);
  });

  test("malformed data identity JSON records an unobservable prior", async () => {
    const { reader, readers } = harness();
    const [mutation] = deviceToolMutations("setPreference", PREFERENCE);
    expect(await reader.read(ANDROID, [{ ...mutation, key: "{" }])).toEqual([
      { state: "unobservable" },
    ]);
    expect(readers.entryCalls).toEqual([]);
    expect(readers.preferenceCalls).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "Invalid device data mutation identity; recording an unobservable prior",
      expect.any(Error),
    );
  });

  test("cancellation during a data read prevents recording and action", async () => {
    const { journal } = harness();
    const controller = new AbortController();
    const pending = Promise.withResolvers<KeyValueEntry[]>();
    const recording = new SessionDeviceMutationRecording(
      () => new SessionMutationRecorder(journal, SCOPE),
      new DataMutationPriorReader({
        keyValuesFor: () => ({
          getPreferenceEntries: () => {
            controller.abort(new Error("cancelled"));
            return pending.promise;
          },
        }),
      }),
    );
    let acted = false;
    await expect(
      journaledDeviceHandler(
        "setKeyValue",
        async () => {
          acted = true;
          return { content: [] };
        },
        recording,
      )(ANDROID, { ...STORAGE, sessionUuid: "broker" }, undefined, controller.signal),
    ).rejects.toThrow("cancelled");
    pending.resolve([]);
    expect(acted).toBe(false);
    expect(await journal.list(SCOPE)).toEqual([]);
  });
});
