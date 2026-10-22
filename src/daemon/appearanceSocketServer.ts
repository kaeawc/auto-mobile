import { SocketServerSingleton } from "./socketServerSingleton";
import { logger } from "../utils/logger";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { RequestResponseSocketServer, getSocketPath } from "./socketServer/index";
import {
  AppearanceSocketRequest,
  AppearanceSocketResponse,
  AppearanceSocketCommand,
} from "./appearanceSocketTypes";
import {
  getAppearanceConfig,
  resolveAppearanceMode,
  updateAppearanceConfig,
} from "./appearanceManager";
import { resolveDirectSessionDevice } from "../utils/directSessionDeviceRegistry";
import { applyAppearanceToDevice } from "../utils/deviceAppearance";
import {
  DEFAULT_APPEARANCE_APPLY_DEADLINE_MS,
  triggerAppearanceSync,
} from "./AppearanceSyncScheduler";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { runWithAbortSignal } from "../utils/AbortContext";
import { recordDeviceSettingDefaultsBeforeChange } from "../features/utility/DeviceSettingDefaults";
import {
  executionTracker,
  sessionExecutionMetadataOf,
  type ActiveExecution,
} from "./executionTracker";
import { admitInputOnHolderSession } from "./inputDeviceOwnership";
import { sessionReleaseThatCancelledCall } from "./sessionReleasedDuringCall";
import { isAppearanceSyncEnabledFromEnvironment } from "../utils/appearance/appearanceSyncPolicy";
import { defaultDaemonContext } from "./daemonContext";
import type {
  AppearanceConfig,
  AppearanceConfigInput,
  AppearanceMode,
  BootedDevice,
} from "../models";
import { APPEARANCE_SOCKET_CONFIG } from "./daemonFiles";
import {
  createDefaultStreamSocketAuthenticator,
  type StreamSocketAuthenticator,
} from "./streamSocketAuth";

const VALID_MODES = new Set(["light", "dark", "auto"]);
const AUTOMATIC_SYNC_DISABLED_WARNING =
  "Automatic appearance sync is disabled by AUTOMOBILE_APPEARANCE_SYNC.";

export interface AppearanceDeviceSource {
  getPooledDevices(): BootedDevice[];
  getSessionDevice(sessionUuid: string | undefined): BootedDevice | undefined;
  /** Daemon registry owner (including label sessions), or the caller's matching direct registration. */
  getSessionForDevice(deviceId: string, sessionUuid?: string): string | null;
  /**
   * The registry that admits control calls on a holder's session. A source without one (direct
   * mode, or a fake that models no session lifecycle) admits every apply.
   */
  getSessionManager?(): object | undefined;
}

/** A device a command will re-theme, with the execution tracking it on its holder's session. */
interface AppearanceTarget {
  device: BootedDevice;
  execution?: ActiveExecution;
}

const defaultDeviceSource: AppearanceDeviceSource = {
  getPooledDevices: () => {
    const pool = defaultDaemonContext.devicePool();
    if (!pool) {
      return [];
    }
    return pool.getAllDevices().map((device) => ({
      deviceId: device.id,
      name: device.name,
      platform: device.platform,
    }));
  },
  getSessionDevice: (sessionUuid) => {
    if (!sessionUuid) {
      return undefined;
    }
    const manager = defaultDaemonContext.sessionManager();
    if (!manager) {
      return resolveDirectSessionDevice(sessionUuid)?.device;
    }
    const deviceId = manager.getDeviceForSession(sessionUuid);
    const device = deviceId ? defaultDaemonContext.devicePool()?.getDevice(deviceId) : undefined;
    return device
      ? { deviceId: device.id, name: device.name, platform: device.platform }
      : undefined;
  },
  getSessionForDevice: (deviceId, sessionUuid) => {
    const manager = defaultDaemonContext.sessionManager();
    if (manager) {
      return manager.getSessionForDevice(deviceId);
    }
    const direct = sessionUuid ? resolveDirectSessionDevice(sessionUuid) : undefined;
    return direct?.device.deviceId === deviceId ? direct.sessionUuid : null;
  },
  getSessionManager: () => defaultDaemonContext.sessionManager(),
};

