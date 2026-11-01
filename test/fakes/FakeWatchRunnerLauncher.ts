import type {
  WatchRunnerLauncher,
  WatchRunnerLaunchOptions,
} from "../../src/features/watch/WatchRunnerLauncher";
import { type WatchRunnerClient } from "../../src/features/watch/WatchRunnerClient";
import { watchRunners } from "../../src/features/watch/WatchRunnerRegistry";
import { FakeWatchRunnerClient } from "./FakeWatchRunnerClient";

export class FakeWatchRunnerLauncher implements WatchRunnerLauncher {
  readonly launches: WatchRunnerLaunchOptions[] = [];
  constructor(readonly client: WatchRunnerClient = new FakeWatchRunnerClient()) {}
  async launch(options: WatchRunnerLaunchOptions): Promise<{ stop(): void }> {
    this.launches.push(options);
    const unregister = watchRunners.register(options.deviceId, this.client);
    return {
      stop: () => {
        unregister();
        this.client.close();
      },
    };
  }
}
