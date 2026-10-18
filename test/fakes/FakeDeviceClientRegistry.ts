import {
  MapDeviceClientRegistry,
  type DeviceClientRegistry,
} from "../../src/ctrlProxy/deviceClientRegistry";

/** In-memory registry that records the lifecycle verbs a test drove, in order. */
export class FakeDeviceClientRegistry<T> implements DeviceClientRegistry<T> {
  readonly calls: string[] = [];
  private readonly inner = new MapDeviceClientRegistry<T>();

  get(deviceId: string, create: () => T): T {
    this.calls.push(`get:${deviceId}`);
    return this.inner.get(deviceId, create);
  }

  peek(deviceId: string): T | undefined {
    return this.inner.peek(deviceId);
  }

  retire(deviceId: string): void {
    this.calls.push(`retire:${deviceId}`);
    this.inner.retire(deviceId);
  }

  resume(deviceId: string): void {
    this.calls.push(`resume:${deviceId}`);
    this.inner.resume(deviceId);
  }

  isRetired(deviceId: string): boolean {
    return this.inner.isRetired(deviceId);
  }

  clearRetired(): void {
    this.calls.push("clearRetired");
    this.inner.clearRetired();
  }

  invalidate(deviceId: string, instance?: T): boolean {
    this.calls.push(`invalidate:${deviceId}`);
    return this.inner.invalidate(deviceId, instance);
  }

  entries(): Array<[string, T]> {
    return this.inner.entries();
  }

  closeAll(): T[] {
    this.calls.push("closeAll");
    return this.inner.closeAll();
  }
}
