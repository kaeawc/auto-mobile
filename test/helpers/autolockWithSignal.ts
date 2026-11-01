import type { DevicePool } from "../../src/daemon/devicePool";
import type { Platform } from "../../src/models";

/** Autolock a device with the caller's cancel signal in its policy, as `startDevice` passes it. */
export function autolockWithSignal(
  pool: Pick<DevicePool, "autolockDevice">,
  deviceId: string,
  platform: Platform,
  mcpSessionId: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  return pool.autolockDevice(
    deviceId,
    platform,
    mcpSessionId,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { signal },
  );
}
