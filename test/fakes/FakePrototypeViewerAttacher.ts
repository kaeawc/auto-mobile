import type { BootedDevice } from "../../src/models";

export class FakePrototypeViewerAttacher {
  readonly calls: Array<{ device: BootedDevice; bundleId: string }> = [];
  error: Error | undefined;
  pending: Promise<unknown> | undefined;

  async attach(device: BootedDevice, bundleId: string): Promise<unknown> {
    this.calls.push({ device, bundleId });
    if (this.error) {
      throw this.error;
    }
    return this.pending;
  }
}
