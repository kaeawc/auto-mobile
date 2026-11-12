import type { BleTransportResolver } from "../../src/features/blePeripheral/BleTransportResolver";

export class FakeBleTransportResolver implements BleTransportResolver {
  readonly calls: { deviceId?: string; override?: string }[] = [];
  result = "android-netsim";
  async resolve(deviceId?: string, override?: string): Promise<string> {
    this.calls.push({ deviceId, override });
    return override ?? this.result;
  }
}
