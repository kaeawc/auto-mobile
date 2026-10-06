import type { IosTunnelClient, IosTunnelStart } from "../../src/ctrlProxy/ios/IosTunnelClient";

/** Deterministic tunnel seam: no process, I/O, or wall-clock work. */
export class FakeIosTunnelClient implements IosTunnelClient {
  localPort: number | null = null;
  devicePort: number | null = null;
  alive = false;
  startError: Error | null = null;
  readonly starts: IosTunnelStart[] = [];
  readonly stops: Array<Parameters<IosTunnelClient["stop"]>[0]> = [];
  supervisionStarts = 0;

  async start(options: IosTunnelStart): Promise<void> {
    this.starts.push(options);
    if (this.startError) {
      throw this.startError;
    }
    this.localPort = options.localPort;
    this.devicePort = options.devicePort ?? options.localPort;
    this.alive = true;
  }
  async isAlive(): Promise<boolean> {
    return this.alive;
  }
  async stop(options: Parameters<IosTunnelClient["stop"]>[0] = {}): Promise<void> {
    this.stops.push(options);
    this.alive = false;
    this.localPort = null;
    if (options.clearDevicePort) {
      this.devicePort = null;
    }
  }
  async supervise(): Promise<void> {
    this.supervisionStarts++;
  }
}
