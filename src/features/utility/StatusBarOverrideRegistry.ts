import type { BootedDevice } from "../../models";
import type { StatusBarOverrides } from "./StatusBarOverride";

/** The status-bar override a device currently carries, and which session set it. */
export interface StatusBarOverrideRecord {
  device: BootedDevice;
  /** `null` for a sessionless call: no release clears it. */
  sessionId: string | null;
  overrides: StatusBarOverrides;
}

export interface StatusBarOverrideStore {
  record(device: BootedDevice, sessionId: string | null, overrides: StatusBarOverrides): void;
  get(deviceId: string): StatusBarOverrideRecord | null;
  forget(deviceId: string): void;
  /** Removes and returns the device's record only when `sessionId` set it. */
  takeOwnedBy(deviceId: string, sessionId: string): StatusBarOverrideRecord | null;
}

/**
 * In-memory ownership of status-bar overrides (#14105). An override set by a session is cleared
 * when that session releases or moves off the device; a later override by the same session
 * merges, and one by a different caller replaces the owner.
 */
export class StatusBarOverrideRegistry implements StatusBarOverrideStore {
  private readonly records = new Map<string, StatusBarOverrideRecord>();

  record(device: BootedDevice, sessionId: string | null, overrides: StatusBarOverrides): void {
    const previous = this.records.get(device.deviceId);
    const merged =
      previous && previous.sessionId === sessionId
        ? { ...previous.overrides, ...overrides }
        : { ...overrides };
    this.records.set(device.deviceId, { device, sessionId, overrides: merged });
  }

  get(deviceId: string): StatusBarOverrideRecord | null {
    return this.records.get(deviceId) ?? null;
  }

  forget(deviceId: string): void {
    this.records.delete(deviceId);
  }

  takeOwnedBy(deviceId: string, sessionId: string): StatusBarOverrideRecord | null {
    const record = this.records.get(deviceId);
    if (!record || record.sessionId !== sessionId) {
      return null;
    }
    this.records.delete(deviceId);
    return record;
  }
}

/** Shared by the tool handler and the daemon's release cleanup. */
export const defaultStatusBarOverrideRegistry = new StatusBarOverrideRegistry();
