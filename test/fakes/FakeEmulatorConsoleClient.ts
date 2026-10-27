import { EmulatorConsoleClient } from "../../src/utils/android-cmdline-tools/EmulatorConsoleClient";
import type {
  ConsoleNetworkDelay,
  ConsoleNetworkSpeed,
  ConsolePostureVerb,
  ConsolePowerHealth,
  ConsolePowerStatus,
  ConsoleRadioState,
} from "../../src/utils/android-cmdline-tools/emulatorConsoleCommands";
import type { VmSnapshotAction } from "../../src/utils/android-cmdline-tools/vmSnapshot";

export interface RecordedConsoleCall {
  method: keyof EmulatorConsoleClient;
  args: string[];
}

function describeSpeed(speed: ConsoleNetworkSpeed): string {
  return typeof speed === "string" ? speed : `${speed.upKbps}:${speed.downKbps}`;
}

function describeDelay(delay: ConsoleNetworkDelay): string {
  if (typeof delay === "string") {
    return delay;
  }
  return delay.maxMs === undefined ? `${delay.minMs}` : `${delay.minMs}:${delay.maxMs}`;
}

export class FakeEmulatorConsoleClient implements EmulatorConsoleClient {
  public readonly calls: RecordedConsoleCall[] = [];
  public failures: Map<RecordedConsoleCall["method"], Error> = new Map();
  /** Values `sensorGet` reports, keyed by sensor name; unset sensors read `[0]`. */
  public readonly sensorValues: Map<string, number[]> = new Map();

  failNext(method: RecordedConsoleCall["method"], error: Error): void {
    this.failures.set(method, error);
  }

  private record(method: RecordedConsoleCall["method"], args: string[]): Promise<void> {
    this.calls.push({ method, args });
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      return Promise.reject(failure);
    }
    return Promise.resolve();
  }

  gsmCall(phoneNumber: string): Promise<void> {
    return this.record("gsmCall", [phoneNumber]);
  }
  gsmAccept(phoneNumber: string): Promise<void> {
    return this.record("gsmAccept", [phoneNumber]);
  }
  gsmCancel(phoneNumber: string): Promise<void> {
    return this.record("gsmCancel", [phoneNumber]);
  }
  gsmBusy(phoneNumber: string): Promise<void> {
    return this.record("gsmBusy", [phoneNumber]);
  }
  gsmHold(): Promise<void> {
    return this.record("gsmHold", []);
  }
  smsSend(phoneNumber: string, message: string): Promise<void> {
    return this.record("smsSend", [phoneNumber, message]);
  }
  geoFix(lon: number, lat: number, altitude?: number): Promise<void> {
    return this.record("geoFix", [
      String(lon),
      String(lat),
      ...(altitude === undefined ? [] : [String(altitude)]),
    ]);
  }
  powerAc(online: boolean): Promise<void> {
    return this.record("powerAc", [online ? "on" : "off"]);
  }
  powerStatus(status: ConsolePowerStatus): Promise<void> {
    return this.record("powerStatus", [status]);
  }
  powerHealth(health: ConsolePowerHealth): Promise<void> {
    return this.record("powerHealth", [health]);
  }
  powerCapacity(percent: number): Promise<void> {
    return this.record("powerCapacity", [String(percent)]);
  }
  async sensorSet(name: string, values: readonly number[]): Promise<void> {
    await this.record("sensorSet", [name, ...values.map(String)]);
    this.sensorValues.set(name, [...values]);
  }
  async sensorGet(name: string): Promise<number[]> {
    await this.record("sensorGet", [name]);
    return [...(this.sensorValues.get(name) ?? [0])];
  }
  networkSpeed(speed: ConsoleNetworkSpeed): Promise<void> {
    return this.record("networkSpeed", [describeSpeed(speed)]);
  }
  networkDelay(delay: ConsoleNetworkDelay): Promise<void> {
    return this.record("networkDelay", [describeDelay(delay)]);
  }
  gsmData(state: ConsoleRadioState): Promise<void> {
    return this.record("gsmData", [state]);
  }
  gsmVoice(state: ConsoleRadioState): Promise<void> {
    return this.record("gsmVoice", [state]);
  }
  gsmSignal(rssi: number, ber?: number): Promise<void> {
    return this.record("gsmSignal", [String(rssi), ...(ber === undefined ? [] : [String(ber)])]);
  }
  fingerTouch(fingerprintId: number): Promise<void> {
    return this.record("fingerTouch", [String(fingerprintId)]);
  }
  fingerRemove(): Promise<void> {
    return this.record("fingerRemove", []);
  }
  avdSnapshot(action: VmSnapshotAction, snapshotName: string): Promise<void> {
    return this.record("avdSnapshot", [action, snapshotName]);
  }
  posture(verb: ConsolePostureVerb): Promise<void> {
    return this.record("posture", [verb]);
  }
}
