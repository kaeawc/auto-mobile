import type {
  NetsimInstance,
  NetsimInstanceLauncher,
} from "../../src/utils/android-cmdline-tools/NetsimInstanceLauncher";

export class FakeNetsimInstanceLauncher implements NetsimInstanceLauncher {
  starts = 0;
  stops = 0;
  error?: Error;
  readonly instances: NetsimInstance[] = [];

  async start(): Promise<NetsimInstance> {
    this.starts++;
    if (this.error) {
      throw this.error;
    }
    let stopped = false;
    const instance: NetsimInstance = {
      instance: 100 + this.starts,
      port: 53078,
      pid: 2000 + this.starts,
      stop: () => {
        if (!stopped) {
          stopped = true;
          this.stops++;
        }
      },
    };
    this.instances.push(instance);
    return instance;
  }
}
