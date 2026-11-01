import type { BootedDevice } from "../models";
import { ActionableError } from "../models";
import {
  bindUndoneIfUndelivered,
  runOperationWithinDeadline,
  type DeviceToolsDependencies,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { lifecycleRequester } from "../features/deviceLifecycle/lifecycleRequester";
import { internalMcpSessionId, internalOneShotCli } from "./internalToolParams";
import type { BindBootedSession } from "./deviceToolsWatchOs";

/** Bind at booted readiness, undoing a session its caller never receives. */
export async function bindBootedSimulatorSession(
  {
    device,
    boot,
    rawArgs,
    operation,
  }: { device: BootedDevice; boot: { device: BootedDevice }; rawArgs: object; operation: string },
  bindSession: BindBootedSession,
  timer: DeviceToolsDependencies["timer"],
  { deadlineMs, signal }: { deadlineMs: number; signal: AbortSignal },
): Promise<string> {
  return await runOperationWithinDeadline(timer, deadlineMs, signal, {
    operation: bindUndoneIfUndelivered(
      async (receipt, bindSignal) =>
        await bindSession(boot.device, sessionArgs(rawArgs), undefined, {
          childProcess: null,
          achievedReadiness: "booted",
          receipt,
          signal: bindSignal,
        }),
    ),
    timeoutError: () =>
      new ActionableError(
        `${operation} timed out while binding the device session; target=${device.platform}:${device.deviceId}`,
      ),
  });
}

function sessionArgs(rawArgs: object) {
  return {
    __mcpSessionId: internalMcpSessionId(rawArgs),
    __requesterSessionUuid: lifecycleRequester(rawArgs).sessionUuid,
    ...(internalOneShotCli(rawArgs) ? { __oneShotCli: true } : {}),
  };
}
