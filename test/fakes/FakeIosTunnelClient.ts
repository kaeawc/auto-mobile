import type { IosTunnelClient, IosTunnelStart } from "../../src/ctrlProxy/ios/IosTunnelClient";

/** Deterministic tunnel seam: no process, I/O, or wall-clock work. */
export class FakeIosTunnelClient implements IosTunnelClient {
  localPort: number | null = null;
  devicePort: number | null = null;
  alive = false;
  startError: Error | null = null;
  readinessError: Error | null = null;
  readonly calls: string[] = [];
  forcedStops = 0;
  readonly starts: IosTunnelStart[] = [];
  readonly stops: Array<Parameters<IosTunnelClient["stop"]>[0]> = [];
  supervisionStarts = 0;

  async start(options: IosTunnelStart): Promise<void> {
    this.calls.push("start");
    this.starts.push(options);
    if (this.startError) {
      throw this.startError;
    }
    this.localPort = options.localPort;
    this.devicePort = options.devicePort ?? options.localPort;
    this.alive = true;
    if (this.readinessError) {
      throw this.readinessError;
    }
  }
  async isAlive(): Promise<boolean> {
    this.calls.push("isAlive");
    return this.alive;
  }
  async stop(options: Parameters<IosTunnelClient["stop"]>[0] = {}): Promise<void> {
    this.calls.push("stop");
    this.stops.push(options);
    this.alive = false;
    this.localPort = null;
    if (options.clearDevicePort) {
      this.devicePort = null;
    }
  }
  prepareForcedStop(): ReturnType<IosTunnelClient["prepareForcedStop"]> {
    this.calls.push("prepareForcedStop");
    this.alive = false;
    this.localPort = null;
    this.devicePort = null;
    const kill = () => {
      this.calls.push("forceKill");
      this.forcedStops++;
    };
    return {
      killLocal: kill,
      stopRemote: () => {
        kill();
        return undefined;
      },
    };
  }
  async supervise(): Promise<void> {
    this.calls.push("supervise");
    this.supervisionStarts++;
  }
}
