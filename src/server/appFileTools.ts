import { ToolRegistry } from "./toolRegistry";
import { putAppFileSchema, type PutAppFileArgs } from "./appFileContract";
import { getAppFileService } from "./appFileService";
import { createJSONToolResponse } from "../utils/toolUtils";
import type { BootedDevice } from "../models";

export function registerAppFileTools(): void {
  ToolRegistry.registerDeviceAware(
    "putAppFile",
    "Write files into a bounded logical storage target.",
    putAppFileSchema,
    async (device: BootedDevice, args: PutAppFileArgs, _progress, signal) => {
      const result = await getAppFileService().putFile({ ...args, device, signal });
      return createJSONToolResponse(result);
    },
    { defaultEnabled: false },
  );
}
