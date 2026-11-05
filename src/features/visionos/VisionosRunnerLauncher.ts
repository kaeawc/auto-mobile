import { VisionosRunnerError } from "./VisionosRunnerError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { XcodebuildClient, type Xcodebuild } from "../../utils/ios-cmdline-tools/XcodebuildClient";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { WebSocketVisionosRunnerClient, type VisionosRunnerClient } from "./VisionosRunnerClient";
import { visionosRunners } from "./VisionosRunnerRegistry";
import type { IosCtrlProxyBuilder } from "../../ctrlProxy/IosCtrlProxyBuilder";
import { rm } from "node:fs/promises";

export interface VisionosRunnerLaunchOptions {
  deviceId: string;
  xctestrun: string;
  port: number;
  /** Window app to automate; the runner falls back to its demo app when absent. */
  bundleId?: string;
  /** Startup cancellation only; the resident process outlives a completed start request. */
  signal?: AbortSignal;
}
export interface VisionosRunnerLauncher {
  launch(options: VisionosRunnerLaunchOptions): Promise<{ stop(): void }>;
}
interface VisionosStartup {
  client?: VisionosRunnerClient;
  exited: boolean;
  unregister: () => void;
}
/** Launch a prebuilt test bundle; the caller supplies its xctestrun and reserved localhost port. */
export class XcodebuildVisionosRunnerLauncher implements VisionosRunnerLauncher {
  constructor(
    private readonly dependencies: {
      xcodebuild?: Pick<Xcodebuild, "startStreaming">;
      connect?: (url: string) => VisionosRunnerClient;
      timer?: Timer;
      writeRunnerEnvironment: IosCtrlProxyBuilder["writeRunnerEnvironment"];
    },
  ) {}

  async launch(options: VisionosRunnerLaunchOptions): Promise<{ stop(): void }> {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
      throw new ActionableError("Visionos runner port must be an integer from 1 to 65535.");
    }
    if (visionosRunners.get(options.deviceId)) {
      throw new ActionableError("Visionos runner is already connected.");
    }
    options.signal?.throwIfAborted();
    const bundleId = options.bundleId?.trim() || undefined;
    const prepared = await this.dependencies.writeRunnerEnvironment(
      options.xctestrun,
      { AM_PORT: String(options.port), ...(bundleId ? { AM_BUNDLE_ID: bundleId } : {}) },
      `visionos-${options.deviceId}`,
    );
    let removed = false;
    const removePrepared = () => {
      if (!removed && prepared !== options.xctestrun) {
        removed = true;
        void rm(prepared, { force: true }).catch((error) => {
          logger.warn("Failed to remove visionos runner xctestrun copy", error);
        });
      }
    };
    try {
      return await this.launchPrepared(
        { ...options, bundleId, xctestrun: prepared },
        removePrepared,
      );
    } catch (error) {
      removePrepared();
      throw toActionableError(error, "Failed to launch visionos runner");
    }
  }

  private async launchPrepared(
    options: VisionosRunnerLaunchOptions,
    removePrepared: () => void,
  ): Promise<{ stop(): void }> {
    const timer = this.dependencies.timer ?? defaultTimer;
    options.signal?.throwIfAborted();
    const process = await (this.dependencies.xcodebuild ?? new XcodebuildClient()).startStreaming(
      [
        "test-without-building",
        "-xctestrun",
        options.xctestrun,
        "-destination",
        `platform=visionOS Simulator,id=${options.deviceId}`,
        "-only-testing:CtrlProxyVisionUITests/CtrlProxyVisionUITests/testRunService",
      ],
      {
        env: {
          ...globalThis.process.env,
          TEST_RUNNER_AM_PORT: String(options.port),
          ...(options.bundleId ? { TEST_RUNNER_AM_BUNDLE_ID: options.bundleId } : {}),
        },
        stdio: "ignore",
        startupSignal: options.signal,
      },
    );
    const state: VisionosStartup = { exited: false, unregister: () => {} };
    const cleanup = () => {
      state.exited = true;
      state.unregister();
      state.client?.close();
      removePrepared();
    };
    const stop = () => {
      const running = !state.exited;
      cleanup();
      if (running) {
        process.kill("SIGTERM");
      }
    };
    process.once("exit", cleanup);
    process.once("error", cleanup);
    try {
      await raceWithDeadline(() => this.waitForRunner(options, state), {
        timer,
        timeoutMs: 60_000,
        label: "Visionos runner startup",
        onTimeout: stop,
        signal: options.signal,
      });
      return { stop };
    } catch (error) {
      stop();
      throw toActionableError(error, "Failed to launch visionos runner");
    }
  }

  private async waitForRunner(
    options: VisionosRunnerLaunchOptions,
    state: VisionosStartup,
  ): Promise<void> {
    const timer = this.dependencies.timer ?? defaultTimer;
    // xcodebuild returns before the bundle binds its socket. Retry only readiness, never actions.
    while (!state.exited) {
      const client = (
        this.dependencies.connect ?? ((url) => new WebSocketVisionosRunnerClient(url, { timer }))
      )(`ws://127.0.0.1:${options.port}/ws`);
      state.client = client;
      try {
        await client.hierarchy(options.signal);
      } catch (error) {
        client.close();
        if (state.exited || options.signal?.aborted || error instanceof VisionosRunnerError) {
          throw toActionableError(error, "Visionos runner exited during startup");
        }
        // Connection refusal is expected until xcodebuild launches the service bundle.
        logger.debug("Visionos runner not ready during startup", error);
        await timer.sleep(100);
        continue;
      }
      if (state.exited) {
        break;
      }
      options.signal?.throwIfAborted();
      state.unregister = visionosRunners.register(options.deviceId, client);
      return;
    }
    throw new ActionableError(
      "Visionos runner exited before becoming ready; check the prebuilt test bundle.",
    );
  }
}
