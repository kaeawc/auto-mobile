import type { DaemonStateAccess } from "./daemonRequestHandlers";
import type { BoundSessionLoss, DaemonOptions } from "./types";
import type { FrameDeviceIdentityPool } from "./frameDeviceIdentity";
import { defaultDaemonContext } from "./daemonContext";
import { SOCKET_PATH } from "./constants";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../utils/android-cmdline-tools/AdbClientFactory";
import type { FeatureFlagAdmin } from "../features/featureFlags/FeatureFlagService";
import type { DaemonSelfIdentity } from "./daemonHandshake";
import type { SessionToolSelectionService } from "../features/toolSelection/SessionToolSelectionService";
import type { InProcessMcpDispatcher } from "./inProcessMcpDispatcher";
import type { SocketBindGuardOptions, SocketFrameTraceEvent } from "./socketServer";

/** Recovery lookup is optional only for older socket-state fakes. */
export interface SocketDaemonStateAccess extends DaemonStateAccess {
  getSessionManager(): ReturnType<DaemonStateAccess["getSessionManager"]> & {
    ownershipSessionUuid?(sessionId: string): string;
    isReleasedSessionInRestartRecoveryWindow?(sessionId: string): Promise<boolean>;
    getExpiredReleaseSnapshot?(sessionId: string): Promise<BoundSessionLoss["release"]>;
  };
  getDevicePool(): ReturnType<DaemonStateAccess["getDevicePool"]> &
    FrameDeviceIdentityPool & {
      getDevice?(deviceId: string): { autolockSessionId?: string | null } | null | undefined;
      resolveOwnedDeviceSessionForMcpSession?(
        mcpSessionId: string | undefined,
        deviceId: string,
      ): string | undefined;
      isSessionOwnedByOtherConnection?(sessionId: string, mcpSessionId?: string): boolean;
      assertNotClaimedByForeignDaemon?(
        deviceId: string,
        platform: "android" | "ios",
        remedy?: string,
        maxAgeMs?: number,
      ): Promise<void>;
    };
}

export interface UnixSocketServerOptions {
  socketPath?: string;
  daemonState?: SocketDaemonStateAccess;
  timer?: Timer;
  featureFlagService?: FeatureFlagAdmin | null;
  handshakeConfig?: SocketHandshakeConfig;
  idGenerator?: IdGenerator;
  bindGuard?: SocketBindGuardOptions;
  adbClientFactory?: AdbClientFactory;
}

export interface SocketHandshakeConfig {
  identity?: DaemonSelfIdentity;
  identityStartedAt?: number;
  processGenerationToken?: string;
  startupOptions?: DaemonOptions;
  enforce?: boolean;
  onRepublishIdentity?: () => Promise<boolean>;
  dbPath?: string;
  pidFilePath?: string;
  startupCompletion?: Promise<void>;
  sockets?: Record<string, string>;
  processStartedAt?: number;
  onRestartAccepted?: () => void;
  liveAcceptanceStartupSecret?: string;
  acceptanceDiscoveryCapability?: string;
  sessionToolSelectionService?: Pick<SessionToolSelectionService, "isEnabled" | "setEnabled">;
  onFrameTrace?: (event: SocketFrameTraceEvent) => void;
  /**
   * Runs forwards in process (#11820). The daemon passes its own, so shutdown can close the
   * forwards still running; without one the server builds a default over the shared state.
   */
  mcpDispatcher?: Pick<InProcessMcpDispatcher, "connect">;
}

/** The original positional constructor remains available to clients and test subclasses. */
export type UnixSocketServerArguments = [
  socketPath?: string,
  ...UnixSocketServerLegacyDependencies,
];

export type UnixSocketServerLegacyDependencies = [
  daemonState?: SocketDaemonStateAccess,
  timer?: Timer,
  featureFlagService?: FeatureFlagAdmin | null,
  handshakeConfig?: SocketHandshakeConfig,
  idGenerator?: IdGenerator,
  bindGuard?: SocketBindGuardOptions,
  adbClientFactory?: AdbClientFactory,
];

export function resolveUnixSocketServerOptions(
  options: UnixSocketServerOptions,
): Required<UnixSocketServerOptions> {
  const {
    socketPath = SOCKET_PATH,
    daemonState = defaultDaemonContext.daemonState(),
    timer = defaultTimer,
    featureFlagService = null,
    handshakeConfig = {},
    idGenerator = defaultIdGenerator,
    bindGuard = {},
    adbClientFactory = defaultAdbClientFactory,
  } = options;
  return {
    socketPath,
    daemonState,
    timer,
    featureFlagService,
    handshakeConfig,
    idGenerator,
    bindGuard,
    adbClientFactory,
  };
}

export function positionalUnixSocketServerOptions(
  socketPath: string,
  [
    daemonState,
    timer,
    featureFlagService,
    handshakeConfig,
    idGenerator,
    bindGuard,
    adbClientFactory,
  ]: UnixSocketServerLegacyDependencies,
): UnixSocketServerOptions {
  return {
    socketPath,
    daemonState,
    timer,
    featureFlagService,
    handshakeConfig,
    idGenerator,
    bindGuard,
    adbClientFactory,
  };
}
