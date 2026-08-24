import { ToolRegistry } from "./toolRegistry";
import { createJSONToolResponse } from "../utils/toolUtils";
import type { BootedDevice } from "../models";
import { getSharedStorageService } from "./sharedStorageService";
import { stageSharedStorageSchema, type StageSharedStorageArgs } from "./sharedStorageContract";

export function registerSharedStorageTools(): void {
  ToolRegistry.registerDeviceAware(
    "stageSharedStorageFixtures",
    "Stage files in an isolated Android Download namespace for system picker workflows.",
    stageSharedStorageSchema,
    async (device: BootedDevice, args: StageSharedStorageArgs, _progress, signal) =>
      createJSONToolResponse(await getSharedStorageService().stage({ ...args, device, signal })),
    { defaultEnabled: false },
  );
}
