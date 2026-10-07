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
} from "../server/appearanceManager";
import { DeviceSessionManager } from "../devices/DeviceSessionManager";
import { applyAppearanceToDevice } from "../utils/deviceAppearance";
import {
  DEFAULT_APPEARANCE_APPLY_DEADLINE_MS,
  triggerAppearanceSync,
} from "./AppearanceSyncScheduler";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { isAppearanceSyncEnabledFromEnvironment } from "../utils/appearance/appearanceSyncPolicy";
import { DaemonState } from "./daemonState";
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
  getCurrentDevice(): BootedDevice | undefined;
  /** Session registry owner, including derived device-label session IDs. */
  getSessionForDevice(deviceId: string): string | null;
}

const defaultDeviceSource: AppearanceDeviceSource = {
  getPooledDevices: () => {
    const daemonState = DaemonState.getInstance();
    if (!daemonState.isInitialized()) {
      return [];
    }
    return daemonState
      .getDevicePool()
      .getAllDevices()
      .map((device) => ({
        deviceId: device.id,
        name: device.name,
        platform: device.platform,
      }));
  },
  getCurrentDevice: () => DeviceSessionManager.getInstance().getCurrentDevice(),
  getSessionForDevice: (deviceId) => {
    const daemonState = DaemonState.getInstance();
    return daemonState.isInitialized()
      ? daemonState.getSessionManager().getSessionForDevice(deviceId)
      : null;
  },
};

export interface AppearanceSocketServerDependencies {
  getConfig: () => Promise<AppearanceConfig>;
  updateConfig: (update: AppearanceConfigInput | null) => Promise<AppearanceConfig>;
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
    private readonly authenticator: StreamSocketAuthenticator = createDefaultStreamSocketAuthenticator(
      "appearance",
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
        const config = await this.dependencies.getConfig();
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
    const config = await this.dependencies.updateConfig({ syncWithHost: enabled });
    const appliedMode = await this.applyToTargets(config, request.sessionUuid);
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
    const config = await this.dependencies.updateConfig({
      defaultMode: normalizedMode,
      syncWithHost: normalizedMode === "auto",
    });
    const appliedMode = await this.applyToTargets(config, request.sessionUuid, normalizedMode);
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
    sessionUuid: string | undefined,
    explicitMode?: string,
  ): Promise<AppearanceMode | null> {
    const mode =
      explicitMode && explicitMode !== "auto"
        ? (explicitMode as AppearanceMode)
        : await this.dependencies.resolveMode(config);

    const targets = this.getTargets(sessionUuid);
    if (targets.length === 0) {
      return null;
    }

    for (const device of targets) {
      try {
        await raceWithDeadline(() => this.dependencies.applyToDevice(device, mode), {
          timer: this.timer,
          timeoutMs: this.dependencies.applyDeadlineMs ?? DEFAULT_APPEARANCE_APPLY_DEADLINE_MS,
          label: `Appearance apply for ${device.deviceId}`,
        });
      } catch (error) {
        logger.warn(`[Appearance] Failed to apply appearance to ${device.deviceId}: ${error}`);
      }
    }

    return mode;
  }

  private getTargets(sessionUuid: string | undefined): BootedDevice[] {
    const targets = new Map<string, BootedDevice>();

    for (const device of this.deviceSource.getPooledDevices()) {
      targets.set(device.deviceId, device);
    }

    const current = this.deviceSource.getCurrentDevice();
    if (current) {
      targets.set(current.deviceId, current);
    }

    if (this.authenticator.isAuthenticationEnforced?.() === false) {
      // AUTOMOBILE_DAEMON_STREAM_AUTH=0 leaves no verified caller identity;
      // preserve the existing all-pooled-plus-current targeting in auth-off mode.
      return [...targets.values()];
    }

    const callerBase =
      this.authenticator.resolveSessionIdentity?.(sessionUuid) ?? sessionUuid?.trim();
    const owned = [...targets.values()].filter((device) => {
      const owner = this.deviceSource.getSessionForDevice(device.deviceId);
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
