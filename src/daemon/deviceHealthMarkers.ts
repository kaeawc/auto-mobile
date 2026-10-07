import { defaultTimer, type Timer } from "../utils/SystemTimer";

export type DeviceHealthReason =
  | "biometric-enrollment"
  | "network-condition"
  | "clock"
  | "app-cleanup";
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

/** Daemon-local only: restart loses markers and does not re-detect dirty state. */
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
