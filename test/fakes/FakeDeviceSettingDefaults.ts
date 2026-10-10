import type { BootedDevice } from "../../src/models";
import type {
  DeviceSettingDefaultsPersistence,
  DeviceSettingDefaultsRecord,
  DeviceSettingKey,
  DeviceSettingValues,
  DeviceSettingsAccess,
} from "../../src/features/utility/DeviceSettingDefaults";

/** In-memory device-setting defaults store (#11145). */
export class FakeDeviceSettingDefaultsPersistence implements DeviceSettingDefaultsPersistence {
  readonly records = new Map<string, DeviceSettingDefaultsRecord>();
  async get(deviceId: string) {
    return this.records.get(deviceId) ?? null;
  }
  async put(deviceId: string, record: DeviceSettingDefaultsRecord) {
    this.records.set(deviceId, structuredClone(record));
  }
  async delete(deviceId: string) {
    this.records.delete(deviceId);
  }
}

/** A device whose settings live in a map; `failing` keys refuse writes. */
export class FakeDeviceSettings implements DeviceSettingsAccess {
  readonly writes: DeviceSettingValues[] = [];
  readonly failing = new Set<DeviceSettingKey>();
  constructor(readonly current: DeviceSettingValues) {}
  async read(_device: BootedDevice, keys: readonly DeviceSettingKey[]) {
    return Object.fromEntries(
      keys.filter((key) => key in this.current).map((key) => [key, this.current[key]]),
    ) as DeviceSettingValues;
  }
  async write(_device: BootedDevice, values: DeviceSettingValues) {
    this.writes.push({ ...values });
    const written = (Object.keys(values) as DeviceSettingKey[]).filter(
      (key) => !this.failing.has(key),
    );
    for (const key of written) {
      this.current[key] = values[key];
    }
    return written;
  }
}
