import type { TvosAppLiveness } from "../../src/features/tvos/TvosAppExit";

export class FakeTvosAppLiveness implements TvosAppLiveness {
  running = false;
  failure?: Error;
  readonly apps: string[] = [];
  async isRunning(bundleId: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    this.apps.push(bundleId);
    if (this.failure) {
      throw this.failure;
    }
    return this.running;
  }
}
