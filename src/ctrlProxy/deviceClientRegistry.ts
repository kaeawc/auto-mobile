import { deleteDeviceInstanceIfCurrent, getOrCreateDeviceInstance } from "./deviceInstanceRegistry";

/**
 * One lifecycle vocabulary for per-device CtrlProxy client/manager instances (#11847).
 * Each platform's manager exposes one of these instead of a private static `Map`, so
 * callers and tests drive retire/resume/invalidate/closeAll through the same verbs.
 */
export interface DeviceClientRegistry<T> {
  /** Return the registered instance, creating and registering it with `create` only on a miss. */
  get(deviceId: string, create: () => T): T;
  /** Return the registered instance without creating one. */
  peek(deviceId: string): T | undefined;
  /** Mark the device retired (it is going away); instances are left in place. */
  retire(deviceId: string): void;
  /** Clear the retired mark after an explicit device start. */
  resume(deviceId: string): void;
  isRetired(deviceId: string): boolean;
  /** Clear every retired mark, leaving instances in place. */
  clearRetired(): void;
  /**
   * Drop the device's instance. With `instance`, only while it is still the registered
   * one, so a stale holder cannot evict its replacement. Returns whether anything was dropped.
   */
  invalidate(deviceId: string, instance?: T): boolean;
  /** Registered `[deviceId, instance]` pairs, for snapshots and shutdown sweeps. */
  entries(): Array<[string, T]>;
  /** Drop every instance (retired marks persist), returning the instances for the caller to close. */
  closeAll(): T[];
}

/** In-memory registry over the `Map` a platform class already owns. */
export class MapDeviceClientRegistry<T> implements DeviceClientRegistry<T> {
  private readonly retired = new Set<string>();

  constructor(private readonly instances: Map<string, T> = new Map()) {}

  get(deviceId: string, create: () => T): T {
    return getOrCreateDeviceInstance(this.instances, deviceId, create);
  }

  peek(deviceId: string): T | undefined {
    return this.instances.get(deviceId);
  }

  retire(deviceId: string): void {
    this.retired.add(deviceId);
  }

  resume(deviceId: string): void {
    this.retired.delete(deviceId);
  }

  isRetired(deviceId: string): boolean {
    return this.retired.has(deviceId);
  }

  clearRetired(): void {
    this.retired.clear();
  }

  invalidate(deviceId: string, instance?: T): boolean {
    if (instance !== undefined) {
      return deleteDeviceInstanceIfCurrent(this.instances, deviceId, instance);
    }
    return this.instances.delete(deviceId);
  }

  entries(): Array<[string, T]> {
    return [...this.instances.entries()];
  }

  closeAll(): T[] {
    const drained = [...this.instances.values()];
    this.instances.clear();
    return drained;
  }
}
