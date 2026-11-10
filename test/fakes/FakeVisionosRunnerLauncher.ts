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
  /** When set, each launch registers a fresh client, as a real restarted runner would. */
  nextClient?: () => VisionosRunnerClient;
  constructor(readonly client: VisionosRunnerClient = new FakeVisionosRunnerClient()) {}
  async launch(options: VisionosRunnerLaunchOptions): Promise<{ stop(): void }> {
    this.calls.push("launch");
    this.launches.push(options);
    const client = this.nextClient?.() ?? this.client;
    const unregister = visionosRunners.register(options.deviceId, client, options.bundleId);
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
