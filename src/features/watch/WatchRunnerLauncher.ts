import { WatchRunnerError } from "./WatchRunnerError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { XcodebuildClient, type Xcodebuild } from "../../utils/ios-cmdline-tools/XcodebuildClient";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { WebSocketWatchRunnerClient, type WatchRunnerClient } from "./WatchRunnerClient";
import { watchRunners } from "./WatchRunnerRegistry";
import type { IosCtrlProxyBuilder } from "../../ctrlProxy/IosCtrlProxyBuilder";
import { rm } from "node:fs/promises";

export interface WatchRunnerLaunchOptions {
  deviceId: string;
  xctestrun: string;
  port: number;
  /** Startup cancellation only; the resident process outlives a completed start request. */
  signal?: AbortSignal;
}
export interface WatchRunnerLauncher {
  launch(options: WatchRunnerLaunchOptions): Promise<{ stop(): void }>;
}
interface WatchStartup {
  client?: WatchRunnerClient;
  exited: boolean;
  unregister: () => void;
}
/** Launch a prebuilt test bundle; the caller supplies its xctestrun and reserved localhost port. */
export class XcodebuildWatchRunnerLauncher implements WatchRunnerLauncher {
  constructor(
    private readonly dependencies: {
      xcodebuild?: Pick<Xcodebuild, "startStreaming">;
      connect?: (url: string) => WatchRunnerClient;
      timer?: Timer;
      writeRunnerEnvironment: IosCtrlProxyBuilder["writeRunnerEnvironment"];
    },
  ) {}

  async launch(options: WatchRunnerLaunchOptions): Promise<{ stop(): void }> {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
      throw new ActionableError("Watch runner port must be an integer from 1 to 65535.");
    }
    if (watchRunners.get(options.deviceId)) {
      throw new ActionableError("Watch runner is already connected.");
    }
    options.signal?.throwIfAborted();
    const prepared = await this.dependencies.writeRunnerEnvironment(
      options.xctestrun,
      { AM_PORT: String(options.port) },
      `watch-${options.deviceId}`,
    );
    let removed = false;
    const removePrepared = () => {
      if (!removed && prepared !== options.xctestrun) {
        removed = true;
        void rm(prepared, { force: true }).catch((error) => {
          logger.warn("Failed to remove watch runner xctestrun copy", error);
        });
      }
    };
    try {
      return await this.launchPrepared({ ...options, xctestrun: prepared }, removePrepared);
    } catch (error) {
      removePrepared();
      throw toActionableError(error, "Failed to launch watch runner");
    }
  }

  private async launchPrepared(
    options: WatchRunnerLaunchOptions,
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
        `platform=watchOS Simulator,id=${options.deviceId}`,
        "-only-testing:CtrlProxyWatchUITests/CtrlProxyWatchUITests/testRunService",
      ],
      {
        env: { ...globalThis.process.env, TEST_RUNNER_AM_PORT: String(options.port) },
        stdio: "ignore",
        startupSignal: options.signal,
      },
    );
    const state: WatchStartup = { exited: false, unregister: () => {} };
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
        label: "Watch runner startup",
        onTimeout: stop,
        signal: options.signal,
      });
      return { stop };
    } catch (error) {
      stop();
      throw toActionableError(error, "Failed to launch watch runner");
    }
  }

  private async waitForRunner(
    options: WatchRunnerLaunchOptions,
    state: WatchStartup,
  ): Promise<void> {
    const timer = this.dependencies.timer ?? defaultTimer;
    // xcodebuild returns before the bundle binds its socket. Retry only readiness, never actions.
    while (!state.exited) {
      const client = (
        this.dependencies.connect ?? ((url) => new WebSocketWatchRunnerClient(url, { timer }))
      )(`ws://127.0.0.1:${options.port}/ws`);
      state.client = client;
      try {
        await client.hierarchy(options.signal);
      } catch (error) {
        client.close();
        if (state.exited || options.signal?.aborted || error instanceof WatchRunnerError) {
          throw toActionableError(error, "Watch runner exited during startup");
        }
        // Connection refusal is expected until xcodebuild launches the service bundle.
        logger.debug("Watch runner not ready during startup", error);
        await timer.sleep(100);
        continue;
      }
      if (state.exited) {
        break;
      }
      options.signal?.throwIfAborted();
      state.unregister = watchRunners.register(options.deviceId, client);
      return;
    }
    throw new ActionableError(
      "Watch runner exited before becoming ready; check the prebuilt test bundle.",
    );
  }
}
