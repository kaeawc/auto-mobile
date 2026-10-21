import { z } from "zod/v4";
import { MAX_VM_SNAPSHOT_TIMEOUT_MS } from "./deviceSnapshotTimeout";

/**
 * Wire-argument shapes of the `deviceSnapshot` tool, shared by the server tool schema
 * (src/server/snapshotTools.ts adds the `action` discriminator and device targeting) and the
 * daemon snapshot manager, whose argument types are derived from these shapes so they cannot
 * drift from the zod-validated input (#14525). They live in the models leaf because the daemon
 * tier may not import from src/server.
 */
const snapshotNameRequiredMessage = "snapshotName is required when action is restore";

const deviceSnapshotCommonShape = {
  includeAppData: z
    .boolean()
    .optional()
    .describe(
      "Include app data (iOS app containers; ignored on non-VM Android, which is settings-only)",
    ),
  includeSettings: z.boolean().optional().describe("Include settings"),
  useVmSnapshot: z.boolean().optional().describe("Use emulator VM snapshot"),
  strictBackupMode: z
    .boolean()
    .optional()
    .describe(
      "iOS-only: fail the whole snapshot unless every requested bundle is backed up (all-or-nothing)",
    ),
  vmSnapshotTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_VM_SNAPSHOT_TIMEOUT_MS)
    .optional()
    .describe(
      "VM snapshot timeout in milliseconds (positive integer; maximum 1800000 ms / 30 minutes)",
    ),
  appBundleIds: z.array(z.string()).optional().describe("iOS bundle IDs for app data snapshot"),
};

export const deviceSnapshotCaptureArgsShape = {
  snapshotName: z.string().min(1).optional().describe("Snapshot name"),
  ...deviceSnapshotCommonShape,
};

export const deviceSnapshotRestoreArgsShape = {
  snapshotName: z
    .string({ error: snapshotNameRequiredMessage })
    .min(1, snapshotNameRequiredMessage)
    .describe("Snapshot name"),
  ...deviceSnapshotCommonShape,
};

const deviceSnapshotCaptureArgsSchema = z.object(deviceSnapshotCaptureArgsShape);
const deviceSnapshotRestoreArgsSchema = z.object(deviceSnapshotRestoreArgsShape);

/** Capture options as validated by the `deviceSnapshot` tool's `capture` action. */
export type DeviceSnapshotCaptureArgs = z.output<typeof deviceSnapshotCaptureArgsSchema>;

/** The restore options the snapshot manager reads from the validated `restore` action. */
export type DeviceSnapshotRestoreArgs = Pick<
  z.output<typeof deviceSnapshotRestoreArgsSchema>,
  "snapshotName" | "useVmSnapshot" | "vmSnapshotTimeoutMs"
>;
