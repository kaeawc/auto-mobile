import { defaultTimer, type Timer } from "../utils/SystemTimer";

export type DeviceHealthReason =
  | "biometric-enrollment"
  | "network-condition"
  | "clock"
  | "app-cleanup"
  | "recording-teardown"
  | "keep-screen-awake";
export interface DeviceHealthMarker {
  readonly reason: DeviceHealthReason;
  /** Milliseconds from the injected Timer. */
  readonly since: number;
}

export interface DeviceHealthMarkers {
  mark(deviceId: string, incarnation: number, reason: DeviceHealthReason): DeviceHealthMarker;
  /** Oldest unresolved reason; reading a new incarnation drops stale markers. */
  get(
    deviceId: string,
    incarnation: number,
    reason?: DeviceHealthReason,
  ): DeviceHealthMarker | undefined;
  clear(deviceId: string, incarnation?: number, reason?: DeviceHealthReason): void;
}

/** Daemon-local markers; persisted recorder descriptors redrive separately after restart. */
export class InMemoryDeviceHealthMarkers implements DeviceHealthMarkers {
  private readonly devices = new Map<
    string,
    { incarnation: number; reasons: Map<DeviceHealthReason, DeviceHealthMarker> }
  >();

  constructor(private readonly timer: Timer = defaultTimer) {}

  mark(deviceId: string, incarnation: number, reason: DeviceHealthReason): DeviceHealthMarker {
    this.get(deviceId, incarnation);
    let entry = this.devices.get(deviceId);
    if (entry && entry.incarnation !== incarnation) {
      return { reason, since: this.timer.now() };
    }
    if (!entry) {
      entry = { incarnation, reasons: new Map() };
      this.devices.set(deviceId, entry);
    }
    let marker = entry.reasons.get(reason);
    if (!marker) {
      marker = { reason, since: this.timer.now() };
      entry.reasons.set(reason, marker);
    }
    return marker;
  }

  get(
    deviceId: string,
    incarnation: number,
    reason?: DeviceHealthReason,
  ): DeviceHealthMarker | undefined {
    const entry = this.devices.get(deviceId);
    if (entry?.incarnation !== incarnation) {
      if (entry && entry.incarnation < incarnation) {
        this.devices.delete(deviceId);
      }
      return undefined;
    }
    return reason ? entry.reasons.get(reason) : entry.reasons.values().next().value;
  }

  clear(deviceId: string, incarnation?: number, reason?: DeviceHealthReason): void {
    const entry = this.devices.get(deviceId);
    if (!entry || (incarnation !== undefined && entry.incarnation !== incarnation)) {
      return;
    }
    if (reason) {
      entry.reasons.delete(reason);
      if (entry.reasons.size > 0) {
        return;
      }
    }
    this.devices.delete(deviceId);
  }
}

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