export interface AppearanceSocketServerDependencies {
  getConfig: (sessionKey?: string) => Promise<AppearanceConfig>;
  updateConfig: (
    update: AppearanceConfigInput | null,
    sessionKey?: string,
  ) => Promise<AppearanceConfig>;
  resolveMode: (config: AppearanceConfig) => Promise<AppearanceMode>;
  applyToDevice: (device: BootedDevice, mode: AppearanceMode) => Promise<void>;
  triggerSync: () => Promise<void>;
  isSyncEnabled?: () => boolean;
  applyDeadlineMs?: number;
}

const defaultDependencies: AppearanceSocketServerDependencies = {
  getConfig: getAppearanceConfig,
  updateConfig: updateAppearanceConfig,
  resolveMode: resolveAppearanceMode,
  applyToDevice: applyAppearanceToDevice,
  triggerSync: triggerAppearanceSync,
  isSyncEnabled: isAppearanceSyncEnabledFromEnvironment,
};

/**
 * Socket server for appearance configuration.
 * Handles get_appearance_config, set_appearance_sync, and set_appearance commands.
 */
export class AppearanceSocketServer extends RequestResponseSocketServer<
  AppearanceSocketRequest,
  AppearanceSocketResponse
> {
  constructor(
    socketPath: string = getSocketPath(APPEARANCE_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    protected readonly authenticator: StreamSocketAuthenticator = createDefaultStreamSocketAuthenticator(
      "appearance",
      // An observer may store its own config; it applies once the observer holds a device (#10976).
      { allowObserverSessions: true },
    ),
    private readonly deviceSource: AppearanceDeviceSource = defaultDeviceSource,
    private readonly dependencies: AppearanceSocketServerDependencies = defaultDependencies,
  ) {
    super(socketPath, timer, "Appearance");
  }

  protected bypassesRequestChain(request: AppearanceSocketRequest): boolean {
    // This read-only request is safe to bypass: replies carry the request id and
    // the shipped client sends one request per connection. A pipelining client
    // that assumes in-order replies would see reordering.
    return (request.command ?? request.method) === "get_appearance_config";
  }

  protected async handleRequest(
    request: AppearanceSocketRequest,
  ): Promise<AppearanceSocketResponse> {
    const command = (request.command ?? request.method) as AppearanceSocketCommand | undefined;

    switch (command) {
      case "get_appearance_config": {
        const config = await this.dependencies.getConfig(this.configKey(request.sessionUuid));
        return {
          id: request.id,
          type: "appearance_response",
          success: true,
          result: { config },
        };
      }
      case "set_appearance_sync":
        return this.handleSetAppearanceSync(request);
      case "set_appearance":
        return this.handleSetAppearance(request);
      default:
        throw new Error(`Unsupported appearance command: ${command}`);
    }
  }

  private async handleSetAppearanceSync(
    request: AppearanceSocketRequest,
  ): Promise<AppearanceSocketResponse> {
    this.authenticator.authorize({ sessionUuid: request.sessionUuid });
    const enabled = request.params?.enabled ?? request.enabled;
    if (typeof enabled !== "boolean") {
      throw new Error("set_appearance_sync requires enabled boolean");
    }
    return this.asControlCall("set_appearance_sync", request.sessionUuid, async (targets) => {
      const config = await this.dependencies.updateConfig(
        { syncWithHost: enabled },
        this.configKey(request.sessionUuid),
      );
      const appliedMode = await this.applyToTargets(config, targets);
      await this.dependencies.triggerSync();
      return {
        id: request.id,
        type: "appearance_response",
        success: true,
        result: {
          config,
          appliedMode: appliedMode ?? undefined,
          ...this.automaticSyncWarning(enabled),
        },
      };
    });
  }

  private async handleSetAppearance(
    request: AppearanceSocketRequest,
  ): Promise<AppearanceSocketResponse> {
    this.authenticator.authorize({ sessionUuid: request.sessionUuid });
    const mode = request.params?.mode ?? request.mode;
    if (!mode || !VALID_MODES.has(String(mode).toLowerCase())) {
      throw new Error("set_appearance requires mode: light | dark | auto");
    }
    const normalizedMode = String(mode).toLowerCase();
    return this.asControlCall("set_appearance", request.sessionUuid, async (targets) => {
      const config = await this.dependencies.updateConfig(
        {
          defaultMode: normalizedMode,
          syncWithHost: normalizedMode === "auto",
        },
        this.configKey(request.sessionUuid),
      );
      const appliedMode = await this.applyToTargets(config, targets, normalizedMode);
      await this.dependencies.triggerSync();
      return {
        id: request.id,
        type: "appearance_response",
        success: true,
        result: {
          config,
          appliedMode: appliedMode ?? undefined,
          ...this.automaticSyncWarning(normalizedMode === "auto"),
        },
      };
    });
  }

  /**
   * Re-theming a held device is a control call on its holder's session (#11486). Each target's
   * holder passes the admission `input/*` passes before the command stores or applies anything: a
   * suspect, lapsed or idle-expired holder refuses the whole command. The admitted executions stay
   * in flight until the command settles, so no holder is released under its apply. With stream
   * auth off there is no verified caller, and targets are applied without admission as before.
   */
  private async asControlCall<T>(
    command: string,
    sessionUuid: string | undefined,
    run: (targets: AppearanceTarget[]) => Promise<T>,
  ): Promise<T> {
    const targets: AppearanceTarget[] = [];
    try {
      for (const device of this.getTargets(sessionUuid)) {
        const target: AppearanceTarget = { device };
        targets.push(target);
        await this.admitOnHolderSession(command, target);
      }
      return await run(targets);
    } finally {
      for (const { execution } of targets) {
        if (execution) {
          executionTracker.endExecution(execution.id);
        }
      }
    }
  }

  private async admitOnHolderSession(command: string, target: AppearanceTarget): Promise<void> {
    const deviceId = target.device.deviceId;
    const sessionManager = this.deviceSource.getSessionManager?.();
    if (!sessionManager || this.authenticator.isAuthenticationEnforced?.() === false) {
      // AUTOMOBILE_DAEMON_STREAM_AUTH=0 keeps its all-devices targeting with no ownership lookup.
      return;
    }
    const holderSessionUuid = this.deviceSource.getSessionForDevice(deviceId);
    if (!holderSessionUuid) {
      return;
    }
    const execution = executionTracker.startExecution(command, undefined, holderSessionUuid);
    target.execution = execution;
    executionTracker.bindDeviceExecution(execution.id, deviceId);
    await admitInputOnHolderSession({
      deviceId,
      holderSessionUuid,
      sessionManager,
      execution: sessionExecutionMetadataOf(execution),
    });
    const signal = execution.abortController.signal;
    if (signal.aborted) {
      // A release that landed while admission was awaited answers its own refusal.
      throw sessionReleaseThatCancelledCall(execution.cancelReason) ?? signal.reason;
    }
    // With a verified identity every target is the caller's own, so this is use of its session.
    executionTracker.markSessionAdmitted(execution.id);
  }

  protected createErrorResponse(id: string | undefined, error: string): AppearanceSocketResponse {
    return {
      id: id ?? "unknown",
      type: "appearance_response",
      success: false,
      error,
    };
  }

  private automaticSyncWarning(
    automaticSyncRequested: boolean,
  ): { warning: string } | Record<string, never> {
    return automaticSyncRequested &&
      !(this.dependencies.isSyncEnabled ?? isAppearanceSyncEnabledFromEnvironment)()
      ? { warning: AUTOMATIC_SYNC_DISABLED_WARNING }
      : {};
  }

  private async applyToTargets(
    config: AppearanceConfig,
    targets: AppearanceTarget[],
    explicitMode?: string,
  ): Promise<AppearanceMode | null> {
    const mode =
      explicitMode && explicitMode !== "auto"
        ? (explicitMode as AppearanceMode)
        : await this.dependencies.resolveMode(config);

    if (targets.length === 0) {
      return null;
    }

    for (const target of targets) {
      const { device } = target;
      try {
        await raceWithDeadline(() => this.applyToTarget(target, mode), {
          timer: this.timer,
          timeoutMs: this.dependencies.applyDeadlineMs ?? DEFAULT_APPEARANCE_APPLY_DEADLINE_MS,
          label: `Appearance apply for ${device.deviceId}`,
        });
      } catch (error) {
        const released = sessionReleaseThatCancelledCall(target.execution?.cancelReason);
        if (released) {
          // The holder's session was released under the apply: the command answers that refusal.
          throw released;
        }
        logger.warn(`[Appearance] Failed to apply appearance to ${device.deviceId}: ${error}`);
      }
    }

    return mode;
  }

  /**
   * Record the device default first, so the next session to acquire the device gets it back
   * (#11145), then apply under the tracked call's signal so a release cuts the device work.
   */
  private async applyToTarget(target: AppearanceTarget, mode: AppearanceMode): Promise<void> {
    const apply = async () => {
      await recordDeviceSettingDefaultsBeforeChange(target.device, ["nightMode"]);
      await this.dependencies.applyToDevice(target.device, mode);
    };
    const signal = target.execution?.abortController.signal;
    await (signal ? runWithAbortSignal(signal, apply) : apply());
  }

  /**
   * The key the caller's config is stored under: its base session identity. With no verified
   * identity (auth off, or no session) the single global config is used.
   */
  private configKey(sessionUuid: string | undefined): string | undefined {
    if (this.authenticator.isAuthenticationEnforced?.() === false) {
      return undefined;
    }
    return (
      this.authenticator.resolveSessionIdentity?.(sessionUuid) ?? (sessionUuid?.trim() || undefined)
    );
  }

  private getTargets(requestedSessionUuid: string | undefined): BootedDevice[] {
    // The stream authenticator accepts a padded UUID; look it up as it authorized it (#14379).
    const sessionUuid = requestedSessionUuid?.trim() || undefined;
    const targets = new Map<string, BootedDevice>();

    for (const device of this.deviceSource.getPooledDevices()) {
      targets.set(device.deviceId, device);
    }

    const sessionDevice = this.deviceSource.getSessionDevice(sessionUuid);
    if (sessionDevice) {
      targets.set(sessionDevice.deviceId, sessionDevice);
    }

    if (this.authenticator.isAuthenticationEnforced?.() === false) {
      // AUTOMOBILE_DAEMON_STREAM_AUTH=0 leaves no verified caller identity;
      // target pooled devices plus the requesting session's direct device.
      return [...targets.values()];
    }

    const callerBase = this.configKey(sessionUuid);
    const owned = [...targets.values()].filter((device) => {
      const owner = this.deviceSource.getSessionForDevice(device.deviceId, sessionUuid);
      if (!callerBase || !owner) {
        return false;
      }
      const ownerBase = this.authenticator.resolveSessionIdentity?.(owner) ?? owner;
      return ownerBase === callerBase;
    });
    if (owned.length === 0) {
      logger.info(`[Appearance] Session ${callerBase ?? "unknown"} owns no device; config stored`);
    }
    return owned;
  }
}

const socketServer = new SocketServerSingleton<AppearanceSocketServer>();

export function getAppearanceSocketPath(): string {
  return socketServer.instance?.getSocketPath() ?? getSocketPath(APPEARANCE_SOCKET_CONFIG);
}

export async function startAppearanceSocketServer(): Promise<void> {
  await socketServer.start(() => new AppearanceSocketServer());
}

export async function stopAppearanceSocketServer(): Promise<void> {
  await socketServer.stop();
}
