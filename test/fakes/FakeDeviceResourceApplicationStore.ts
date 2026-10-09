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
    return this.records.get(simulatorResourceIdentityKey(identity)) ?? null;
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
