import type {
  DeviceResourceApplicationRecord,
  SimulatorResourceIdentity,
} from "../../src/models/DeviceResourceReconciliation";
import {
  simulatorResourceIdentityKey,
  type DeviceResourceApplicationStore,
} from "../../src/utils/deviceResourceApplicationStore";

export class FakeDeviceResourceApplicationStore implements DeviceResourceApplicationStore {
  readonly records = new Map<string, DeviceResourceApplicationRecord>();
  writes = 0;
  failWrites = false;

  async get(identity: SimulatorResourceIdentity): Promise<DeviceResourceApplicationRecord | null> {
    const stored = this.records.get(simulatorResourceIdentityKey(identity));
    // Like the SQLite row, every read is a fresh copy; callers cannot mutate stored state.
    return stored ? { ...structuredClone(stored), identity } : null;
  }

  async put(record: DeviceResourceApplicationRecord): Promise<void> {
    this.writes++;
    if (this.failWrites) {
      throw new Error("database is locked");
    }
    this.records.set(simulatorResourceIdentityKey(record.identity), structuredClone(record));
  }

  async delete(identity: SimulatorResourceIdentity): Promise<void> {
    this.writes++;
    this.records.delete(simulatorResourceIdentityKey(identity));
  }
}
