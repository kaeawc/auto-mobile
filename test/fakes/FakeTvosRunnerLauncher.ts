import type {
  TvosRunnerLauncher,
  TvosRunnerLaunchOptions,
} from "../../src/features/tvos/TvosRunnerLauncher";
import { type TvosRunnerClient } from "../../src/features/tvos/TvosRunnerClient";
import { tvosRunners } from "../../src/features/tvos/TvosRunnerRegistry";
import { FakeTvosRunnerClient } from "./FakeTvosRunnerClient";

export class FakeTvosRunnerLauncher implements TvosRunnerLauncher {
  readonly launches: TvosRunnerLaunchOptions[] = [];
  readonly calls: string[] = [];
  stops = 0;
  constructor(readonly client: TvosRunnerClient = new FakeTvosRunnerClient()) {}
  async launch(options: TvosRunnerLaunchOptions): Promise<{ stop(): void }> {
    this.calls.push("launch");
    this.launches.push(options);
    const unregister = tvosRunners.register(options.deviceId, this.client);
    return {
      stop: () => {
        this.calls.push("stop");
        this.stops++;
        unregister();
        this.client.close();
      },
    };
  }
}
