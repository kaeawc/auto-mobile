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
import { visionosTargetApps } from "./VisionosTargetApps";

type VisionosRunnerSessions = Pick<
  SessionManager,
  "hasSession" | "onSessionRelease" | "onSessionDeviceUnbound"
>;
interface OwnedRunner {
  ownerSession?: string;
  controller: AbortController;
  stop?: () => void;
  port?: number;
  /** The window app the runner was started to automate; absent means its demo app. */
  bundleId?: string;
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
      /** The device's window app, when known; absent keeps the runner on its demo app. */
      targetBundleId?: (deviceId: string) => string | undefined;
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
    if (visionosRunners.get(deviceId)?.isUsable() && !this.needsRestart(deviceId)) {
      return {};
    }
    this.stop(deviceId);
    const bundleId = this.dependencies.targetBundleId?.(deviceId);
    const entry: OwnedRunner = { controller: new AbortController(), bundleId };
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
        bundleId,
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

  /**
   * A runner this lifecycle started keeps its window app for its lifetime, so any change of
   * target restarts it, including losing the target when that app is terminated.
   */
  needsRestart(deviceId: string): boolean {
    const entry = this.runners.get(deviceId);
    return entry !== undefined && entry.bundleId !== this.dependencies.targetBundleId?.(deviceId);
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
    const entry = this.runners.get(deviceId);
    if (!sessions.hasSession(ownerSession)) {
      // A runner another live session already owns must outlive this caller's ended session.
      if (!entry?.ownerSession) {
        this.stop(deviceId);
      }
      return "the visionos session ended before runner startup";
    }
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

type VisionosArtifactBuilder = ConstructorParameters<typeof VisionosRunnerArtifacts>[0]["builder"];
/** Lazily adapts the registered process builder for artifact resolution, forwarding every argument. */
export function createVisionosArtifactBuilder(
  getBuilder: () => VisionosArtifactBuilder,
): VisionosArtifactBuilder {
  return {
    getXctestrunPath: (platform, options) => getBuilder().getXctestrunPath(platform, options),
    getConfig: () => getBuilder().getConfig(),
    runExclusiveOnDerivedData: (task) => {
      const builder = getBuilder();
      return builder.runExclusiveOnDerivedData ? builder.runExclusiveOnDerivedData(task) : task();
    },
  };
}

let defaultLifecycle: VisionosRunnerLifecycle | undefined;
export function getVisionosRunnerLifecycle(): VisionosRunnerLifecycle {
  if (!defaultLifecycle) {
    defaultLifecycle = new VisionosRunnerLifecycle({
      artifacts: new VisionosRunnerArtifacts({
        builder: createVisionosArtifactBuilder(getDefaultBuilder),
      }),
      launcher: new XcodebuildVisionosRunnerLauncher({
        writeRunnerEnvironment: (file, env, deviceId) =>
          getDefaultBuilder().writeRunnerEnvironment(
            file,
            env,
            `${deviceId}-${defaultIdGenerator.next()}`,
          ),
      }),
      // The app the session launched on this device, else the optional env override.
      targetBundleId: (deviceId) =>
        visionosTargetApps.get(deviceId) ?? globalThis.process.env.CTRL_PROXY_IOS_BUNDLE_ID,
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
  lifecycle?: Pick<VisionosRunnerLifecycle, "start" | "attach"> &
    Partial<Pick<VisionosRunnerLifecycle, "needsRestart">>,
) {
  signal?.throwIfAborted();
  if (
    !visionosRunners.get(deviceId)?.isUsable() ||
    (lifecycle ?? defaultLifecycle)?.needsRestart?.(deviceId)
  ) {
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
  // An ended routing session still reaches attach, which stops the unowned runner this call started.
  if (ownerSession && sessions) {
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
