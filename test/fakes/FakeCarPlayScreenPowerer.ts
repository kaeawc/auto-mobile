import type {
  CarPlayPowerOnOptions,
  CarPlayPowerState,
  CarPlayScreenPowerer,
} from "../../src/utils/ios/carPlayScreenPower";

export class FakeCarPlayScreenPowerer implements CarPlayScreenPowerer {
  readonly calls: Array<{ udid: string; action: "status" | "power-on" }> = [];
  /** The bounds each power-on call received, in call order. */
  readonly powerOnOptions: Array<CarPlayPowerOnOptions | undefined> = [];
  error?: Error;
  /** When set, power-on never settles on its own, like a wedged helper. */
  hangPowerOn = false;
  constructor(public state: CarPlayPowerState) {}
  async status(udid: string): Promise<CarPlayPowerState> {
    this.calls.push({ udid, action: "status" });
    if (this.error) {
      throw this.error;
    }
    return this.state;
  }
  async powerOn(udid: string, options?: CarPlayPowerOnOptions): Promise<CarPlayPowerState> {
    this.calls.push({ udid, action: "power-on" });
    this.powerOnOptions.push(options);
    if (this.hangPowerOn) {
      return await new Promise<never>(() => {});
    }
    if (this.error) {
      throw this.error;
    }
    return this.state;
  }
}
