import { Server as NetServer, Socket } from "node:net";

import { dropToolCallRecording } from "../toolCallRecordingManager";
import { forgetDaemonSessionBindingScope } from "../daemonSessionBindingScopes";

import { logger } from "../../utils/logger";

import { GestureOwnershipRegistry } from "../gestureOwnership";

import { errorMessage } from "../../utils/describeUnknownError";

import { DaemonRequest, SessionContext, type DaemonOptions } from "../types";
import { SOCKET_PATH, DAEMON_HANDSHAKE_ENABLED } from "../wire/constants";

import { type DaemonSocketReachabilityLike } from "../daemonSocketReachability";

import { type DaemonSelfIdentity } from "../wire/daemonHandshake";

import { liveDaemonIdentity } from "../wire/buildIdentity";
import { defaultDaemonContext } from "../daemonContext";

import { Timer, defaultTimer } from "../../utils/SystemTimer";

import { ControlConnection } from "../socketServer/ControlConnection";
import { type IdGenerator, defaultIdGenerator } from "../../utils/IdGenerator";
import type { FeatureFlagAdmin } from "../../features/featureFlags/FeatureFlagService";
import { type SessionToolSelectionService } from "../../features/toolSelection/SessionToolSelectionService";

import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";

import type { BootedDevice } from "../../models";

import { RestartAdmission } from "../socketServer/restartAdmission";

import { type SocketFileIdentity } from "../socketFileIdentity";

import { type McpClientFactory } from "../socketServer/forwardSessionKey";

import { PendingRequestTracker } from "../socketServer/PendingRequestTracker";

import { createDaemonMcpDispatcher, type InProcessMcpDispatcher } from "../inProcessMcpDispatcher";

import {
  resolveIdentityStartedAt,
  snapshotDaemonOptions,
  SocketBindGuardOptions,
  SocketReclaimLock,
  SocketOwnerLiveness,
  resolveSocketBindGuard,
  AppendTextInput,
  CachedAppendTextInput,
  BoundMcpClient,
  SocketDaemonStateAccess,
  DeviceReadToolCallClassifier,
  registeredDeviceReadClassifier,
  SocketFrameTraceEvent,
} from "./socketServerContracts";

