import type { CarPlayRuntimeReader } from "../../src/utils/ios/carPlayRuntime";

export class FakeCarPlayRuntimeReader implements CarPlayRuntimeReader {
  readonly calls: string[] = [];

  /** The runtime reported for every simulator; `undefined` reads as unknown. */
  constructor(public version: string | undefined = "26.5") {}

  async runtimeVersion(udid: string): Promise<string | undefined> {
    this.calls.push(udid);
    return this.version;
  }
}
