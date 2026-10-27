import { beforeEach, describe, expect, test } from "bun:test";
import {
  importLegacySessionMutations,
  JournalDeviceSettingDefaultsPersistence,
} from "../../../src/daemon/sessionBroker/mutations/legacyAdapters";
import type { SessionCacheData } from "../../../src/daemon/sessionManager/sessionTypes";
import type { DeviceSettingDefaultsRecord } from "../../../src/models/DeviceSettingDefaults";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { FakeDeviceSettingDefaultsPersistence } from "../../fakes/FakeDeviceSettingDefaults";
import { FakeTimer } from "../../fakes/FakeTimer";

const SCOPE = { sessionUuid: "session-a", deviceId: "phone", incarnation: "generation-1" };
const RECORD: DeviceSettingDefaultsRecord = {
  platform: "android",
  name: "phone",
  sessionId: SCOPE.sessionUuid,
  values: {
    fontScale: 1,
    density: 320,
    nightMode: "light",
    locale: "en-US",
    timeFormat: null,
    calendarSystem: "gregorian",
  },
};

describe("legacy mutation journal adapters", () => {
  let journal: FakeDeviceMutationJournal;
  let legacy: FakeDeviceSettingDefaultsPersistence;

  beforeEach(() => {
    journal = new FakeDeviceMutationJournal(new FakeTimer());
    legacy = new FakeDeviceSettingDefaultsPersistence();
  });

  test("non-broker defaults delegate unchanged without journal entries", async () => {
    const adapter = new JournalDeviceSettingDefaultsPersistence(legacy, journal, () => null);
    await adapter.put(SCOPE.deviceId, RECORD);
    expect(await adapter.get(SCOPE.deviceId)).toEqual(RECORD);
    expect(await journal.list(SCOPE)).toEqual([]);
    await adapter.delete(SCOPE.deviceId);
    expect(await adapter.get(SCOPE.deviceId)).toBeNull();
  });

  test("unobservable journal defaults refuse restoration instead of inventing an absent setting", async () => {
    await legacy.put(SCOPE.deviceId, RECORD);
    await journal.record(SCOPE, {
      kind: "device-setting",
      key: "fontScale",
      priorValue: { state: "unobservable" },
      toolName: "displayConfig",
    });
    const adapter = new JournalDeviceSettingDefaultsPersistence(legacy, journal, () => SCOPE);
    await expect(adapter.get(SCOPE.deviceId)).rejects.toThrow(
      "Unobservable journaled device setting",
    );
    expect(await legacy.get(SCOPE.deviceId)).toEqual(RECORD);
  });

  test("broker defaults record all six originals and read them through the journal", async () => {
    const adapter = new JournalDeviceSettingDefaultsPersistence(legacy, journal, () => SCOPE);
    await adapter.put(SCOPE.deviceId, RECORD);
    expect(await journal.list(SCOPE)).toHaveLength(6);
    expect(
      (await journal.list(SCOPE)).find((entry) => entry.key === "timeFormat")?.priorValue,
    ).toEqual({ state: "absent" });
    await legacy.put(SCOPE.deviceId, { ...RECORD, values: { ...RECORD.values, locale: "fr-FR" } });
    expect(await adapter.get(SCOPE.deviceId)).toEqual(RECORD);
    await adapter.delete(SCOPE.deviceId);
    expect(await journal.list(SCOPE)).toHaveLength(6);
  });

  test("mismatched broker scope is rejected before recording defaults", async () => {
    const adapter = new JournalDeviceSettingDefaultsPersistence(legacy, journal, () => ({
      ...SCOPE,
      deviceId: "other",
    }));
    await expect(adapter.put(SCOPE.deviceId, RECORD)).rejects.toThrow(
      "exact broker session and device",
    );
    expect(await legacy.get(SCOPE.deviceId)).toBeNull();
  });

  test("all six legacy cache restorers preserve typed restore payloads", async () => {
    const cache = {
      keepScreenAwake: {
        applied: true,
        method: "settings" as const,
        originalScreenOffTimeout: "30000",
      },
      biometricEnrollment: { initialEnrollment: "not_enrolled" as const },
      networkCondition: { initialProfile: "none" as const },
      clock: { initialAutomaticTime: 1 as const, clockChangedByUs: true, rootedByUs: false },
      rotation: { accelerometerRotation: 1 as const, userRotation: 0 },
      screenReader: { platform: "ios" as const, previousEnabled: false },
    };
    await importLegacySessionMutations(journal, SCOPE, cache, async () => {});
    const entries = await journal.list(SCOPE);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "keep-awake",
      "biometric-enrollment",
      "network-condition",
      "clock",
      "rotation",
      "screen-reader",
    ]);
    expect(entries[1].priorValue).toEqual({ state: "present", value: "not_enrolled" });
    expect(entries[2].priorValue).toEqual({ state: "present", value: cache.networkCondition });
    expect(entries[3].priorValue).toEqual({ state: "present", value: cache.clock });
    expect(cache.clock.clockChangedByUs).toBe(true);
  });

  test("non-broker cache remains untouched and unapplied keep-awake is not recorded", async () => {
    await importLegacySessionMutations(
      journal,
      null,
      {
        screenReader: { platform: "ios", previousEnabled: false },
      },
      async () => {},
    );
    await importLegacySessionMutations(
      journal,
      SCOPE,
      { keepScreenAwake: { applied: false } },
      async () => {},
    );
    expect(await journal.list(SCOPE)).toEqual([]);
  });

  test("legacy import waits for fenced quiescence before snapshotting mutable state", async () => {
    const cache = {
      clock: { initialAutomaticTime: 1 as const, clockChangedByUs: false, rootedByUs: false },
      networkCondition: {
        initialProfile: "none" as const,
        iosAppRule: { udid: "phone", bundleId: "app", ownerGeneration: 1, lastRevision: 1 },
      },
    };
    await expect(
      importLegacySessionMutations(journal, SCOPE, cache, async () => {
        throw new Error("session still active");
      }),
    ).rejects.toThrow("session still active");
    expect(await journal.list(SCOPE)).toEqual([]);
    await importLegacySessionMutations(journal, SCOPE, cache, async () => {
      cache.clock.clockChangedByUs = true;
      cache.networkCondition.iosAppRule.lastRevision = 3;
    });
    expect((await journal.list(SCOPE)).map((entry) => entry.priorValue)).toEqual([
      { state: "present", value: cache.networkCondition },
      { state: "present", value: cache.clock },
    ]);
  });

  test("reimported mutable metadata cannot silently retain a stale restore payload", async () => {
    const cache = {
      clock: { initialAutomaticTime: 1 as const, clockChangedByUs: false, rootedByUs: false },
    };
    await importLegacySessionMutations(journal, SCOPE, cache, async () => {});
    cache.clock.clockChangedByUs = true;
    await expect(
      importLegacySessionMutations(journal, SCOPE, cache, async () => {}),
    ).rejects.toThrow("reset requires fallback");
    expect(await journal.list(SCOPE)).toHaveLength(1);
  });

  test("reimported iOS rule revisions cannot silently retain stale provider metadata", async () => {
    const cache = {
      networkCondition: {
        initialProfile: "none" as const,
        iosAppRule: { udid: "phone", bundleId: "app", ownerGeneration: 1, lastRevision: 1 },
      },
    };
    await importLegacySessionMutations(journal, SCOPE, cache, async () => {});
    cache.networkCondition.iosAppRule.lastRevision = 2;
    await expect(
      importLegacySessionMutations(journal, SCOPE, cache, async () => {}),
    ).rejects.toThrow("reset requires fallback");
  });

  test("network-condition keeps a stable key when an iOS app rule is added", async () => {
    const cache: Pick<SessionCacheData, "networkCondition"> = {
      networkCondition: { initialProfile: "none" },
    };
    await importLegacySessionMutations(journal, SCOPE, cache, async () => {});
    cache.networkCondition = {
      initialProfile: "none",
      iosAppRule: { udid: "phone", bundleId: "app", ownerGeneration: 1, lastRevision: 1 },
    };
    await expect(
      importLegacySessionMutations(journal, SCOPE, cache, async () => {}),
    ).rejects.toThrow("reset requires fallback");
    expect(await journal.list(SCOPE)).toHaveLength(1);
    expect((await journal.list(SCOPE))[0]).toMatchObject({
      kind: "network-condition",
      key: "device",
    });
  });

  test("clearing a legacy cache slot cannot leave an unverified restore row", async () => {
    const cache: Pick<SessionCacheData, "clock"> = {
      clock: { initialAutomaticTime: 1, clockChangedByUs: false, rootedByUs: false },
    };
    await importLegacySessionMutations(journal, SCOPE, cache, async () => {});
    cache.clock = undefined;
    await expect(
      importLegacySessionMutations(journal, SCOPE, cache, async () => {}),
    ).rejects.toThrow("reset requires fallback");
    expect(await journal.list(SCOPE)).toHaveLength(1);
  });
});
