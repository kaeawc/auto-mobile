import type {
  CarPlayInput,
  CarPlayInputResult,
  CarPlayInputSender,
} from "../../src/utils/ios/carPlayInput";

/** Records each input and answers with the helper's JSON contract for it. */
export class FakeCarPlayInputSender implements CarPlayInputSender {
  readonly calls: Array<{
    udid: string;
    input: CarPlayInput;
    count: number;
    signal?: AbortSignal;
  }> = [];
  error?: Error;

  async send(
    udid: string,
    input: CarPlayInput,
    count: number,
    signal?: AbortSignal,
  ): Promise<CarPlayInputResult> {
    this.calls.push({ udid, input, count, signal });
    if (this.error) {
      throw this.error;
    }
    const rotation = input === "knob-cw" || input === "knob-ccw";
    const message = rotation
      ? { scrollDelta: input === "knob-cw" ? -1 : 1 }
      : { usagePage: 12, usage: 0x224 };
    return { sent: { input, count, screenID: 2, screenType: 1, target: 1, ...message } };
  }
}
