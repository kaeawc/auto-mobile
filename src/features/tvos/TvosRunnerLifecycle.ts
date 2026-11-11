import type { IosCtrlProxyBuilder } from "../../ctrlProxy/IosCtrlProxyBuilder";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import type { SessionManager } from "../../daemon/sessionManager";
import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { combineAbortSignals } from "../../utils/AbortContext";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../utils/PortManager";
import { TvosRunnerReleaseProvider } from "./TvosRunnerReleaseProvider";
import { TvosRunnerArtifacts } from "./TvosRunnerArtifacts";
import { XcodebuildTvosRunnerLauncher, type TvosRunnerLauncher } from "./TvosRunnerLauncher";
import { tvosRunners } from "./TvosRunnerRegistry";
import { SingleFlight } from "../../utils/cache/SingleFlight";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { TvosRunnerClient } from "./TvosRunnerClient";

type TvosRunnerSessions = Pick<
  SessionManager,
  "hasSession" | "onSessionRelease" | "onSessionDeviceUnbound"
>;
interface OwnedRunner {
  ownerSession?: string;
  controller: AbortController;
  stop?: () => void;
  port?: number;
}
interface TvosRunnerRestartResult {
  runnerUnavailable?: string;
  unownedRunner?: TvosRunnerClient;
}

/** Owns only runners launched here; a pre-registered runner is reused without taking ownership. */
export class TvosRunnerLifecycle {
  private readonly runners = new Map<string, OwnedRunner>();
  private readonly observedSessions = new WeakSet<TvosRunnerSessions>();
  private readonly restarts = new SingleFlight<string, TvosRunnerRestartResult>();
  constructor(
    private readonly dependencies: {
      artifacts: Pick<TvosRunnerArtifacts, "resolve">;
      launcher: TvosRunnerLauncher;
      ports: { allocate(deviceId: string): number; release(deviceId: string, port: number): void };
      timer?: Timer;
    },
  ) {}

  /** For callers whose session is already bound; startDevice starts before binding instead. */
  async ensure(request: {
    deviceId: string;
    ownerSession: string;
    sessions: TvosRunnerSessions;
    signal?: AbortSignal;
  }): Promise<string | undefined> {
    const started = await this.start(request);
    return this.attach(request) ?? started.runnerUnavailable;
  }

  /** Launch without session ownership; only a newly launched runner supplies failure cleanup. */
  async start(request: {
    deviceId: string;
    sessions?: TvosRunnerSessions;
    signal?: AbortSignal;
  }): Promise<{ runnerUnavailable?: string; stop?: () => void }> {
    return this.startOwned(request);
  }

  /** One replacement per device; cancellation belongs to all waiters and the previous session. */
  async restartOwned(deviceId: string, signal?: AbortSignal): Promise<TvosRunnerRestartResult> {
    return this.restarts.run(
      deviceId,
      async (flightSignal) => {
        if (tvosRunners.get(deviceId)?.isUsable()) {
          return {};
        }
        const previous = this.runners.get(deviceId);
        if (!previous) {
          // External clients retain their own command errors; only owned runners can recover.
          const unownedRunner = tvosRunners.get(deviceId);
          if (unownedRunner) {
            return { unownedRunner };
          }
          return { runnerUnavailable: "the runner is not owned by this lifecycle" };
        }
        const controller = new AbortController();
        try {
          const startup = this.startOwned(
            {
              deviceId,
              signal: combineAbortSignals(flightSignal, controller.signal),
            },
            previous.ownerSession,
          );
          return await raceWithDeadline(startup, {
            timer: this.dependencies.timer ?? defaultTimer,
            timeoutMs: 65_000,
            signal: combineAbortSignals(
              flightSignal,
              this.runners.get(deviceId)?.controller.signal,
            ),
            label: "tvOS runner recovery",
            onTimeout: () => controller.abort(),
          });
        } catch (error) {
          throw new ActionableError(
            `tvOS runner recovery failed: ${errorMessage(error)}. Call startDevice to restart the runner.`,
            { cause: error },
          );
        } finally {
          controller.abort();
        }
      },
      signal,
      { cancelWhenAllWaitersAbort: true },
    );
  }

