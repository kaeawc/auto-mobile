import type { BootedDevice, Platform } from "../models";

/**
 * The device a readiness caller falls back to when a call names none: the last device readied
 * and the device an explicit selection pinned. One instance belongs to one DeviceReadiness, so
 * the selection is explicit state that can be constructed, injected and inspected, not a
 * hidden module global.
 */
export class ActiveDeviceSelection {
  currentDevice: BootedDevice | undefined;
  currentPlatform: Platform | undefined;
  explicitDevicePin: BootedDevice | undefined;

  /** Drop the pin only when it still names the device being released. */
  clearPinFor(deviceId: string): void {
    if (this.explicitDevicePin?.deviceId === deviceId) {
      this.explicitDevicePin = undefined;
    }
  }
}
