import type { BootedDevice } from "../models";

interface DirectSessionDevice {
  sessionUuid: string;
  device: BootedDevice;
}

const sessions = new Map<string, BootedDevice>();

export function registerDirectSessionDevice(sessionUuid: string, device: BootedDevice): void {
  unregisterDirectSessionsForDevice(device.deviceId);
  sessions.set(sessionUuid, { ...device });
}

export function resolveDirectSessionDevice(sessionUuid: string): DirectSessionDevice | undefined {
  const device = sessions.get(sessionUuid);
  return device ? { sessionUuid, device: { ...device } } : undefined;
}

export function unregisterDirectSessionsForDevice(deviceId: string): void {
  for (const [sessionUuid, device] of sessions) {
    if (device.deviceId === deviceId) {
      sessions.delete(sessionUuid);
    }
  }
}

export function clearDirectSessionDevices(): void {
  sessions.clear();
}
