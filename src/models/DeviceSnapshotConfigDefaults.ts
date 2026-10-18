import type { DeviceSnapshotConfig } from "./DeviceSnapshot";
import { DEFAULT_VM_SNAPSHOT_TIMEOUT_MS } from "./deviceSnapshotTimeout";

export const DEFAULT_DEVICE_SNAPSHOT_CONFIG: DeviceSnapshotConfig = {
  includeAppData: true,
  includeSettings: true,
  useVmSnapshot: true,
  strictBackupMode: false,
  vmSnapshotTimeoutMs: DEFAULT_VM_SNAPSHOT_TIMEOUT_MS,
  maxVmSnapshotsPerAvd: 3,
  // Real Android VM snapshots routinely measure around 2 GB. A MB-scale
  // default would reject every capture, while a huge one would not guard
  // storage, so count retention is the default guardrail; this is opt-in.
  maxVmArchiveSizeMb: undefined,
  maxArchiveSizeMb: 100,
};
