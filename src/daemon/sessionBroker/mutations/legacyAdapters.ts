import { isDeepStrictEqual } from "node:util";
import { ActionableError } from "../../../models/ActionableError";
import {
  DEVICE_SETTING_KEYS,
  type DeviceSettingDefaultsPersistence,
  type DeviceSettingDefaultsRecord,
} from "../../../models/DeviceSettingDefaults";
import type { SessionCacheData } from "../../sessionManager/sessionTypes";
import { mutationValueSchema, type DeviceMutationJournal, type DeviceMutationScope } from "./types";

export async function importLegacySessionMutations(
  journal: Pick<DeviceMutationJournal, "record" | "list">,
  scope: DeviceMutationScope | null,
  cache: Pick<
    SessionCacheData,
    | "keepScreenAwake"
    | "biometricEnrollment"
    | "networkCondition"
    | "clock"
    | "rotation"
    | "screenReader"
  >,
  assertQuiesced: () => Promise<void>,
): Promise<void> {
  if (!scope) {
    return;
  }
  await assertQuiesced();
  cache = structuredClone(cache);
  const values = [
    {
      kind: "keep-awake",
      value: cache.keepScreenAwake?.applied ? cache.keepScreenAwake : undefined,
    },
    { kind: "biometric-enrollment", value: cache.biometricEnrollment?.initialEnrollment },
    { kind: "network-condition", value: cache.networkCondition },
    { kind: "clock", value: cache.clock },
    { kind: "rotation", value: cache.rotation },
    { kind: "screen-reader", value: cache.screenReader },
  ];
  const mutations = values
    .filter((entry) => entry.value !== undefined)
    .map((entry) => ({
      kind: entry.kind,
      key: "device",
      priorValue: mutationValueSchema.parse({
        state: "present",
        value: JSON.parse(JSON.stringify(entry.value)),
      }),
      toolName: "legacy-session-cache",
    }));
  const existing = await journal.list(scope);
  for (const previous of existing.filter((entry) => entry.toolName === "legacy-session-cache")) {
    if (
      !mutations.some(
        (mutation) => mutation.kind === previous.kind && mutation.key === previous.key,
      )
    ) {
      throw new ActionableError(
        "Legacy mutation import changed after quiescence; reset requires fallback",
      );
    }
  }
  for (const mutation of mutations) {
    const previous = existing.find(
      (entry) => entry.kind === mutation.kind && entry.key === mutation.key,
    );
    if (previous && !isDeepStrictEqual(previous.priorValue, mutation.priorValue)) {
      throw new ActionableError(
        "Legacy mutation import changed after quiescence; reset requires fallback",
      );
    }
  }
  for (const mutation of mutations) {
    await assertQuiesced();
    await journal.record(scope, mutation);
  }
}

export class JournalDeviceSettingDefaultsPersistence implements DeviceSettingDefaultsPersistence {
  constructor(
    private readonly legacy: DeviceSettingDefaultsPersistence,
    private readonly journal: Pick<DeviceMutationJournal, "record" | "list">,
    private readonly scopeOf: (deviceId: string, sessionUuid: string) => DeviceMutationScope | null,
  ) {}

  async get(deviceId: string): Promise<DeviceSettingDefaultsRecord | null> {
    const record = await this.legacy.get(deviceId);
    if (!record) {
      return null;
    }
    const scope = this.scope(deviceId, record.sessionId);
    if (!scope) {
      return record;
    }
    const values = { ...record.values };
    for (const entry of await this.journal.list(scope)) {
      const key = DEVICE_SETTING_KEYS.find((setting) => setting === entry.key);
      if (entry.kind !== "device-setting" || key === undefined || !(key in values)) {
        continue;
      }
      if (entry.priorValue.state === "absent") {
        values[key] = null;
      } else if (entry.priorValue.state === "unobservable") {
        throw new ActionableError(`Unobservable journaled device setting ${key}`);
      } else {
        const value = entry.priorValue.value;
        if (value !== null && typeof value !== "string" && typeof value !== "number") {
          throw new ActionableError(`Invalid journaled device setting ${key}`);
        }
        values[key] = value;
      }
    }
    return { ...record, values };
  }

  async put(deviceId: string, record: DeviceSettingDefaultsRecord): Promise<void> {
    const scope = this.scope(deviceId, record.sessionId);
    if (scope) {
      for (const key of DEVICE_SETTING_KEYS) {
        const value = record.values[key];
        if (value !== undefined) {
          await this.journal.record(scope, {
            kind: "device-setting",
            key,
            priorValue: value === null ? { state: "absent" } : { state: "present", value },
            toolName: "legacy-device-setting-defaults",
          });
        }
      }
    }
    await this.legacy.put(deviceId, record);
  }

  delete(deviceId: string): Promise<void> {
    return this.legacy.delete(deviceId);
  }

  private scope(deviceId: string, sessionUuid: string): DeviceMutationScope | null {
    const scope = this.scopeOf(deviceId, sessionUuid);
    if (scope && (scope.deviceId !== deviceId || scope.sessionUuid !== sessionUuid)) {
      throw new ActionableError(
        "Legacy restoration must resolve the exact broker session and device",
      );
    }
    return scope;
  }
}
