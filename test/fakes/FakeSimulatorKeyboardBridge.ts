import type {
  HardwareKeyboardLayout,
  SimulatorKeyboardBridge,
} from "../../src/utils/ios/SimulatorKeyboardBridge";

export type FakeSimulatorKeyboardCall =
  | { call: "hardware"; udid: string; connected: boolean; layout: HardwareKeyboardLayout }
  | { call: "language"; udid: string; language: string };

/** Records CoreSimulator keyboard calls; `failWith` makes the next call reject. */
export class FakeSimulatorKeyboardBridge implements SimulatorKeyboardBridge {
  readonly calls: FakeSimulatorKeyboardCall[] = [];
  failWith?: Error;

  async setHardwareKeyboard(
    udid: string,
    connected: boolean,
    layout: HardwareKeyboardLayout,
  ): Promise<void> {
    this.calls.push({ call: "hardware", udid, connected, layout });
    this.throwIfFailing();
  }

  async setKeyboardLanguage(udid: string, language: string): Promise<void> {
    this.calls.push({ call: "language", udid, language });
    this.throwIfFailing();
  }

  private throwIfFailing(): void {
    const error = this.failWith;
    if (error) {
      this.failWith = undefined;
      throw error;
    }
  }
}