  private async startOwned(
    request: {
      deviceId: string;
      sessions?: TvosRunnerSessions;
      signal?: AbortSignal;
    },
    ownerSession?: string,
  ): Promise<{ runnerUnavailable?: string; stop?: () => void }> {
    const { deviceId, sessions } = request;
    if (sessions) {
      this.observeSessions(sessions);
    }
    if (tvosRunners.get(deviceId)?.isUsable()) {
      return {};
    }
    this.stop(deviceId);
    const entry: OwnedRunner = { controller: new AbortController(), ownerSession };
    const signal = combineAbortSignals(request.signal, entry.controller.signal)!;
    this.runners.set(deviceId, entry);
    const onAbort = () => {
      if (this.runners.get(deviceId) === entry) {
        this.stop(deviceId);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      signal.throwIfAborted();
      const xctestrun = await this.dependencies.artifacts.resolve(signal);
      signal.throwIfAborted();
      entry.port = this.dependencies.ports.allocate(deviceId);
      const handle = await this.dependencies.launcher.launch({
        deviceId,
        xctestrun,
        port: entry.port,
        signal,
      });
      entry.stop = handle.stop;
      if (signal.aborted || this.runners.get(deviceId) !== entry) {
        if (this.runners.get(deviceId) !== entry) {
          handle.stop();
        }
        throw new ActionableError("the tvos session ended during runner startup");
      }
      return {
        stop: () => {
          if (this.runners.get(deviceId) === entry) {
            this.stop(deviceId);
          }
        },
      };
    } catch (error) {
      if (this.runners.get(deviceId) === entry) {
        this.stop(deviceId, error);
      }
      const reason = errorMessage(error);
      logger.warn(`[TvosRunner] Runner unavailable for ${deviceId}: ${reason}`, error);
      return { runnerUnavailable: reason };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Transfer only lifecycle-owned runners to the newly bound session. */
  attach({
    deviceId,
    ownerSession,
    sessions,
  }: {
    deviceId: string;
    ownerSession: string;
    sessions: TvosRunnerSessions;
  }): string | undefined {
    this.observeSessions(sessions);
    if (!sessions.hasSession(ownerSession)) {
      this.stop(deviceId);
      return "the tvos session ended before runner startup";
    }
    const entry = this.runners.get(deviceId);
    if (entry) {
      entry.ownerSession = ownerSession;
    }
    return undefined;
  }

  stop(
    deviceId: string,
    reason: unknown = new ActionableError("Tvos runner lifecycle ended"),
  ): void {
    const entry = this.runners.get(deviceId);
    if (!entry) {
      return;
    }
    this.runners.delete(deviceId);
    entry.controller.abort(reason);
    try {
      entry.stop?.();
    } catch (error) {
      logger.warn(`[TvosRunner] Failed to stop runner for ${deviceId}`, error);
    } finally {
      if (entry.port !== undefined) {
        this.dependencies.ports.release(deviceId, entry.port);
      }
    }
  }

  stopSession(sessionId: string): void {
    for (const [deviceId, entry] of this.runners) {
      if (entry.ownerSession === sessionId) {
        this.stop(deviceId);
      }
    }
  }

  stopAll(): void {
    for (const deviceId of this.runners.keys()) {
      this.stop(deviceId);
    }
  }

  private observeSessions(sessions: TvosRunnerSessions): void {
    if (this.observedSessions.has(sessions)) {
      return;
    }
    this.observedSessions.add(sessions);
    sessions.onSessionRelease((sessionId) => this.stopSession(sessionId));
    sessions.onSessionDeviceUnbound((sessionId, deviceId) => {
      if (this.runners.get(deviceId)?.ownerSession === sessionId) {
        this.stop(deviceId);
      }
    });
  }
}

type TvosRunnerBuilder = Pick<
  IosCtrlProxyBuilder,
  "getXctestrunPath" | "getConfig" | "writeRunnerEnvironment"
> &
  Partial<Pick<IosCtrlProxyBuilder, "runExclusiveOnDerivedData">>;
let defaultBuilderFactory: (() => TvosRunnerBuilder) | undefined;

/** The server composition root supplies the process builder without eager artifact work. */
export function registerTvosRunnerBuilder(factory: () => TvosRunnerBuilder): void {
  defaultBuilderFactory = factory;
}

function getDefaultBuilder(): TvosRunnerBuilder {
  if (!defaultBuilderFactory) {
    throw new ActionableError("Tvos runner builder has not been registered by the server.");
  }
  return defaultBuilderFactory();
}

let defaultLifecycle: TvosRunnerLifecycle | undefined;
export function getTvosRunnerLifecycle(): TvosRunnerLifecycle {
  if (!defaultLifecycle) {
    defaultLifecycle = new TvosRunnerLifecycle({
      artifacts: new TvosRunnerArtifacts({
        release: new TvosRunnerReleaseProvider(),
        builder: {
          getXctestrunPath: (platform) => getDefaultBuilder().getXctestrunPath(platform),
          getConfig: () => getDefaultBuilder().getConfig(),
          runExclusiveOnDerivedData: (task) => {
            const builder = getDefaultBuilder();
            return builder.runExclusiveOnDerivedData
              ? builder.runExclusiveOnDerivedData(task)
              : task();
          },
        },
      }),
      launcher: new XcodebuildTvosRunnerLauncher({
        writeRunnerEnvironment: (file, env, deviceId) =>
          getDefaultBuilder().writeRunnerEnvironment(
            file,
            env,
            `${deviceId}-${defaultIdGenerator.next()}`,
          ),
      }),
      ports: {
        allocate: (deviceId) =>
          PortManager.allocate(`tvos:${deviceId}`, {
            reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS,
          }),
        release: (deviceId, port) => PortManager.releaseIfAllocated(`tvos:${deviceId}`, port),
      },
    });
    process.once("exit", () => defaultLifecycle?.stopAll());
  }
  return defaultLifecycle;
}

export function stopTvosRunners(): void {
  defaultLifecycle?.stopAll();
}
