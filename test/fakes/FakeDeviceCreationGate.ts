import type { DeviceCreationGate, EnvironmentReader } from "../../src/utils/deviceCreationGate";

/** In-memory {@link EnvironmentReader} so tests never mutate `process.env`. */
export class FakeEnvironmentReader implements EnvironmentReader {
  constructor(private readonly values: Record<string, string | undefined> = {}) {}

  get(name: string): string | undefined {
    return this.values[name];
  }

  set(name: string, value: string | undefined): void {
    this.values[name] = value;
  }
}

/** Gate with a fixed answer, recording what flag it was asked about. */
export class FakeDeviceCreationGate implements DeviceCreationGate {
  public readonly calls: (boolean | undefined)[] = [];

  constructor(private allowed: boolean = false) {}

  setAllowed(allowed: boolean): void {
    this.allowed = allowed;
  }

  isCreationAllowed(explicitFlag?: boolean): boolean {
    this.calls.push(explicitFlag);
    return this.allowed;
  }

  describeSource(explicitFlag?: boolean): string {
    return `fake(allowed=${this.allowed}, flag=${String(explicitFlag)})`;
  }
}
