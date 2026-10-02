import type {
  DeviceHealthMarker,
  DeviceHealthMarkers,
  DeviceHealthReason,
} from "../../src/daemon/deviceHealthMarkers";
import type { Timer } from "../../src/utils/SystemTimer";

export class FakeDeviceHealthMarkers implements DeviceHealthMarkers {
  private readonly entries = new Map<
    string,
    { incarnation: number; markers: DeviceHealthMarker[] }
  >();
  constructor(private readonly timer: Timer) {}

  get(
    deviceId: string,
    incarnation: number,
    reason?: DeviceHealthReason,
  ): DeviceHealthMarker | undefined {
    const entry = this.entries.get(deviceId);
    if (entry?.incarnation !== incarnation) {
      if (entry && entry.incarnation < incarnation) {
        this.entries.delete(deviceId);
      }
      return undefined;
    }
    return reason ? entry.markers.find((marker) => marker.reason === reason) : entry.markers[0];
  }

  mark(deviceId: string, incarnation: number, reason: DeviceHealthReason): DeviceHealthMarker {
    this.get(deviceId, incarnation);
    const entry = this.entries.get(deviceId) ?? { incarnation, markers: [] };
    if (entry && entry.incarnation !== incarnation) {
      return { reason, since: this.timer.now() };
    }
    this.entries.set(deviceId, entry);
    const existing = entry.markers.find((marker) => marker.reason === reason);
    if (existing) {
      return existing;
    }
    const marker = { reason, since: this.timer.now() };
    entry.markers.push(marker);
    return marker;
  }

  clear(deviceId: string, incarnation?: number, reason?: DeviceHealthReason): void {
    const entry = this.entries.get(deviceId);
    if (!entry || (incarnation !== undefined && entry.incarnation !== incarnation)) {
      return;
    }
    entry.markers = reason ? entry.markers.filter((marker) => marker.reason !== reason) : [];
    if (!entry.markers.length) {
      this.entries.delete(deviceId);
    }
  }
}
