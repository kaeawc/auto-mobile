import type { BootedDevice } from "../models";
import { markInternalToolCall } from "../daemon/internalToolCall";
import type { DeviceMutationRecording } from "./deviceMutationRecording";
import type { ProgressCallback, RegisteredTool } from "./toolRegistryTypes";
import { journaledDeviceHandler, sessionDisplayPinnedHandler } from "./pipeline/deviceCallDispatch";

export function invokeRecordedInternalTool(
  tool: RegisteredTool,
  args: Record<string, unknown>,
  progress: ProgressCallback | undefined,
  {
    signal,
    targetDevice,
    mutationRecording,
  }: {
    signal?: AbortSignal;
    targetDevice: BootedDevice | undefined;
    mutationRecording: DeviceMutationRecording;
  },
): Promise<unknown> {
  const markedArgs = markInternalToolCall(args);
  if (targetDevice && tool.deviceAwareHandler) {
    const pinnedHandler = sessionDisplayPinnedHandler({
      name: tool.name,
      schema: tool.schema,
      handler: journaledDeviceHandler(tool.name, tool.deviceAwareHandler, mutationRecording),
    });
    return pinnedHandler(targetDevice, markedArgs, progress, signal);
  }
  return tool.handler(markedArgs, progress, signal);
}
