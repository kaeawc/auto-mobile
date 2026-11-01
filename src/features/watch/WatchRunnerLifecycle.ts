import type { IosCtrlProxyBuilder } from "../../ctrlProxy/IosCtrlProxyBuilder";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import type { SessionManager } from "../../daemon/sessionManager";
import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { combineAbortSignals } from "../../utils/AbortContext";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../utils/PortManager";
import { WatchRunnerArtifacts } from "./WatchRunnerArtifacts";
import { XcodebuildWatchRunnerLauncher, type WatchRunnerLauncher } from "./WatchRunnerLauncher";
import { watchRunners } from "./WatchRunnerRegistry";

type WatchRunnerSessions = Pick<
  SessionManager,
  "hasSession" | "onSessionRelease" | "onSessionDeviceUnbound"
>;
interface OwnedRunner {
  ownerSession?: string;
  controller: AbortController;
  stop?: () => void;
  port?: number;
}

/** Owns only runners launched here; usable pre-registered runners are reused without taking ownership. */
export class WatchRunnerLifecycle {
  private readonly runners = new Map<string, OwnedRunner>();
  private readonly observedSessions = new WeakSet<WatchRunnerSessions>();
  constructor(
    private readonly dependencies: {
      artifacts: Pick<WatchRunnerArtifacts, "resolve">;
      launcher: WatchRunnerLauncher;
      ports: { allocate(deviceId: string): number; release(deviceId: string, port: number): void };
    },
  ) {}

  /** For callers whose session is already bound; startDevice starts before binding instead. */
  async ensure(request: {
    deviceId: string;
    ownerSession: string;
    sessions: WatchRunnerSessions;
    signal?: AbortSignal;
  }): Promise<string | undefined> {
    const started = await this.start(request);
    return this.attach(request) ?? started.runnerUnavailable;
  }

  /** Launch without session ownership; only a newly launched runner supplies failure cleanup. */
  async start(request: {
    deviceId: string;
    sessions?: WatchRunnerSessions;
    signal?: AbortSignal;
  }): Promise<{ runnerUnavailable?: string; stop?: () => void }> {
    const { deviceId, sessions } = request;
    if (sessions) {
      this.observeSessions(sessions);
    }
    const registered = watchRunners.get(deviceId);
    if (registered?.isUsable()) {
      return {};
    }
    this.stop(deviceId);
    if (watchRunners.get(deviceId)) {
      return {
        runnerUnavailable: `The watch runner for ${deviceId} is disconnected and was not started by AutoMobile; restart it before trying again.`,
      };
    }
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
        throw new ActionableError("the watch session ended during runner startup");
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
      logger.warn(`[WatchRunner] Runner unavailable for ${deviceId}: ${reason}`, error);
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
    sessions: WatchRunnerSessions;
  }): string | undefined {
    this.observeSessions(sessions);
    if (!sessions.hasSession(ownerSession)) {
      this.stop(deviceId);
      return "the watch session ended before runner startup";
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
    entry.controller.abort(new ActionableError("Watch runner lifecycle ended"));
    try {
      entry.stop?.();
    } catch (error) {
      logger.warn(`[WatchRunner] Failed to stop runner for ${deviceId}`, error);
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

  private observeSessions(sessions: WatchRunnerSessions): void {
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

type WatchRunnerBuilder = Pick<
  IosCtrlProxyBuilder,
  "getXctestrunPath" | "getConfig" | "writeRunnerEnvironment"
> &
  Partial<Pick<IosCtrlProxyBuilder, "runExclusiveOnDerivedData">>;
let defaultBuilderFactory: (() => WatchRunnerBuilder) | undefined;

/** The server composition root supplies the process builder without eager artifact work. */
export function registerWatchRunnerBuilder(factory: () => WatchRunnerBuilder): void {
  defaultBuilderFactory = factory;
}

function getDefaultBuilder(): WatchRunnerBuilder {
  if (!defaultBuilderFactory) {
    throw new ActionableError("Watch runner builder has not been registered by the server.");
  }
  return defaultBuilderFactory();
}

let defaultLifecycle: WatchRunnerLifecycle | undefined;
export function getWatchRunnerLifecycle(): WatchRunnerLifecycle {
  if (!defaultLifecycle) {
    defaultLifecycle = new WatchRunnerLifecycle({
      artifacts: new WatchRunnerArtifacts({
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
      launcher: new XcodebuildWatchRunnerLauncher({
        writeRunnerEnvironment: (file, env, deviceId) =>
          getDefaultBuilder().writeRunnerEnvironment(
            file,
            env,
            `${deviceId}-${defaultIdGenerator.next()}`,
          ),
      }),
      ports: {
        allocate: (deviceId) =>
          PortManager.allocate(`watch:${deviceId}`, {
            reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS,
          }),
        release: (deviceId, port) => PortManager.releaseIfAllocated(`watch:${deviceId}`, port),
      },
    });
    process.once("exit", () => defaultLifecycle?.stopAll());
  }
  return defaultLifecycle;
}

export function stopWatchRunners(): void {
  defaultLifecycle?.stopAll();
}
