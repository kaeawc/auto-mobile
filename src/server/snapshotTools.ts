import { MAX_VM_SNAPSHOT_TIMEOUT_MS } from "../features/snapshot/deviceSnapshotTimeout";
import { toActionableError } from "../models/ActionableError";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { createJSONToolResponse } from "../utils/toolUtils";
import { ActionableError, BootedDevice } from "../models";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { captureDeviceSnapshot, restoreDeviceSnapshot } from "./deviceSnapshotManager";

/** Per-call VM snapshot budget: at most 30 minutes, safely below the timer overflow ceiling. */
export { MAX_VM_SNAPSHOT_TIMEOUT_MS } from "../features/snapshot/deviceSnapshotTimeout";

const snapshotNameRequiredMessage = "snapshotName is required when action is restore";
const optionalSnapshotNameSchema = z.string().min(1).optional().describe("Snapshot name");

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

export const deviceSnapshotSchema = z.discriminatedUnion("action", [
  addDeviceTargetingToSchema(
    z
      .object({
        action: z.literal("capture"),
        snapshotName: optionalSnapshotNameSchema,
        ...deviceSnapshotCommonShape,
      })
      .strict(),
  ),
  addDeviceTargetingToSchema(
    z
      .object({
        action: z.literal("restore"),
        snapshotName: z
          .string({ error: snapshotNameRequiredMessage })
          .min(1, snapshotNameRequiredMessage)
          .describe("Snapshot name"),
        ...deviceSnapshotCommonShape,
      })
      .strict(),
  ),
]);

export type DeviceSnapshotToolArgs = z.infer<typeof deviceSnapshotSchema>;

export function registerSnapshotTools() {
  const deviceSnapshotHandler = async (device: BootedDevice, args: DeviceSnapshotToolArgs) => {
    try {
      if (args.action === "capture") {
        const { result, evictedSnapshotNames } = await captureDeviceSnapshot(device, args);

        return createJSONToolResponse({
          message: `Snapshot '${result.snapshotName}' captured successfully`,
          snapshotName: result.snapshotName,
          snapshotType: result.snapshotType,
          timestamp: result.timestamp,
          deviceId: device.deviceId,
          deviceName: device.name,
          manifest: result.manifest,
          // Surface iOS per-bundle capture status at the top level so callers
          // don't have to dig into the manifest to see what was actually
          // captured vs skipped/not-installed (issue #5712).
          bundleStatuses: result.manifest.appDataBackup?.bundleStatuses,
          evictedSnapshotNames: evictedSnapshotNames.length > 0 ? evictedSnapshotNames : undefined,
        });
      }

      if (args.action === "restore") {
        if (!args.snapshotName) {
          throw new ActionableError("snapshotName is required when action is restore");
        }
        const { result, deviceSessionUuid } = await restoreDeviceSnapshot(device, {
          snapshotName: args.snapshotName,
          useVmSnapshot: args.useVmSnapshot,
          vmSnapshotTimeoutMs: args.vmSnapshotTimeoutMs,
        });
        const failures = result.failures ?? [];
        const success = result.success !== false && failures.length === 0;

        return createJSONToolResponse({
          message: success
            ? `Snapshot '${args.snapshotName}' restored successfully`
            : `Snapshot '${args.snapshotName}' partially restored: ${failures.length} item(s) failed`,
          snapshotName: args.snapshotName,
          snapshotType: result.snapshotType,
          restoreMode: result.restoreMode,
          restoreNote: result.restoreNote,
          restoredAt: result.restoredAt,
          ...(deviceSessionUuid ? { deviceSessionUuid } : {}),
          success,
          failures,
          deviceId: device.deviceId,
          deviceName: device.name,
        });
      }

      // Exhaustive over the discriminated union (args is `never` here); kept
      // as a runtime guard for callers that bypass schema validation.
      throw new ActionableError(
        `Unsupported deviceSnapshot action: ${(args as { action: string }).action}`,
      );
    } catch (error) {
      throw toActionableError(error, `Failed to ${args.action} snapshot`);
    }
  };

  ToolRegistry.registerDeviceAware(
    "deviceSnapshot",
    "Capture or restore device snapshot. An Android VM restore in daemon mode returns the new deviceSessionUuid; the previous device-session UUID is superseded by the restore.",
    deviceSnapshotSchema,
    deviceSnapshotHandler,
    { defaultEnabled: false },
  );
}
