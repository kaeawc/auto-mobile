import type {
  EmulatorSensorConsole,
  EmulatorSensorName,
  EmulatorSensorRead,
  EmulatorSensorWrite,
} from "../../src/features/utility/EmulatorSensors";

/**
 * An in-memory emulator sensor console: writes change what later reads return,
 * every call is recorded, and individual sensors can refuse or fail.
 */
export class FakeEmulatorSensorConsole implements EmulatorSensorConsole {
  readonly values = new Map<EmulatorSensorName, number[]>();
  readonly calls: string[] = [];
  readonly refuseWrites = new Map<EmulatorSensorName, string>();
  readonly failWrites = new Map<EmulatorSensorName, Error>();
  readonly failReads = new Map<EmulatorSensorName, Error>();

  constructor(initial: Partial<Record<EmulatorSensorName, number[]>> = {}) {
    for (const [sensor, value] of Object.entries(initial)) {
      this.values.set(sensor as EmulatorSensorName, value);
    }
  }

  async read(sensor: EmulatorSensorName): Promise<EmulatorSensorRead> {
    this.calls.push(`get ${sensor}`);
    const failure = this.failReads.get(sensor);
    if (failure) {
      throw failure;
    }
    const value = this.values.get(sensor);
    return value
      ? { ok: true, value: [...value] }
      : { ok: false, reason: `KO: '${sensor}' is disabled.` };
  }

  async write(sensor: EmulatorSensorName, value: readonly number[]): Promise<EmulatorSensorWrite> {
    this.calls.push(`set ${sensor} ${value.join(":")}`);
    const failure = this.failWrites.get(sensor);
    if (failure) {
      throw failure;
    }
    const refusal = this.refuseWrites.get(sensor);
    if (refusal) {
      return { ok: false, reason: refusal };
    }
    this.values.set(sensor, [...value]);
    return { ok: true };
  }
}
