import { NoOpPerformanceTracker } from "../../src/utils/PerformanceTracker";

/** Records block ownership while retaining the no-op tracker's operation execution. */
export class FakeRecordingPerformanceTracker extends NoOpPerformanceTracker {
  readonly serialNames: string[] = [];
  endCalls = 0;

  override serial(name: string): this {
    this.serialNames.push(name);
    return this;
  }

  override end(): this {
    this.endCalls++;
    return this;
  }
}
