import type { BootedDevice, Platform } from "../models";

/** Direct stdio has one connection and carries no MCP connection id. */
export const DIRECT_DEVICE_CONNECTION_KEY = "direct-stdio";

/**
 * The device a readiness caller falls back to when a call names none: the last device readied
 * and the device an explicit selection pinned. One instance belongs to one DeviceReadiness, so
 * the selection is explicit state that can be constructed, injected and inspected, not a
 * hidden module global.
 */
export class ActiveDeviceSelection {
  currentDevice: BootedDevice | undefined;
  currentPlatform: Platform | undefined;
  private readonly explicitDevicePins = new Map<string, BootedDevice>();

  getPin(connectionId = DIRECT_DEVICE_CONNECTION_KEY): BootedDevice | undefined {
    return this.explicitDevicePins.get(connectionId);
  }

  setPin(device: BootedDevice, connectionId = DIRECT_DEVICE_CONNECTION_KEY): void {
    this.explicitDevicePins.set(connectionId, device);
  }

  clearConnection(connectionId: string): void {
    this.explicitDevicePins.delete(connectionId);
  }

  /** Drop every connection's pin that still names the device being released. */
  clearPinFor(deviceId: string): void {
    for (const [connectionId, device] of this.explicitDevicePins) {
      if (device.deviceId === deviceId) {
        this.clearConnection(connectionId);
      }
    }
  }
}
