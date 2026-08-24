import type { BootedDevice } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { stageSharedStorageSchema, type StageSharedStorageArgs } from "./sharedStorageContract";
import { getSharedStorageService } from "./sharedStorageService";
import { ToolRegistry } from "./toolRegistry";

export function registerSharedStorageTools(): void {
  ToolRegistry.registerDeviceAware(
    "stageSharedStorage",
    "Stage host-file, UTF-8, or base64 fixtures into one bounded Android Downloads namespace for system pickers.",
    stageSharedStorageSchema,
    async (device: BootedDevice, args: StageSharedStorageArgs, _progress, signal) =>
      createJSONToolResponse(await getSharedStorageService().stage({ ...args, device, signal })),
    { defaultEnabled: true },
  );
}
