import type {
  CarPlayProjectionProbe,
  CarPlayProjectionState,
} from "../../src/utils/ios/carPlayProjection";
import type { CarPlayHelperCallOptions } from "../../src/utils/ios/carPlayScreenPower";

export class FakeCarPlayProjectionProbe implements CarPlayProjectionProbe {
  readonly calls: string[] = [];
  /** The bounds each probe call received, in call order. */
  readonly options: Array<CarPlayHelperCallOptions | undefined> = [];
  error?: Error;
  /** When set, a probe never settles on its own, like a wedged `simctl spawn`. */
  hang = false;
  /** States returned, in order, before `state`. */
  readonly queued: CarPlayProjectionState[] = [];

  constructor(public state: CarPlayProjectionState) {}

  async probe(udid: string, options?: CarPlayHelperCallOptions): Promise<CarPlayProjectionState> {
    this.calls.push(udid);
    this.options.push(options);
    if (this.hang) {
      return await new Promise<never>(() => {});
    }
    if (this.error) {
      throw this.error;
    }
    return this.queued.shift() ?? this.state;
  }
}
