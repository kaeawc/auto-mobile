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
  /**
   * Runs `task` after every earlier task on the device has settled, one at a time in call order.
   * A rejected task does not block the next. Tasks on different devices run concurrently.
   */
  runOnDevice<T>(deviceId: string, task: () => Promise<T>): Promise<T>;
  /** Whether a task queued through `runOnDevice` has not yet settled on the device. */
  hasDeviceWork(deviceId: string): boolean;
}

/**
 * In-memory ownership of status-bar overrides (#14105). An override set by a session is cleared
 * when that session releases or moves off the device; a later override by the same session
 * merges, and one by a different caller replaces the owner.
 *
 * It also owns the per-device queue that orders every status-bar device command: the tool
 * handler's override and clear (#17079) and the daemon's release-time clear (#17084). The store
 * is the one place both tiers reach, since `daemon` must not import `server`.
 */
export class StatusBarOverrideRegistry implements StatusBarOverrideStore {
  private readonly records = new Map<string, StatusBarOverrideRecord>();
  private readonly tails = new Map<string, Promise<void>>();

  runOnDevice<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
    const run = (this.tails.get(deviceId) ?? Promise.resolve()).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(deviceId, tail);
    void tail.then(() => {
      if (this.tails.get(deviceId) === tail) {
        this.tails.delete(deviceId);
      }
    });
    return run;
  }

  hasDeviceWork(deviceId: string): boolean {
    return this.tails.has(deviceId);
  }

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
