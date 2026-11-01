import type { BootedDevice } from "../../models/DeviceInfo";

/** Discovery errors propagate; callers choose a checked or best-effort inventory source. */
export async function lookupLiveEmulatorSerial(
  avdName: string,
  listDevices: () => Promise<BootedDevice[]>,
): Promise<string | null> {
  if (!avdName) {
    return null;
  }
  const devices = await listDevices();
  return devices.find((device) => device.name === avdName)?.deviceId ?? null;
}
