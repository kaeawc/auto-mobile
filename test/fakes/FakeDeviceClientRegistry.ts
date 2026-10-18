import type { DeviceClientRegistry } from "../../src/ctrlProxy/deviceClientRegistry";

/** Standalone in-memory registry for tests that need a fresh one without touching a platform class's statics. */
export class FakeDeviceClientRegistry<T> implements DeviceClientRegistry<T> {
  private readonly byDevice = new Map<string, T>();
  private readonly retiredDevices = new Set<string>();
  /** Every `create` callback this registry ran, in order. */
  readonly created: string[] = [];

  get(deviceId: string, create: () => T): T {
    if (!this.byDevice.has(deviceId)) {
      this.created.push(deviceId);
      this.byDevice.set(deviceId, create());
    }
    return this.byDevice.get(deviceId) as T;
  }

  peek(deviceId: string): T | undefined {
    return this.byDevice.get(deviceId);
  }

  retire(deviceId: string): void {
    this.retiredDevices.add(deviceId);
  }

  resume(deviceId: string): void {
    this.retiredDevices.delete(deviceId);
  }

  isRetired(deviceId: string): boolean {
    return this.retiredDevices.has(deviceId);
  }

  clearRetired(): void {
    this.retiredDevices.clear();
  }

  invalidate(deviceId: string, instance?: T): boolean {
    if (instance !== undefined && this.byDevice.get(deviceId) !== instance) {
      return false;
    }
    return this.byDevice.delete(deviceId);
  }

  entries(): Array<[string, T]> {
    return [...this.byDevice.entries()];
  }

  closeAll(): T[] {
    const drained = [...this.byDevice.values()];
    this.byDevice.clear();
    return drained;
  }
}
