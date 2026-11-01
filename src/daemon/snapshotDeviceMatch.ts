import { ActionableError, type BootedDevice } from "../models";
import type { DeviceSnapshotRecord } from "../db/deviceSnapshotRepository";

function snapshotMatchesDevice(record: DeviceSnapshotRecord, device: BootedDevice): boolean {
  if (record.platform !== device.platform) {
    return false;
  }

  if (device.platform === "ios") {
    return record.deviceId === device.deviceId;
  }

  const targetIsEmulator = device.deviceId.startsWith("emulator-");
  const recordIsEmulator = record.deviceId.startsWith("emulator-");
  if (!targetIsEmulator) {
    return record.deviceId === device.deviceId;
  }

  // Emulator serials are reassigned between sessions, so the AVD name is a
  // compatible identity. A different AVD name is a conflict even if an old
  // emulator serial happens to match the current one.
  return (
    (recordIsEmulator && record.deviceName === device.name) ||
    (record.deviceId.length === 0 && record.deviceName === device.name) ||
    (record.deviceId === device.deviceId && record.deviceName.length === 0)
  );
}

export function assertSnapshotMatchesDevice(
  record: DeviceSnapshotRecord,
  device: BootedDevice,
): void {
  if (snapshotMatchesDevice(record, device)) {
    return;
  }

  const snapshotOwner = `${record.platform} device '${record.deviceName || "unknown"}' (${record.deviceId || "unknown ID"})`;
  const target = `${device.platform} device '${device.name}' (${device.deviceId})`;
  throw new ActionableError(
    `Snapshot '${record.snapshotName}' belongs to ${snapshotOwner} and cannot be restored to ${target}. ` +
      "Restore it on its original device or capture a snapshot for the target device.",
  );
}
