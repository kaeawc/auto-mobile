import type { IosCtrlProxyBuilder } from "../../ctrlProxy/IosCtrlProxyBuilder";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import type { SessionManager } from "../../daemon/sessionManager";
import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { combineAbortSignals } from "../../utils/AbortContext";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../utils/PortManager";
import { TvosRunnerArtifacts } from "./TvosRunnerArtifacts";
import { XcodebuildTvosRunnerLauncher, type TvosRunnerLauncher } from "./TvosRunnerLauncher";
import { tvosRunners } from "./TvosRunnerRegistry";

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

/** Owns only runners launched here; a pre-registered runner is reused without taking ownership. */
export class TvosRunnerLifecycle {
  private readonly runners = new Map<string, OwnedRunner>();
  private readonly observedSessions = new WeakSet<TvosRunnerSessions>();
  constructor(
    private readonly dependencies: {
      artifacts: Pick<TvosRunnerArtifacts, "resolve">;
      launcher: TvosRunnerLauncher;
      ports: { allocate(deviceId: string): number; release(deviceId: string, port: number): void };
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
    const { deviceId, sessions } = request;
    if (sessions) {
      this.observeSessions(sessions);
    }
    if (tvosRunners.get(deviceId)?.isUsable()) {
      return {};
    }
    this.stop(deviceId);
    const entry: OwnedRunner = { controller: new AbortController() };
    const signal = combineAbortSignals(request.signal, entry.controller.signal)!;
    this.runners.set(deviceId, entry);
    try {
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
        this.stop(deviceId);
      }
      const reason = errorMessage(error);
      logger.warn(`[TvosRunner] Runner unavailable for ${deviceId}: ${reason}`, error);
      return { runnerUnavailable: reason };
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

  stop(deviceId: string): void {
    const entry = this.runners.get(deviceId);
    if (!entry) {
      return;
    }
    this.runners.delete(deviceId);
    entry.controller.abort(new ActionableError("Tvos runner lifecycle ended"));
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