import type { SocketServerOperations } from "./socketServerOperations";
export type SocketServerConstructorArgs = [
  socketPath?: string,
  daemonState?: SocketDaemonStateAccess,
  timer?: Timer,
  featureFlagService?: FeatureFlagAdmin | null,
  handshakeConfig?: {
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
    /** Environment used for daemon request budgets; defaults to this process. */
    requestTimeoutEnv?: NodeJS.ProcessEnv;
    clearConnectionDevicePin?: (connectionId: string) => void;
    onFrameTrace?: (event: SocketFrameTraceEvent) => void;
    /**
     * Runs forwards in process (#11820). The daemon passes its own, so shutdown can close the
     * forwards still running; without one the server builds a default over the shared state.
     */
    mcpDispatcher?: Pick<InProcessMcpDispatcher, "connect"> &
      Partial<Pick<InProcessMcpDispatcher, "refreshResources">>;
  },
  idGenerator?: IdGenerator,
  bindGuard?: SocketBindGuardOptions,
  adbClientFactory?: AdbClientFactory,
];
export type SocketToolErrorFormatter = (
  error: unknown,
  context: { toolName: string; source: "MCP" | "ProxyServer" },
) => { [key: string]: unknown; content: [{ type: "text"; text: string }]; isError: true };
/** Mutable state shared through narrowly typed collaborator views. */
export class SocketServerRuntime {
  server: NetServer | null = null;
  serverClosePromise: Promise<void> | null = null;
  closing = false;
  acceptingRequests = false;
  readonly requestTimeoutEnv?: NodeJS.ProcessEnv;
  /** Largest inbound frame a control-socket peer may send; tests lower it. */
  get maxInboundFrameBytes(): number {
    return this.inboundFrameLimit();
  }
  lifecycleGeneration = 0;
  socketFileIdentity: SocketFileIdentity | null = null;
  readonly adbClientFactory: AdbClientFactory;
  sessions: Map<string, SessionContext> = new Map();
  /** Live client sockets by session ID, for server-pushed notification frames (issue #3223). */
  clientSockets: Map<string, Socket> = new Map();
  acceptedClientConnections = 0;
  /** Per-socket outbound byte bound and stall watchdog (issue #10176). */
  readonly controlConnections = new WeakMap<Socket, ControlConnection>();
  /** Request handlers that can continue after their client socket is destroyed. */
  activeRequestHandlers: Set<Promise<void>> = new Set();
  /** Parsed requests awaiting their one terminal response to flush, including queued requests. */
  pendingSocketRequests = new PendingRequestTracker();
  /** Socket sessions that opted in to server-pushed notifications. */
  notificationSubscribers: Set<string> = new Set();
  readonly resourceSubscriptions = new Map<string, Set<string>>();
  /**
   * The session that owned each resolved input target at resolution time, so a rebind between
   * resolution and execution cannot leave the input running as an unowned call (#9958).
   */
  readonly inputTargetOwners = new WeakMap<BootedDevice, string>();
  resourceUpdatedUnsubscribe: (() => void) | null = null;
  /** Session-release frames written but not yet flushed to their client sockets. */
  pendingSessionReleaseWrites: Set<Promise<void>> = new Set();
  listChangedUnsubscribe: (() => void) | null = null;
  sessionReleaseUnsubscribe: (() => void) | null = null;
  sessionDeviceReboundUnsubscribe: (() => void) | null = null;
  socketPath: string;
  daemonState: SocketDaemonStateAccess;
  readonly clearConnectionDevicePin: ((connectionId: string) => void) | undefined;
  /**
   * The loopback MCP client that a socket transport most recently bound with a
   * device session. Follow-up requests can omit their session UUID, so reuse
   * this client to preserve the selected tool-selection profile.
   */
  boundMcpClientKeysBySocketSession: Map<string, BoundMcpClient> = new Map();
  /** Promise tails that serialize MCP forwards only within the same execution target. */
  mcpForwardTails: Map<string, Promise<void>> = new Map();
  /** Direct device forwards that need cleanup after every successor tail has settled. */
  mcpForwardIdleCloseKeys: Map<string, Set<string>> = new Map();
  /** Execution keys whose chain drained, timed for the append-helper idle eviction. */
  forwardKeyIdleTimers: Map<string, NodeJS.Timeout> = new Map();
  timer: Timer;
  readonly onFrameTrace?: (event: SocketFrameTraceEvent) => void;
  readonly idGenerator: IdGenerator;
  /**
   * The daemon-generated key ({@link INTERNAL_LIVE_DEADLINE_KEY_PARAM}) last forwarded with each
   * tools/call request. It is the only identity both this layer and the tool handler share for one
   * call, so a cancelled provisionDevice publishes its outcome under it (#11065: no operationId).
   */
  readonly forwardedCallKeys = new WeakMap<DaemonRequest, string>();
  /** Observation-only liveness probe used before an existing socket's reclaim (issue #6232). */
  readonly socketReachability: DaemonSocketReachabilityLike;
  /** Observation-only owner check that fails every bind closed on an inconclusive probe (issue #6232). */
  readonly socketOwnerLiveness: SocketOwnerLiveness;
  /** Cross-process lock serializing the reclaim → bind sequence against a concurrent binder (issue #6232, W5). */
  readonly socketReclaimLock: SocketReclaimLock;
  featureFlagService: FeatureFlagAdmin | null;
  readonly handshakeEnforced: boolean;
  readonly daemonIdentity: DaemonSelfIdentity;
  readonly identityStartedAt: number;
  readonly processGenerationToken: string | undefined;
  readonly startupOptions: DaemonOptions;
  readonly onRepublishIdentity?: () => Promise<boolean>;
  readonly identityDbPath?: string;
  readonly identityPidFilePath?: string;
  readonly startupCompletion?: Promise<void>;
  startupCompleted = false;
  readonly identitySockets?: Record<string, string>;
  readonly identityProcessStartedAt?: number;
  identityRepublishInFlight?: Promise<{
    accepted: boolean;
    reason?: string;
  }>;
  readonly onRestartAccepted?: () => void;
  readonly liveAcceptanceStartupSecret: string | undefined;
  readonly acceptanceDiscoveryCapability: string | undefined;
  restartAdmission!: RestartAdmission;
  readonly sessionToolSelectionService?: Pick<
    SessionToolSelectionService,
    "isEnabled" | "setEnabled"
  >;
  /** Runs every forward in process: its own MCP client and stateless server (#11820). */
  readonly mcpDispatcher: Pick<InProcessMcpDispatcher, "connect"> &
    Partial<Pick<InProcessMcpDispatcher, "refreshResources">>;
  /** Forwarded MCP requests are cancelled when their owner socket disconnects. */
  readonly mcpRequestAbortControllers = new Map<string, Set<AbortController>>();
  /** Test seam: the per-args `deviceReadOnly` classification behind the read lane (#10969). */
  deviceReadToolCallClassifier: DeviceReadToolCallClassifier = registeredDeviceReadClassifier;
  mcpClientFactory: McpClientFactory = (
    sessionUuid,
    toolSelectionProfileUuid,
    releasedSessionUuid,
  ) => this.callbacks().createMcpClient(sessionUuid, toolSelectionProfileUuid, releasedSessionUuid);
  /** Connection recording teardown seam, like the injectable factories below. */
  releaseToolCallRecording: (connectionId: string) => void = dropToolCallRecording;
  /**
   * Drops the session-tool bindings keyed on a socket session id once its socket is gone (#4678):
   * the daemon-scoped store would otherwise keep one entry per connection forever.
   */
  forgetSessionToolBindings: (socketSessionId: string) => void = (socketSessionId) =>
    forgetDaemonSessionBindingScope(socketSessionId);
  /**
   * Factory for the Android append-text helper behind `input/typeText mode:"append"`.
   *
   * Defaults to the real {@link InputText} bound to the default adb client factory and
   * this server's timer; tests assign a fake so the append path is exercised without
   * shelling out to a real `adb` (and so a stalled subprocess can be simulated).
   */
  appendTextFactory: (device: BootedDevice) => AppendTextInput = (device) =>
    this.callbacks().createSocketAppendTextInput(device);
  /**
   * Per-device append helpers, cached so the API-level probe (`adb shell getprop`)
   * runs once per device instead of once PER KEYSTROKE — an interactive client
   * sends one `input/typeText` per key press, and a fresh {@link InputText} would
   * re-pay that round trip every time (issue #1099 tracks interactive latency).
   *
   * Evicted alongside the device's idle MCP-client close ({@link closeIdleMcpClient},
   * same per-device key, same idle window), so a device that re-appears under the
   * same id with a different image re-probes rather than trusting a stale API level.
   */
  appendTextInputs: Map<string, CachedAppendTextInput> = new Map();
  /**
   * Device ids whose iOS runner a scale probe CONFIRMED report no scale metadata (a genuine
   * pre-#4548 runner). Cached so subsequent legacy taps skip the hierarchy-sync round trip (#4549).
   * A probe FAILURE is never cached (it must re-probe); the entry is dropped the moment metadata
   * appears, so a runner upgrade is not pinned to the stale legacy verdict.
   */
  confirmedLegacyScaleDevices: Set<string> = new Set();
  /**
   * Streamed gestures currently open on a device, keyed by the SOCKET session that started them,
   * then by `${deviceId}::${gestureId}`. A `gestureStart` the runner accepts records its owning
   * socket here and the matching `gestureEnd` clears it. The runner deliberately parks a continued
   * stroke while it waits, with no duration ceiling, so a socket that closes/errors before sending
   * its end (desktop crash, timeout, disconnect) would leave the on-device touch and the runner's
   * registry entry live indefinitely; {@link GestureOwnershipRegistry} issues a cancelling end for
   * each on socket teardown, and for a start acked after its socket already closed (#10005).
   */
  readonly ownedGestures = new GestureOwnershipRegistry({
    isSocketLive: (socketSessionId) => this.clientSockets.has(socketSessionId),
    cancelGesture: (targetDevice, gestureId) =>
      this.callbacks().cancelGestureOnDevice(targetDevice, gestureId),
  });
  constructor(
    args: SocketServerConstructorArgs,
    private readonly callbacks: () => SocketServerOperations,
    readonly shapeToolCallError: SocketToolErrorFormatter,
    private readonly inboundFrameLimit: () => number,
  ) {
    const [
      socketPath = SOCKET_PATH,
      daemonState = defaultDaemonContext.daemonState(),
      timer = defaultTimer,
      featureFlagService = null,
      handshakeConfig = {},
      idGenerator = defaultIdGenerator,
      bindGuard = {},
      adbClientFactory = defaultAdbClientFactory,
    ] = args;

    this.socketPath = socketPath;
    this.daemonState = daemonState;
    this.clearConnectionDevicePin = handshakeConfig.clearConnectionDevicePin;
    this.timer = timer;
    this.requestTimeoutEnv = handshakeConfig.requestTimeoutEnv;
    this.onFrameTrace = handshakeConfig.onFrameTrace;
    this.mcpDispatcher =
      handshakeConfig.mcpDispatcher ??
      createDaemonMcpDispatcher({
        base: () => ({
          acceptanceDiscoveryCapability: handshakeConfig.acceptanceDiscoveryCapability,
        }),
      });
    this.idGenerator = idGenerator;
    // The reclaim lock's per-instance owner token comes from the module default
    // generator, NOT the injected `idGenerator` — that one is reserved for socket
    // SESSION ids, and consuming it here would shift every session id a test
    // pins to the injected sequence.
    const resolvedBindGuard = resolveSocketBindGuard(
      bindGuard,
      socketPath,
      defaultIdGenerator.next(),
    );
    this.socketReachability = resolvedBindGuard.reachability;
    this.socketOwnerLiveness = resolvedBindGuard.ownerLiveness;
    this.socketReclaimLock = resolvedBindGuard.bindLock;
    this.adbClientFactory = adbClientFactory;
    this.featureFlagService = featureFlagService;
    this.handshakeEnforced = handshakeConfig.enforce ?? DAEMON_HANDSHAKE_ENABLED;
    this.sessionToolSelectionService = handshakeConfig.sessionToolSelectionService;
    this.daemonIdentity = handshakeConfig.identity ?? liveDaemonIdentity();
    this.identityStartedAt = resolveIdentityStartedAt(
      handshakeConfig.identityStartedAt,
      this.timer,
    );
    this.processGenerationToken = handshakeConfig.processGenerationToken;
    this.startupOptions = snapshotDaemonOptions(handshakeConfig.startupOptions);
    this.onRepublishIdentity = handshakeConfig.onRepublishIdentity;
    this.identityDbPath = handshakeConfig.dbPath;
    this.identityPidFilePath = handshakeConfig.pidFilePath;
    this.startupCompletion = handshakeConfig.startupCompletion;
    this.observeStartupCompletion();
    this.identitySockets = handshakeConfig.sockets;
    this.identityProcessStartedAt = handshakeConfig.processStartedAt;
    this.onRestartAccepted = handshakeConfig.onRestartAccepted;
    this.liveAcceptanceStartupSecret = handshakeConfig.liveAcceptanceStartupSecret;
    this.acceptanceDiscoveryCapability = handshakeConfig.acceptanceDiscoveryCapability;
    this.restartAdmission = new RestartAdmission({
      timer: this.timer,
      idGenerator: this.idGenerator,
      generationMatches: (params) => this.callbacks().daemonGenerationMatches(params),
      currentIdentity: () => this.callbacks().currentGenerationIdentity(),
      getAllSessions: () => this.daemonState.getSessionManager().getAllSessions?.(),
      onRestartAccepted: this.onRestartAccepted,
      liveAcceptanceStartupSecret: this.liveAcceptanceStartupSecret,
    });
    // Forwards run in process (#11820) through the MCP dispatcher; no HTTP loopback is involved.
    logger.info(`UnixSocketServer initialized with in-process MCP dispatcher: "${socketPath}"`);
  }
  private observeStartupCompletion(): void {
    void this.startupCompletion?.then(
      () => {
        this.startupCompleted = true;
      },
      (error: unknown) => {
        logger.debug(`Daemon startup completion rejected: ${errorMessage(error)}`);
      },
    );
  }
}
