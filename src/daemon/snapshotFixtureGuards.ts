import type { BootedDevice } from "../models";
import type {
  DeviceSnapshotCaptureArgs,
  DeviceSnapshotRestoreArgs,
} from "../models/deviceSnapshotArgsSchema";
import type { FixtureIdentity } from "../models/FixtureIdentity";
import { SnapshotFixtureRefusedError } from "../models/SnapshotFixtureRefusedError";
import type { DeviceSnapshotRecord } from "../db/deviceSnapshotRepository";
import {
  checkFixtureValidity,
  type FixtureIdentityProbe,
} from "../features/snapshot/fixtureIdentity";

function isEmulatorVmCapture(device: BootedDevice, useVmSnapshot: boolean): boolean {
  return device.platform === "android" && device.deviceId.startsWith("emulator-") && useVmSnapshot;
}

/**
 * The identity a fixture capture records (#14065), read before the capture so an AVD whose identity
 * cannot be read is refused without saving anything. Only an Android emulator VM snapshot can be a
 * fixture: nothing else restores the whole device state the identity describes.
 */
export async function readFixtureIdentityForCapture(
  capture: {
    device: BootedDevice;
    snapshotName: string;
    useVmSnapshot: boolean;
    fixture: DeviceSnapshotCaptureArgs["fixture"];
  },
  probe: FixtureIdentityProbe,
): Promise<FixtureIdentity | undefined> {
  const { device, snapshotName, useVmSnapshot, fixture } = capture;
  if (!fixture) {
    return undefined;
  }
  if (!isEmulatorVmCapture(device, useVmSnapshot)) {
    throw new SnapshotFixtureRefusedError(
      "fixture_requires_vm_snapshot",
      snapshotName,
      `Snapshot '${snapshotName}' cannot be a fixture: fixtures are Android emulator VM snapshots ` +
        "only. Capture on an emulator without useVmSnapshot: false.",
    );
  }
  return probe.currentIdentity(device.name);
}

/**
 * Refuse a reload that would load a fixture built for a different AVD state (#14065). A snapshot
 * with a recorded identity is checked on every reload; `fixture: true` also requires that it has
 * one, and that the restore loads the VM state.
 */
export async function assertFixtureReloadable(
  record: DeviceSnapshotRecord,
  args: DeviceSnapshotRestoreArgs,
  useVmSnapshot: boolean,
  probe: FixtureIdentityProbe,
): Promise<void> {
  const recorded = record.manifest.fixture;
  if (args.fixture && !recorded) {
    throw new SnapshotFixtureRefusedError(
      "snapshot_not_a_fixture",
      record.snapshotName,
      `Snapshot '${record.snapshotName}' was not captured as a fixture. Capture it again with fixture: true.`,
    );
  }
  if (!recorded || !useVmSnapshot) {
    if (args.fixture) {
      throw new SnapshotFixtureRefusedError(
        "fixture_requires_vm_snapshot",
        record.snapshotName,
        `Fixture '${record.snapshotName}' reloads its VM snapshot; restore it without useVmSnapshot: false.`,
      );
    }
    return;
  }
  const validity = await checkFixtureValidity(recorded, probe);
  if (!validity.valid) {
    throw new SnapshotFixtureRefusedError(
      "fixture_invalidated",
      record.snapshotName,
      `Fixture '${record.snapshotName}' no longer matches AVD '${recorded.avdName}' ` +
        `(${validity.reasons.join(", ")}). Capture it again with fixture: true.`,
      validity.reasons,
    );
  }
}
