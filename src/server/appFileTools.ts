import { ToolRegistry } from "./toolRegistry";
import { putAppFileSchema, type PutAppFileArgs } from "./appFileContract";
import { getAppFileService } from "./appFileService";
import { createJSONToolResponse } from "../utils/toolUtils";
import type { BootedDevice } from "../models";

export function registerAppFileTools(): void {
  ToolRegistry.registerDeviceAware(
    "putAppFile",
    "Write a local file, UTF-8 text, or base64 binary content into a logical app container. " +
    "Use this platform-neutral tool instead of direct adb push, run-as, or simctl container copy commands.",
    putAppFileSchema,
    async (device: BootedDevice, args: PutAppFileArgs, _progress, signal) => {
      const result = await getAppFileService().putFile(device, args, signal);
      return createJSONToolResponse(result);
    }
  );
}
