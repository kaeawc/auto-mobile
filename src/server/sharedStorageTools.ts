import type { BootedDevice } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { stageSharedStorageSchema, type StageSharedStorageArgs } from "./sharedStorageContract";
import { getSharedStorageService } from "./sharedStorageService";
import { ToolRegistry, type ProgressCallback } from "./toolRegistry";

export function registerSharedStorageTools(): void {
  const stageHandler = async (
    device: BootedDevice,
    args: StageSharedStorageArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => createJSONToolResponse(await getSharedStorageService().stage({ ...args, device, signal }));

  ToolRegistry.registerDeviceAware(
    "stageSharedStorage",
    "Stage host-file, UTF-8, or base64 fixtures into one bounded Android Downloads namespace for system pickers.",
    stageSharedStorageSchema,
    stageHandler,
    { defaultEnabled: true },
  );
  ToolRegistry.registerDeviceAware(
    "stageSharedStorageFixtures",
    "Stage files in an isolated Android Download namespace for system picker workflows.",
    stageSharedStorageSchema,
    stageHandler,
    { defaultEnabled: false },
  );
}
