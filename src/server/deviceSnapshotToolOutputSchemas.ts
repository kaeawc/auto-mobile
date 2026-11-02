import { z } from "zod/v4";

const commonFields = {
  message: z.string(),
  snapshotName: z.string(),
  snapshotType: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
};

/** `manifest` is owned by the snapshot store (DeviceSnapshotManifest). */
const captureResultSchema = z
  .object({
    ...commonFields,
    timestamp: z.string(),
    manifest: z.record(z.string(), z.unknown()),
    bundleStatuses: z.array(z.unknown()).optional(),
    evictedSnapshotNames: z.array(z.string()).optional(),
  })
  .passthrough();

const restoreResultSchema = z
  .object({
    ...commonFields,
    restoreMode: z.enum(["vm", "settings_only"]).optional(),
    restoreNote: z.string().optional(),
    restoredAt: z.string(),
    deviceSessionUuid: z.string().optional(),
    success: z.boolean(),
    failures: z.array(z.record(z.string(), z.unknown())),
  })
  .passthrough();

const deleteResultSchema = z
  .object({
    message: z.string(),
    snapshotName: z.string(),
    deleted: z.boolean(),
    pendingReclaim: z.literal(true).optional(),
    deviceId: z.string(),
    deviceName: z.string(),
  })
  .passthrough();

/** Capture, restore and delete return different shapes; `success` only appears on restore. */
export const deviceSnapshotResultSchema = z.union([
  captureResultSchema,
  restoreResultSchema,
  deleteResultSchema,
]);
