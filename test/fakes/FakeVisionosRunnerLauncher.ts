import type {
  VisionosRunnerLauncher,
  VisionosRunnerLaunchOptions,
} from "../../src/features/visionos/VisionosRunnerLauncher";
import { type VisionosRunnerClient } from "../../src/features/visionos/VisionosRunnerClient";
import { visionosRunners } from "../../src/features/visionos/VisionosRunnerRegistry";
import { FakeVisionosRunnerClient } from "./FakeVisionosRunnerClient";

export class FakeVisionosRunnerLauncher implements VisionosRunnerLauncher {
  readonly launches: VisionosRunnerLaunchOptions[] = [];
  readonly calls: string[] = [];
  stops = 0;
  constructor(readonly client: VisionosRunnerClient = new FakeVisionosRunnerClient()) {}
  async launch(options: VisionosRunnerLaunchOptions): Promise<{ stop(): void }> {
    this.calls.push("launch");
    this.launches.push(options);
    const unregister = visionosRunners.register(options.deviceId, this.client);
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
