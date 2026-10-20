import type { PrototypeSpec } from "./prototypeSpec";
import { prototypeTextFieldKeys } from "./prototypeTextFieldKeys";
import type { PrototypeTextFieldBindings } from "./prototypeTextTarget";

export class InMemoryPrototypeTextFieldBindings implements PrototypeTextFieldBindings {
  private readonly devices = new Map<
    string,
    { prototypeId: string; keys: ReadonlyMap<string, string> }
  >();
  record(deviceId: string, spec: PrototypeSpec): void {
    this.devices.set(deviceId, { prototypeId: spec.id, keys: prototypeTextFieldKeys(spec) });
  }
  forDevice(deviceId: string) {
    return this.devices.get(deviceId);
  }
  forget(deviceId: string): void {
    this.devices.delete(deviceId);
  }
  clear(): void {
    this.devices.clear();
  }
}
