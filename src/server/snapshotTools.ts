import {
  deviceSnapshotCaptureArgsShape,
  deviceSnapshotRestoreArgsShape,
} from "../models/deviceSnapshotArgsSchema";
import { toActionableError } from "../models/ActionableError";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { ActionableError, BootedDevice } from "../models";
import { deviceSnapshotResultSchema } from "./deviceSnapshotToolOutputSchemas";
import { addDeviceTargetingToSchema } from "../utils/schemaHelpers";
import { captureDeviceSnapshot, restoreDeviceSnapshot } from "../daemon/deviceSnapshotManager";
import "./DeviceIncarnationInvalidator";

/** Per-call VM snapshot budget: at most 30 minutes, safely below the timer overflow ceiling. */
export { MAX_VM_SNAPSHOT_TIMEOUT_MS } from "../models/deviceSnapshotTimeout";

export const deviceSnapshotSchema = z.discriminatedUnion("action", [
  addDeviceTargetingToSchema(
    z
      .object({
        action: z.literal("capture"),
        ...deviceSnapshotCaptureArgsShape,
      })
      .strict(),
  ),
  addDeviceTargetingToSchema(
    z
      .object({
        action: z.literal("restore"),
        ...deviceSnapshotRestoreArgsShape,
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

        return createStructuredToolResponse({
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

        return createStructuredToolResponse({
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
    {
      handler: deviceSnapshotHandler,
      defaultEnabled: false,
      outputSchema: deviceSnapshotResultSchema,
      changesOpaquePersistentState: true,
    },
  );
}
