/**
 * When the most recent control call on each device started (#14082), so `getLogs` can read
 * "since the last action". Control vs read is decided at admission (`markDeviceCallKind`) before
 * the device is known; the device is known at dispatch. The pending map joins the two and is
 * bounded, so a control call refused before dispatch cannot leak an entry.
 */
const PENDING_LIMIT = 256;

export class DeviceActionClock {
  private readonly pendingControl = new Set<string>();
  private readonly lastStart = new Map<string, number>();

  /** A control call is running under `executionId`. */
  markControl(executionId: string): void {
    this.pendingControl.delete(executionId);
    this.pendingControl.add(executionId);
    if (this.pendingControl.size > PENDING_LIMIT) {
      const oldest = this.pendingControl.values().next().value;
      if (oldest !== undefined) {
        this.pendingControl.delete(oldest);
      }
    }
  }

  /** The call under `executionId` dispatched to `deviceId`; a control call moves its clock. */
  recordDispatch(executionId: unknown, startTime: unknown, deviceId: string): void {
    if (
      typeof executionId !== "string" ||
      typeof startTime !== "number" ||
      !this.pendingControl.has(executionId)
    ) {
      return;
    }
    const previous = this.lastStart.get(deviceId);
    if (previous === undefined || startTime > previous) {
      this.lastStart.set(deviceId, startTime);
    }
  }

  /** Host-clock start of the latest control call on the device, or undefined when none ran. */
  lastActionStartMs(deviceId: string): number | undefined {
    return this.lastStart.get(deviceId);
  }
}

export const deviceActionClock = new DeviceActionClock();
