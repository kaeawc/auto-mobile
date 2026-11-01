import { TvosRunnerError } from "./TvosRunnerError";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { XcodebuildClient, type Xcodebuild } from "../../utils/ios-cmdline-tools/XcodebuildClient";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { WebSocketTvosRunnerClient, type TvosRunnerClient } from "./TvosRunnerClient";
import { tvosRunners } from "./TvosRunnerRegistry";
import type { IosCtrlProxyBuilder } from "../../ctrlProxy/IosCtrlProxyBuilder";
import { rm } from "node:fs/promises";

export interface TvosRunnerLaunchOptions {
  deviceId: string;
  xctestrun: string;
  port: number;
  /** Startup cancellation only; the resident process outlives a completed start request. */
  signal?: AbortSignal;
}
export interface TvosRunnerLauncher {
  launch(options: TvosRunnerLaunchOptions): Promise<{ stop(): void }>;
}
interface TvosStartup {
  client?: TvosRunnerClient;
  exited: boolean;
  unregister: () => void;
}
/** Launch a prebuilt test bundle; the caller supplies its xctestrun and reserved localhost port. */
export class XcodebuildTvosRunnerLauncher implements TvosRunnerLauncher {
  constructor(
    private readonly dependencies: {
      xcodebuild?: Pick<Xcodebuild, "startStreaming">;
      connect?: (url: string) => TvosRunnerClient;
      timer?: Timer;
      writeRunnerEnvironment: IosCtrlProxyBuilder["writeRunnerEnvironment"];
    },
  ) {}

  async launch(options: TvosRunnerLaunchOptions): Promise<{ stop(): void }> {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
      throw new ActionableError("Tvos runner port must be an integer from 1 to 65535.");
    }
    if (tvosRunners.get(options.deviceId)) {
      throw new ActionableError("Tvos runner is already connected.");
    }
    options.signal?.throwIfAborted();
    const prepared = await this.dependencies.writeRunnerEnvironment(
      options.xctestrun,
      { AM_PORT: String(options.port) },
      `tvos-${options.deviceId}`,
    );
    let removed = false;
    const removePrepared = () => {
      if (!removed && prepared !== options.xctestrun) {
        removed = true;
        void rm(prepared, { force: true }).catch((error) => {
          logger.warn("Failed to remove tvos runner xctestrun copy", error);
        });
      }
    };
    try {
      return await this.launchPrepared({ ...options, xctestrun: prepared }, removePrepared);
    } catch (error) {
      removePrepared();
      throw toActionableError(error, "Failed to launch tvos runner");
    }
  }

  private async launchPrepared(
    options: TvosRunnerLaunchOptions,
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
        `platform=tvOS Simulator,id=${options.deviceId}`,
        "-only-testing:CtrlProxyTVUITests/CtrlProxyTVUITests/testRunService",
      ],
      {
        env: { ...globalThis.process.env, TEST_RUNNER_AM_PORT: String(options.port) },
        stdio: "ignore",
        startupSignal: options.signal,
      },
    );
    const state: TvosStartup = { exited: false, unregister: () => {} };
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
        label: "Tvos runner startup",
        onTimeout: stop,
        signal: options.signal,
      });
      return { stop };
    } catch (error) {
      stop();
      throw toActionableError(error, "Failed to launch tvos runner");
    }
  }

  private async waitForRunner(options: TvosRunnerLaunchOptions, state: TvosStartup): Promise<void> {
    const timer = this.dependencies.timer ?? defaultTimer;
    // xcodebuild returns before the bundle binds its socket. Retry only readiness, never actions.
    while (!state.exited) {
      const client = (
        this.dependencies.connect ?? ((url) => new WebSocketTvosRunnerClient(url, { timer }))
      )(`ws://127.0.0.1:${options.port}/ws`);
      state.client = client;
      try {
        await client.hierarchy(options.signal);
      } catch (error) {
        client.close();
        if (state.exited || options.signal?.aborted || error instanceof TvosRunnerError) {
          throw toActionableError(error, "Tvos runner exited during startup");
        }
        // Connection refusal is expected until xcodebuild launches the service bundle.
        logger.debug("Tvos runner not ready during startup", error);
        await timer.sleep(100);
        continue;
      }
      if (state.exited) {
        break;
      }
      options.signal?.throwIfAborted();
      state.unregister = tvosRunners.register(options.deviceId, client);
      return;
    }
    throw new ActionableError(
      "Tvos runner exited before becoming ready; check the prebuilt test bundle.",
    );
  }
}
