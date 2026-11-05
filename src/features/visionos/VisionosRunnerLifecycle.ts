import { defaultDaemonContext } from "../../daemon/daemonContext";
import { getToolSelectionContext } from "../toolSelection/toolSelectionContext";
import { SingleFlight } from "../../utils/cache/SingleFlight";
import type { IosCtrlProxyBuilder } from "../../ctrlProxy/IosCtrlProxyBuilder";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import type { SessionManager } from "../../daemon/sessionManager";
import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { combineAbortSignals } from "../../utils/AbortContext";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../utils/PortManager";
import { VisionosRunnerArtifacts } from "./VisionosRunnerArtifacts";
import {
  XcodebuildVisionosRunnerLauncher,
  type VisionosRunnerLauncher,
} from "./VisionosRunnerLauncher";
import { visionosRunners } from "./VisionosRunnerRegistry";

type VisionosRunnerSessions = Pick<
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
export class VisionosRunnerLifecycle {
  private readonly starts = new SingleFlight<
    string,
    { runnerUnavailable?: string; stop?: () => void }
  >();
  private readonly runners = new Map<string, OwnedRunner>();
  private readonly observedSessions = new WeakSet<VisionosRunnerSessions>();
  constructor(
    private readonly dependencies: {
      artifacts: Pick<VisionosRunnerArtifacts, "resolve">;
      launcher: VisionosRunnerLauncher;
      ports: { allocate(deviceId: string): number; release(deviceId: string, port: number): void };
    },
  ) {}

  /** Bind on-demand automation to an existing session when one owns the call. */
  async ensure(request: {
    deviceId: string;
    ownerSession: string;
    sessions: VisionosRunnerSessions;
    signal?: AbortSignal;
  }): Promise<string | undefined> {
    const started = await this.start(request);
    return this.attach(request) ?? started.runnerUnavailable;
  }

  /** Launch without session ownership; only a newly launched runner supplies failure cleanup. */
  async start(request: {
    deviceId: string;
    sessions?: VisionosRunnerSessions;
    signal?: AbortSignal;
  }): Promise<{ runnerUnavailable?: string; stop?: () => void }> {
    return this.starts.run(
      request.deviceId,
      (signal) => this.startOwned({ ...request, signal }),
      request.signal,
      { cancelWhenAllWaitersAbort: true },
    );
  }

  private async startOwned(request: {
    deviceId: string;
    sessions?: VisionosRunnerSessions;
    signal?: AbortSignal;
  }): Promise<{ runnerUnavailable?: string; stop?: () => void }> {
    const { deviceId, sessions } = request;
    if (sessions) {
      this.observeSessions(sessions);
    }
    if (visionosRunners.get(deviceId)?.isUsable()) {
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
        throw new ActionableError("the visionos session ended during runner startup");
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
      logger.warn(`[VisionosRunner] Runner unavailable for ${deviceId}: ${reason}`, error);
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
    sessions: VisionosRunnerSessions;
  }): string | undefined {
    this.observeSessions(sessions);
    if (!sessions.hasSession(ownerSession)) {
      this.stop(deviceId);
      return "the visionos session ended before runner startup";
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
    entry.controller.abort(new ActionableError("Visionos runner lifecycle ended"));
    try {
      entry.stop?.();
    } catch (error) {
      logger.warn(`[VisionosRunner] Failed to stop runner for ${deviceId}`, error);
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

  private observeSessions(sessions: VisionosRunnerSessions): void {
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

type VisionosRunnerBuilder = Pick<
  IosCtrlProxyBuilder,
  "getXctestrunPath" | "getConfig" | "writeRunnerEnvironment"
> &
  Partial<Pick<IosCtrlProxyBuilder, "runExclusiveOnDerivedData">>;
let defaultBuilderFactory: (() => VisionosRunnerBuilder) | undefined;

/** The server composition root supplies the process builder without eager artifact work. */
export function registerVisionosRunnerBuilder(factory: () => VisionosRunnerBuilder): void {
  defaultBuilderFactory = factory;
}

function getDefaultBuilder(): VisionosRunnerBuilder {
  if (!defaultBuilderFactory) {
    throw new ActionableError("Visionos runner builder has not been registered by the server.");
  }
  return defaultBuilderFactory();
}

let defaultLifecycle: VisionosRunnerLifecycle | undefined;
export function getVisionosRunnerLifecycle(): VisionosRunnerLifecycle {
  if (!defaultLifecycle) {
    defaultLifecycle = new VisionosRunnerLifecycle({
      artifacts: new VisionosRunnerArtifacts({
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
      launcher: new XcodebuildVisionosRunnerLauncher({
        writeRunnerEnvironment: (file, env, deviceId) =>
          getDefaultBuilder().writeRunnerEnvironment(
            file,
            env,
            `${deviceId}-${defaultIdGenerator.next()}`,
          ),
      }),
      ports: {
        allocate: (deviceId) =>
          PortManager.allocate(`visionos:${deviceId}`, {
            reservedPorts: IOS_CTRL_PROXY_RESERVED_PORTS,
          }),
        release: (deviceId, port) => PortManager.releaseIfAllocated(`visionos:${deviceId}`, port),
      },
    });
    process.once("exit", () => defaultLifecycle?.stopAll());
  }
  return defaultLifecycle;
}

export function stopVisionosRunners(): void {
  defaultLifecycle?.stopAll();
}

/** Boot/provision remain simctl-only; automation starts on the first window-app command. */
export async function requireVisionosRunner(
  deviceId: string,
  signal?: AbortSignal,
  lifecycle?: Pick<VisionosRunnerLifecycle, "start" | "attach">,
) {
  signal?.throwIfAborted();
  if (!visionosRunners.get(deviceId)?.isUsable()) {
    lifecycle ??= getVisionosRunnerLifecycle();
    const result = await lifecycle.start({ deviceId, signal });
    signal?.throwIfAborted();
    if (result.runnerUnavailable) {
      throw new ActionableError(
        `visionOS window-app runner unavailable: ${result.runnerUnavailable}`,
      );
    }
  }
  attachVisionosRunnerToSession(deviceId, lifecycle);
  return visionosRunners.require(deviceId);
}

function attachVisionosRunnerToSession(
  deviceId: string,
  lifecycle: Pick<VisionosRunnerLifecycle, "attach"> | undefined,
): void {
  const ownerSession = getToolSelectionContext()?.routingSessionUuid;
  const sessions = defaultDaemonContext.sessionManager();
  if (ownerSession && sessions?.hasSession(ownerSession)) {
    const unavailable = (lifecycle ?? defaultLifecycle)?.attach({
      deviceId,
      ownerSession,
      sessions,
    });
    if (unavailable) {
      throw new ActionableError(unavailable);
    }
  }
}

/** A lifecycle-only call must not instantiate or build the automation runner. */
export function stopVisionosRunner(deviceId: string): void {
  defaultLifecycle?.stop(deviceId);
}
