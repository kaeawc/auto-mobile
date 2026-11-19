import type {
  CarPlayProjectionProbe,
  CarPlayProjectionState,
} from "../../src/utils/ios/carPlayProjection";

export class FakeCarPlayProjectionProbe implements CarPlayProjectionProbe {
  readonly calls: string[] = [];
  error?: Error;
  /** States returned, in order, before `state`. */
  readonly queued: CarPlayProjectionState[] = [];

  constructor(public state: CarPlayProjectionState) {}

  async probe(udid: string): Promise<CarPlayProjectionState> {
    this.calls.push(udid);
    if (this.error) {
      throw this.error;
    }
    return this.queued.shift() ?? this.state;
  }
}
