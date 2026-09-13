import type { DeviceSnapshotConfig, DeviceSnapshotConfigInput } from "../../models";

export const DEFAULT_DEVICE_SNAPSHOT_CONFIG: DeviceSnapshotConfig = {
  includeAppData: true,
  includeSettings: true,
  useVmSnapshot: true,
  strictBackupMode: false,
  vmSnapshotTimeoutMs: 30000,
  maxVmSnapshotsPerAvd: 3,
  // Real Android VM snapshots routinely measure around 2 GB. A MB-scale
  // default would reject every capture, while a huge one would not guard
  // storage, so count retention is the default guardrail; this is opt-in.
  maxVmArchiveSizeMb: undefined,
  maxArchiveSizeMb: 100,
};

function parseBoolean(value: boolean | string | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return fallback;
}

function parsePositiveNumber(
  value: number | string | undefined,
  fallback: number,
  allowFloat: boolean,
): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  // Apply rounding before the final positivity check: a positive input in
  // (0, 0.5) rounds to 0 for integer fields, which would violate the
  // positive-number contract and break idempotence (parse(parse(x)) !== parse(x)).
  const result = allowFloat ? parsed : Math.round(parsed);
  return result > 0 ? result : fallback;
}

function parseOptionalPositiveNumber(
  value: number | string | undefined,
  allowFloat: boolean,
): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  // Keep the required-field parser's rounding-before-final-positivity contract:
  // a positive fractional integer field that rounds to zero is not valid.
  const result = allowFloat ? parsed : Math.round(parsed);
  return result > 0 ? result : undefined;
}

export function parseDeviceSnapshotConfig(
  input: DeviceSnapshotConfigInput | null | undefined,
): DeviceSnapshotConfig {
  const safeInput: DeviceSnapshotConfigInput = input && typeof input === "object" ? input : {};

  return {
    includeAppData: parseBoolean(
      safeInput.includeAppData,
      DEFAULT_DEVICE_SNAPSHOT_CONFIG.includeAppData,
    ),
    includeSettings: parseBoolean(
      safeInput.includeSettings,
      DEFAULT_DEVICE_SNAPSHOT_CONFIG.includeSettings,
    ),
    useVmSnapshot: parseBoolean(
      safeInput.useVmSnapshot,
      DEFAULT_DEVICE_SNAPSHOT_CONFIG.useVmSnapshot,
    ),
    strictBackupMode: parseBoolean(
      safeInput.strictBackupMode,
      DEFAULT_DEVICE_SNAPSHOT_CONFIG.strictBackupMode,
    ),
    vmSnapshotTimeoutMs: parsePositiveNumber(
      safeInput.vmSnapshotTimeoutMs,
      DEFAULT_DEVICE_SNAPSHOT_CONFIG.vmSnapshotTimeoutMs,
      false,
    ),
    maxVmSnapshotsPerAvd: parsePositiveNumber(
      safeInput.maxVmSnapshotsPerAvd,
      DEFAULT_DEVICE_SNAPSHOT_CONFIG.maxVmSnapshotsPerAvd,
      false,
    ),
    maxVmArchiveSizeMb: parseOptionalPositiveNumber(safeInput.maxVmArchiveSizeMb, true),
    maxArchiveSizeMb: parsePositiveNumber(
      safeInput.maxArchiveSizeMb,
      DEFAULT_DEVICE_SNAPSHOT_CONFIG.maxArchiveSizeMb,
      true,
    ),
  };
}
