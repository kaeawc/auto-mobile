import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { createJSONToolResponse } from "../utils/toolUtils";
import { ActionableError, BootedDevice } from "../models";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { captureDeviceSnapshot, restoreDeviceSnapshot } from "./deviceSnapshotManager";

const snapshotNameRequiredMessage = "snapshotName is required when action is restore";
const optionalSnapshotNameSchema = z.string().min(1).optional().describe("Snapshot name");

const deviceSnapshotCommonShape = {
  includeAppData: z.boolean().optional().describe("Include app data"),
  includeSettings: z.boolean().optional().describe("Include settings"),
  useVmSnapshot: z.boolean().optional().describe("Use emulator VM snapshot"),
  strictBackupMode: z.boolean().optional().describe("Fail if app data backup fails"),
  backupTimeoutMs: z.number().optional().describe("adb backup confirmation timeout ms"),
  userApps: z.enum(["current", "all"]).optional().describe("Apps to back up: current or all"),
  vmSnapshotTimeoutMs: z.number().optional().describe("VM snapshot timeout ms"),
  appBundleIds: z.array(z.string()).optional().describe("iOS bundle IDs for app data snapshot"),
};

export const deviceSnapshotSchema = z.discriminatedUnion("action", [
  addDeviceTargetingToSchema(
    z.object({
      action: z.literal("capture"),
      snapshotName: optionalSnapshotNameSchema,
      ...deviceSnapshotCommonShape,
    }),
  ),
  addDeviceTargetingToSchema(
    z.object({
      action: z.literal("restore"),
      snapshotName: z
        .string({ error: snapshotNameRequiredMessage })
        .min(1, snapshotNameRequiredMessage)
        .describe("Snapshot name"),
      ...deviceSnapshotCommonShape,
    }),
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
          evictedSnapshotNames: evictedSnapshotNames.length > 0 ? evictedSnapshotNames : undefined,
        });
      }

      if (args.action === "restore") {
        if (!args.snapshotName) {
          throw new ActionableError("snapshotName is required when action is restore");
        }
        const { result } = await restoreDeviceSnapshot(device, {
          snapshotName: args.snapshotName,
          useVmSnapshot: args.useVmSnapshot,
          vmSnapshotTimeoutMs: args.vmSnapshotTimeoutMs,
        });

        return createJSONToolResponse({
          message: `Snapshot '${args.snapshotName}' restored successfully`,
          snapshotName: args.snapshotName,
          snapshotType: result.snapshotType,
          restoredAt: result.restoredAt,
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
      throw new ActionableError(`Failed to ${args.action} snapshot: ${error}`);
    }
  };

  ToolRegistry.registerDeviceAware(
    "deviceSnapshot",
    "Capture or restore device snapshot.",
    deviceSnapshotSchema,
    deviceSnapshotHandler,
    { defaultEnabled: false },
  );
}
