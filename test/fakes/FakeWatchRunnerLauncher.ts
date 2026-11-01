import type {
  WatchRunnerLauncher,
  WatchRunnerLaunchOptions,
} from "../../src/features/watch/WatchRunnerLauncher";
import { type WatchRunnerClient } from "../../src/features/watch/WatchRunnerClient";
import { watchRunners } from "../../src/features/watch/WatchRunnerRegistry";
import { FakeWatchRunnerClient } from "./FakeWatchRunnerClient";

export class FakeWatchRunnerLauncher implements WatchRunnerLauncher {
  readonly launches: WatchRunnerLaunchOptions[] = [];
  readonly calls: string[] = [];
  stops = 0;
  constructor(
    readonly client: WatchRunnerClient = new FakeWatchRunnerClient(),
    private readonly clients: readonly WatchRunnerClient[] = [],
  ) {}
  async launch(options: WatchRunnerLaunchOptions): Promise<{ stop(): void }> {
    this.calls.push("launch");
    const client = this.clients[this.launches.length] ?? this.client;
    this.launches.push(options);
    const unregister = watchRunners.register(options.deviceId, client);
    return {
      stop: () => {
        this.calls.push("stop");
        this.stops++;
        unregister();
        client.close();
      },
    };
  }
}
