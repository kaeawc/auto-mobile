import type { BootedDevice, Platform } from "../models";

interface DirectSessionDevice {
  sessionUuid: string;
  device: BootedDevice;
  incarnation: number;
}

const sessions = new Map<string, BootedDevice>();
const incarnations = new Map<string, number>();

export function registerDirectSessionDevice(sessionUuid: string, device: BootedDevice): void {
  unregisterDirectSessionsForDevice(device.deviceId);
  sessions.set(sessionUuid, { ...device });
  incarnations.set(sessionUuid, (incarnations.get(sessionUuid) ?? 0) + 1);
}

export function resolveDirectSessionDevice(sessionUuid: string): DirectSessionDevice | undefined {
  const device = sessions.get(sessionUuid);
  return device
    ? { sessionUuid, device: { ...device }, incarnation: incarnations.get(sessionUuid) ?? 0 }
    : undefined;
}

export function unregisterDirectSessionsForDevice(deviceId: string): void {
  for (const [sessionUuid, device] of sessions) {
    if (device.deviceId === deviceId) {
      sessions.delete(sessionUuid);
    }
  }
}

export function unregisterDirectSessionsForStableIdentity(
  platform: Platform,
  stableId: string,
): void {
  for (const [sessionUuid, device] of sessions) {
    if (
      device.platform === platform &&
      (platform === "android"
        ? device.deviceId.startsWith("emulator-") && device.name === stableId
        : device.deviceId === stableId)
    ) {
      sessions.delete(sessionUuid);
    }
  }
}

export function clearDirectSessionDevices(): void {
  sessions.clear();
}
