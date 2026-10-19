import {
  type DeviceHealthReason,
  type DeviceHealthMarker,
  type DeviceHealthMarkers,
} from "./deviceHealthMarkers";

/**
 * Wraps a marker store so every mutation that actually changes it reports the device, in one place
 * (#11568). A marker moves a device between the pool's idle and assigned buckets, so the pool must
 * tell inventory subscribers; the session manager's mark/clear sites then need no notification of
 * their own. `onChanged` runs after the inner store committed the change.
 */
export class NotifyingDeviceHealthMarkers implements DeviceHealthMarkers {
  constructor(
    private readonly inner: DeviceHealthMarkers,
    private readonly onChanged: (deviceId: string) => void,
  ) {}

  mark(deviceId: string, incarnation: number, reason: DeviceHealthReason): DeviceHealthMarker {
    const existed = this.inner.get(deviceId, incarnation, reason) !== undefined;
    const marker = this.inner.mark(deviceId, incarnation, reason);
    if (!existed && this.inner.get(deviceId, incarnation, reason) !== undefined) {
      this.onChanged(deviceId);
    }
    return marker;
  }

  get(
    deviceId: string,
    incarnation: number,
    reason?: DeviceHealthReason,
  ): DeviceHealthMarker | undefined {
    return this.inner.get(deviceId, incarnation, reason);
  }

  list(deviceId: string, incarnation: number): readonly DeviceHealthMarker[] {
    return this.inner.list(deviceId, incarnation);
  }

  clear(deviceId: string, incarnation?: number, reason?: DeviceHealthReason): void {
    const hadMarker =
      incarnation === undefined
        ? true
        : this.inner.get(deviceId, incarnation, reason) !== undefined;
    this.inner.clear(deviceId, incarnation, reason);
    if (hadMarker) {
      this.onChanged(deviceId);
    }
  }
}
