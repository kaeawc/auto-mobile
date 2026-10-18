import { ToolRegistry } from "./toolRegistry";
import { putAppFileSchema, type PutAppFileArgs } from "./appFileContract";
import { getAppFileService, type AppFileService } from "./appFileService";
import { registerPendingDeviceCleanup } from "./downloadsFixtureService";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { putAppFileResultSchema } from "./appFileToolOutputSchemas";
import type { BootedDevice } from "../models";

export function registerAppFileTools(
  deps: {
    appFileService?: () => AppFileService;
    registerPendingDeviceCleanup?: (deviceId: string, cleanup: Promise<unknown>) => void;
  } = {},
): void {
  ToolRegistry.registerDeviceAware(
    "putAppFile",
    "Write files into a bounded logical storage target.",
    putAppFileSchema,
    async (device: BootedDevice, args: PutAppFileArgs, _progress, signal) => {
      const writePromise = (deps.appFileService ?? getAppFileService)().putFile({
        ...args,
        device,
        signal,
      });
      if (args.target.domain === "user_files") {
        (deps.registerPendingDeviceCleanup ?? registerPendingDeviceCleanup)(
          device.deviceId,
          writePromise,
        );
      }
      const result = await writePromise;
      return createStructuredToolResponse(result);
    },
    { defaultEnabled: true, outputSchema: putAppFileResultSchema },
  );
}
