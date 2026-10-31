import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { ToolRegistry } from "./toolRegistry";
import { putAppFileSchema, type PutAppFileArgs } from "./appFileContract";
import { getAppFileService, type AppFileService } from "./appFileService";
import { defaultDaemonContext, type DaemonContext } from "../daemon/daemonContext";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { putAppFileResultSchema } from "./appFileToolOutputSchemas";
import type { BootedDevice } from "../models";

function registerPendingDeviceCleanup(
  deviceId: string,
  cleanup: Promise<unknown>,
  daemon: DaemonContext = defaultDaemonContext,
): void {
  daemon.sessionManager()?.registerPendingDeviceCleanup(deviceId, cleanup);
}

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
    {
      handler: async (device: BootedDevice, args: PutAppFileArgs, _progress, signal) => {
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
      ...PLAN_RELEVANT,
      defaultEnabled: true,
      outputSchema: putAppFileResultSchema,
      stagesFiles: true,
    },
  );
}
