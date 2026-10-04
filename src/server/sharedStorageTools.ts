import type { BootedDevice } from "../models";
import { createJSONToolResponse } from "../utils/toolUtils";
import { registerPendingDeviceCleanup } from "./downloadsFixtureService";
import { stageSharedStorageSchema, type StageSharedStorageArgs } from "./sharedStorageContract";
import { getSharedStorageService, type SharedStorageService } from "./sharedStorageService";
import { ToolRegistry, type ProgressCallback } from "./toolRegistry";

export function registerSharedStorageTools(
  deps: {
    sharedStorage?: () => SharedStorageService;
    registerPendingDeviceCleanup?: (deviceId: string, cleanup: Promise<unknown>) => void;
  } = {},
): void {
  const stageHandler = async (
    device: BootedDevice,
    args: StageSharedStorageArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const stagedPromise = (deps.sharedStorage ?? getSharedStorageService)().stage({
      ...args,
      device,
      signal,
      rollbackOnFailure: true,
    });
    (deps.registerPendingDeviceCleanup ?? registerPendingDeviceCleanup)(
      device.deviceId,
      stagedPromise,
    );
    return createJSONToolResponse(await stagedPromise);
  };

  ToolRegistry.registerDeviceAware(
    "stageSharedStorage",
    'Deprecated alias of putAppFile with target.domain "user_files"; retained until device verification. Stage host-file, UTF-8, or base64 fixtures into one bounded Android Downloads namespace for system pickers.',
    stageSharedStorageSchema,
    stageHandler,
    { defaultEnabled: true },
  );
  ToolRegistry.registerDeviceAware(
    "stageSharedStorageFixtures",
    'Deprecated alias of putAppFile with target.domain "user_files"; retained until device verification. Stage files in an isolated Android Download namespace for system picker workflows.',
    stageSharedStorageSchema,
    stageHandler,
    { defaultEnabled: false },
  );
}
