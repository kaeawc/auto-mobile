import type { RunningAvdAdvertisementReader } from "../../src/utils/android-cmdline-tools/RunningAvdAdvertisementReader";

/**
 * Deterministic {@link RunningAvdAdvertisementReader} for tests: the pid-file
 * miss (the macOS reality, #6407) is the default, and `failWith` reproduces an
 * unexpected read failure so the caller's warn-and-degrade path is testable.
 */
export class FakeRunningAvdAdvertisementReader implements RunningAvdAdvertisementReader {
  readonly advertised = new Set<string>();
  failWith: Error | undefined;
  readonly queriedAvdNames: string[] = [];

  async isAvdAdvertisedRunning(avdName: string): Promise<boolean> {
    this.queriedAvdNames.push(avdName);
    if (this.failWith) {
      throw this.failWith;
    }
    return this.advertised.has(avdName);
  }
}
