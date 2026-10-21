import { expect, test } from "bun:test";
import {
  deviceSnapshotIncarnationInvalidator,
  registerDeviceSnapshotIncarnationInvalidator,
  type DeviceIncarnationInvalidator,
} from "../../src/daemon/deviceSnapshotIncarnationInvalidator";
import type { BootedDevice } from "../../src/models";

test("snapshot incarnation port is safe before server registration and resolves late registrations", async () => {
  const device: BootedDevice = { deviceId: "snapshot-port", name: "Snapshot", platform: "android" };
  const port = deviceSnapshotIncarnationInvalidator;
  await port.prepareForIncarnationChange(device);
  expect(await port.invalidate(device)).toBeUndefined();
  await port.settleIncarnationChange(device, { ready: true });

  const calls: string[] = [];
  const fake: DeviceIncarnationInvalidator = {
    prepareForIncarnationChange: async (target) => {
      calls.push(`prepare:${target.deviceId}`);
    },
    invalidate: async (target) => {
      calls.push(`invalidate:${target.deviceId}`);
      return "epoch";
    },
    settleIncarnationChange: async (target, outcome) => {
      calls.push(`settle:${target.deviceId}:${outcome.ready}`);
    },
  };
  const restore = registerDeviceSnapshotIncarnationInvalidator(fake);
  try {
    await port.prepareForIncarnationChange(device);
    expect(await port.invalidate(device)).toBe("epoch");
    const restoreNested = registerDeviceSnapshotIncarnationInvalidator({
      ...fake,
      invalidate: async () => "nested",
    });
    try {
      expect(await port.invalidate(device)).toBe("nested");
    } finally {
      restoreNested();
    }
    expect(await port.invalidate(device)).toBe("epoch");
    await port.settleIncarnationChange(device, { ready: false });
    expect(calls).toEqual([
      "prepare:snapshot-port",
      "invalidate:snapshot-port",
      "invalidate:snapshot-port",
      "settle:snapshot-port:false",
    ]);
  } finally {
    restore();
  }
  expect(await port.invalidate(device)).toBeUndefined();
});
