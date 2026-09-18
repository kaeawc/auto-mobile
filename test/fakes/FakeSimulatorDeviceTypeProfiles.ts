import type {
  SimulatorDeviceTypeProfile,
  SimulatorDeviceTypeProfileSource,
} from "../../src/utils/ios-cmdline-tools/SimulatorDeviceTypeProfiles";

export class FakeSimulatorDeviceTypeProfiles implements SimulatorDeviceTypeProfileSource {
  public calls = 0;

  constructor(
    private readonly profiles: Map<string, SimulatorDeviceTypeProfile | null> = new Map(),
  ) {}

  async profileFor(deviceTypeId: string): Promise<SimulatorDeviceTypeProfile | null> {
    this.calls++;
    return this.profiles.get(deviceTypeId) ?? null;
  }
}
