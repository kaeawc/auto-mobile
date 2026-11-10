import type {
  CarPlayPowerState,
  CarPlayScreenPowerer,
} from "../../src/utils/ios/carPlayScreenPower";

export class FakeCarPlayScreenPowerer implements CarPlayScreenPowerer {
  readonly calls: Array<{ udid: string; action: "status" | "power-on"; enable?: boolean }> = [];
  error?: Error;
  constructor(public state: CarPlayPowerState) {}
  async status(udid: string): Promise<CarPlayPowerState> {
    this.calls.push({ udid, action: "status" });
    if (this.error) {
      throw this.error;
    }
    return this.state;
  }
  async powerOn(udid: string, options: { enable: boolean }): Promise<CarPlayPowerState> {
    this.calls.push({ udid, action: "power-on", enable: options.enable });
    if (this.error) {
      throw this.error;
    }
    return this.state;
  }
}
