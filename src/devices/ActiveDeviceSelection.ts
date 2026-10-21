import type { BootedDevice } from "../models";

/** Direct stdio has one connection and carries no MCP connection id. */
export const DIRECT_DEVICE_CONNECTION_KEY = "direct-stdio";

/**
 * Explicit selection per MCP connection. Readying a device never changes these pins.
 */
export class ActiveDeviceSelection {
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
