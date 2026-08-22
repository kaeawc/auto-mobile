import { createServer, Server as NetServer, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { ensureSecureDir, secureFile } from "../utils/filesystem/securePermissions";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPReconnectionOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../utils/logger";
import { resolveMcpRequestTimeoutMs } from "./mcpRequestTimeout";
import { McpTimeoutError } from "./McpTimeoutError";
import { DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { errorMessage } from "../utils/describeUnknownError";
import { DaemonNotification, DaemonRequest, DaemonResponse, SessionContext } from "./types";
import {
  SOCKET_PATH,
  DAEMON_HANDSHAKE_ENABLED,
  DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
  DAEMON_SESSION_TOOL_BINDING_HEADER,
  DAEMON_TOOL_SELECTION_PROFILE_HEADER,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_VERSION,
} from "./constants";
import {
  ListChangedBroadcaster,
  LIST_CHANGED_NOTIFICATION_METHODS,
  type ListChangedKind,
} from "../server/listChangedBroadcast";
import {
  SessionReleaseBroadcaster,
  SESSION_RELEASED_NOTIFICATION_METHOD,
} from "../server/sessionReleaseBroadcast";
import {
  toolSelectionProfileUuidFromResponse,
  SET_TOOL_ENABLED_TOOL_NAME,
} from "../features/toolSelection/toolSelectionControl";
import {
  evaluateClientHandshake,
  extractClientHandshake,
  type DaemonSelfIdentity,
} from "./daemonHandshake";
import { InputText, type AppendKeyEventValidator } from "../features/action/InputText";
import { getCurrentBuildIdentity } from "./buildIdentity";
import { DaemonState } from "./daemonState";
import { DaemonStateAccess, handleDaemonRequest } from "./daemonRequestHandlers";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import type { FeatureFlagService } from "../features/featureFlags/FeatureFlagService";
import type { FeatureFlagKey } from "../features/featureFlags/FeatureFlagDefinitions";
import {
  getSessionToolSelectionService,
  type SessionToolSelectionService,
} from "../features/toolSelection/SessionToolSelectionService";
import { assertToolEnabledForAnySession } from "../features/toolSelection/toolSelectionPolicy";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { ToolRegistry } from "../server/toolRegistry";
import { getMcpServerVersion } from "../utils/mcpVersion";
import {
  IOS_CTRL_PROXY_APP_HASH,
  resolveApkChecksum,
  resolveApkUrl,
  resolveAssetVersion,
  resolveIpaChecksum,
  resolveIpaUrl,
  resolvePinnedVersion,
} from "../constants/release";
import { AndroidCtrlProxyManager } from "../utils/CtrlProxyManager";
import { IOSCtrlProxyManager } from "../utils/IOSCtrlProxyManager";
import { PlatformDeviceManagerFactory } from "../utils/factories/PlatformDeviceManagerFactory";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { PressButton } from "../features/action/PressButton";
import {
  INPUT_KEY_IOS_UNSUPPORTED_ERROR,
  InputKey,
  SUPPORTED_INPUT_KEYS,
  isInputKeyName,
  type InputKeyName,
} from "../features/action/InputKey";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { canonicalPixelsToPoints } from "./canonicalPixels";
import { ActionableError, toActionableError } from "../models/ActionableError";
import { getDeviceDataStreamServer } from "./deviceDataStreamSocketServer";
import type { KeyValueType } from "../features/storage/storageTypes";
import type { BootedDevice, ImeAction, ScreenScaleMetadata } from "../models";
import type { DeviceService } from "../features/observe/DeviceService";
import {
  DEVICE_CONTROL_TRANSPORT_FAILURE_CODE,
  DeviceControlTransportError,
  deviceControlToolName,
  isDeviceControlTransportRequest,
  isReplaySafeAfterResponseClosure,
  isUnexpectedSocketClosure,
  type DeviceControlTransportFailure,
  type DeviceControlTransportPhase,
} from "./deviceControlTransportFailure";
const MCP_CLIENT_IDLE_CLOSE_MS = 5 * 60 * 1000;
/** Keep shutdown bounded if a request handler ignores its disconnected peer. */
const DAEMON_REQUEST_HANDLER_DRAIN_TIMEOUT_MS = 1_000;

/**
 * Unix Socket Server that proxies requests to the HTTP MCP server
 *
 * Responsibilities:
 * - Listen on Unix socket for CLI client connections
 * - Parse incoming DaemonRequest messages
 * - Forward tool calls to local HTTP MCP server
 * - Return DaemonResponse to clients
 * - Manage concurrent client sessions
 *
 * JUnit uses one Unix socket per thread (`DaemonSocketClientManager` ThreadLocal) for parallel
 * tests. Each MCP HTTP client owns one Streamable HTTP session, so concurrent calls on the same
 * client are unsafe. MCP forwards are serialized by target key below, and each key gets its own
 * MCP client so independent devices/sessions can run concurrently.
 *
 * The SDK's Streamable HTTP client may auto-reopen a standalone GET (SSE) after a disconnect.
 * The server transport allows only one such stream per session; a second GET while the first
 * is still mapped returns 409 and tears down the session. We disable that auto-reconnect here;
 * stale sessions are recovered via `getMcpClient()` + "Session not found" retry.
 */
/** Matches SDK defaults except `maxRetries`, which must stay 0 to avoid duplicate GET SSE. */
const DAEMON_LOOPBACK_STREAMABLE_HTTP_RECONNECTION: StreamableHTTPReconnectionOptions = {
  initialReconnectionDelay: 1000,
  maxReconnectionDelay: 30_000,
  reconnectionDelayGrowFactor: 1.5,
  maxRetries: 0,
};

interface SocketFileIdentity {
  dev: number;
  ino: number;
}

/**
 * Creates the MCP HTTP client the daemon forwards `tools/call` requests through.
 * Injected so tests can substitute a fake without monkeypatching a private method
 * by name (a name-based patch silently no-ops if the internal creator is renamed,
 * leaving forwarding dead but the suite green).
 */
export type McpClientFactory = (
  boundSessionUuid?: string,
  toolSelectionProfileUuid?: string,
) => Promise<Client>;

/**
 * The narrow append-text surface `input/typeText mode:"append"` needs.
 *
 * Exactly one method, deliberately: the daemon never wants the observe round trip
 * or the replace-shaped modes {@link InputText} also exposes, and a narrow seam is
 * what lets a test inject a fake adb instead of shelling out.
 */
export interface AppendTextInput {
  appendText(
    text: string,
    timeoutMs?: number,
    beforeKeyEvent?: AppendKeyEventValidator,
  ): Promise<{ success: boolean; error?: string; charsSent?: number }>;
}

interface CachedAppendTextInput {
  input: AppendTextInput;
  transportId?: string;
}

interface BoundMcpClient {
  clientKey: string;
  executionKey: string;
  sessionUuid?: string;
  toolSelectionProfileUuid?: string;
  requiresLiveDaemonSession: boolean;
}

interface McpForwardRoute {
  /** Serializes work that targets the same physical device or session. */
  executionKey: string;
  /** Owns the loopback MCP transport and its session-local tool-selection profile. */
  clientKey: string;
  /** Replayed when this transport needs to establish a fresh MCP session. */
  sessionUuid?: string;
  toolSelectionProfileUuid?: string;
}

interface DeviceControlTransportIdentity {
  sessionUuid?: string;
  deviceId?: string;
  deviceSessionUuid?: string;
}

interface McpForwardRecoveryContext {
  request: DaemonRequest;
  route: McpForwardRoute;
  socketSessionId: string;
  remainingTimeoutMs: number;
  forwardStartMs: number;
}

const isNonBlankSessionUuid = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Wire method name for each streamed-gesture frame kind (issue: streaming gesture input). */
const GESTURE_FRAME_METHODS = {
  start: "input/gestureStart",
  move: "input/gestureMove",
  end: "input/gestureEnd",
} as const;

/**
 * A streamed gesture the runner has accepted (a `gestureStart` that acked) but not yet ended,
 * retained so its owning socket can issue a cancelling `gestureEnd` if it tears down mid-drag.
 * [targetDevice] is captured at start so the cancel can be forwarded without re-resolving the
 * device on a socket whose session state is already gone.
 */
interface OwnedGesture {
  targetDevice: BootedDevice;
  gestureId: string;
}

/** Timeout for the best-effort cancelling `gestureEnd` issued when a socket owning a gesture closes. */
const OWNED_GESTURE_CANCEL_TIMEOUT_MS = 5000;

/**
 * The narrow key-value mutation surface the `ide/*` handlers need from a
 * platform CtrlProxy client. Both AndroidCtrlProxyClient and IOSCtrlProxyClient
 * satisfy it structurally (#4708).
 */
interface KeyValueMutationClient {
  setPreference(
    packageName: string,
    fileName: string,
    key: string,
    value: string,
    type: KeyValueType,
  ): Promise<void>;
  removePreference(packageName: string, fileName: string, key: string): Promise<void>;
  clearPreferenceStore(packageName: string, fileName: string): Promise<void>;
}

/**
 * Preserve the normal failed socket envelope while carrying append progress for
 * a client that can safely retry only the unsent suffix.
 */
class InputTypeTextAppendError extends Error {
  constructor(
    message: string,
    readonly charsSent: number,
  ) {
    super(message);
    this.name = "InputTypeTextAppendError";
  }
}

export class UnixSocketServer {
  private server: NetServer | null = null;
  private closing = false;
  private lifecycleGeneration = 0;
  private socketFileIdentity: SocketFileIdentity | null = null;
  private sessions: Map<string, SessionContext> = new Map();
  /** Live client sockets by session ID, for server-pushed notification frames (issue #3223). */
  private clientSockets: Map<string, Socket> = new Map();
  /** Request handlers that can continue after their client socket is destroyed. */
  private activeRequestHandlers: Set<Promise<void>> = new Set();
  /** Socket sessions that opted in to server-pushed notifications. */
  private notificationSubscribers: Set<string> = new Set();
  private listChangedUnsubscribe: (() => void) | null = null;
  private sessionReleaseUnsubscribe: (() => void) | null = null;
  private socketPath: string;
  private mcpEndpoint: string;
  private daemonState: DaemonStateAccess;
  private mcpClients: Map<string, Client> = new Map();
  private mcpClientPromises: Map<string, Promise<Client>> = new Map();
  /**
   * The loopback MCP client that a socket transport most recently bound with a
   * device session. Follow-up requests can omit their session UUID, so reuse
   * this client to preserve the selected tool-selection profile.
   */
  private boundMcpClientKeysBySocketSession: Map<string, BoundMcpClient> = new Map();
  /** Promise tails that serialize MCP HTTP forwards only within the same execution target. */
  private mcpForwardTails: Map<string, Promise<void>> = new Map();
  /** Direct device forwards that need cleanup after every successor tail has settled. */
  private mcpForwardIdleCloseKeys: Map<string, Set<string>> = new Map();
  /** Active forwards by loopback MCP client, which can differ from the execution target. */
  private activeMcpClientForwardCounts: Map<string, number> = new Map();
  private mcpClientIdleTimers: Map<string, NodeJS.Timeout> = new Map();
  private timer: Timer;
  private featureFlagService: FeatureFlagService | null;
  private readonly handshakeEnforced: boolean;
  private readonly daemonIdentity: DaemonSelfIdentity;
  private readonly sessionToolSelectionService?: Pick<
    SessionToolSelectionService,
    "isEnabled" | "setEnabled"
  >;
  /**
   * Factory that `getMcpClient()` calls to open the loopback MCP HTTP client.
   * Defaults to the real {@link createMcpClient}; tests assign a fake here to
   * exercise forwarding without a live HTTP endpoint.
   */
  mcpClientFactory: McpClientFactory = (sessionUuid, toolSelectionProfileUuid) =>
    this.createMcpClient(sessionUuid, toolSelectionProfileUuid);

  /**
   * Factory for the Android append-text helper behind `input/typeText mode:"append"`.
   *
   * Defaults to the real {@link InputText} bound to the default adb client factory and
   * this server's timer; tests assign a fake so the append path is exercised without
   * shelling out to a real `adb` (and so a stalled subprocess can be simulated).
   */
  appendTextFactory: (device: BootedDevice) => AppendTextInput = (device) =>
    new InputText(device, defaultAdbClientFactory, undefined, this.timer);

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
  private appendTextInputs: Map<string, CachedAppendTextInput> = new Map();

  /**
   * Device ids whose iOS runner a scale probe CONFIRMED report no scale metadata (a genuine
   * pre-#4548 runner). Cached so subsequent legacy taps skip the hierarchy-sync round trip (#4549).
   * A probe FAILURE is never cached (it must re-probe); the entry is dropped the moment metadata
   * appears, so a runner upgrade is not pinned to the stale legacy verdict.
   */
  private confirmedLegacyScaleDevices: Set<string> = new Set();

  /**
   * Streamed gestures currently open on a device, keyed by the SOCKET session that started them,
   * then by `${deviceId}::${gestureId}`. A `gestureStart` the runner accepts records its owning
   * socket here and the matching `gestureEnd` clears it. The runner deliberately parks a continued
   * stroke while it waits, with no duration ceiling, so a socket that closes/errors before sending
   * its end (desktop crash, timeout, disconnect) would leave the on-device touch and the runner's
   * registry entry live indefinitely; {@link cancelOwnedGestures} issues a cancelling end for each
   * on socket teardown (issue: streaming gesture input).
   */
  private ownedGesturesBySocket: Map<string, Map<string, OwnedGesture>> = new Map();

  constructor(
    socketPath: string = SOCKET_PATH,
    mcpEndpoint: string,
    daemonState: DaemonStateAccess = DaemonState.getInstance(),
    timer: Timer = defaultTimer,
    featureFlagService: FeatureFlagService | null = null,
    handshakeConfig: {
      identity?: DaemonSelfIdentity;
      enforce?: boolean;
      sessionToolSelectionService?: Pick<SessionToolSelectionService, "isEnabled" | "setEnabled">;
    } = {},
  ) {
    this.socketPath = socketPath;
    this.mcpEndpoint = mcpEndpoint;
    this.daemonState = daemonState;
    this.timer = timer;
    this.featureFlagService = featureFlagService;
    this.handshakeEnforced = handshakeConfig.enforce ?? DAEMON_HANDSHAKE_ENABLED;
    this.sessionToolSelectionService = handshakeConfig.sessionToolSelectionService;
    this.daemonIdentity = handshakeConfig.identity ?? {
      version: DAEMON_VERSION,
      build: getCurrentBuildIdentity(),
    };
    logger.info(`UnixSocketServer initialized with endpoint: "${mcpEndpoint}"`);
    if (!mcpEndpoint) {
      logger.error("ERROR: mcpEndpoint is empty or undefined!");
    }
  }

  /**
   * Start the Unix socket server
   */
  async start(): Promise<void> {
    this.closing = false;
    this.lifecycleGeneration += 1;
    // Owner-only (0o700) socket directory so the control socket is not
    // world-traversable. On macOS socket-file permission bits are not reliably
    // enforced on connect(), so the containing directory's mode is the primary
    // access control (issue #4750).
    await ensureSecureDir(path.dirname(this.socketPath));

    // Remove existing socket file if it exists
    if (existsSync(this.socketPath)) {
      await unlink(this.socketPath);
    }

    this.server = createServer((socket) => {
      this.handleConnection(socket);
    });

    // Fan list-changed events out to subscribed socket clients (issue #3223).
    // Subscribed here (not in the daemon) so a socket-server recreation during
    // recovery re-wires itself; close() unsubscribes symmetrically.
    this.listChangedUnsubscribe?.();
    this.listChangedUnsubscribe = ListChangedBroadcaster.subscribe((kind) => {
      this.broadcastListChanged(kind);
    });

    // Fan session-release events out to subscribed proxy clients (issue #4610),
    // so a proxy clears its remembered binding on a real release instead of the
    // replay-TTL guess. Subscribed here (not in the daemon) for the same
    // recovery-rewire reason as list-changed; close() unsubscribes symmetrically.
    this.sessionReleaseUnsubscribe?.();
    this.sessionReleaseUnsubscribe = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      this.clearBoundMcpClientsForReleasedSession(sessionId);
      this.broadcastSessionReleased(sessionId, reason);
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.socketPath, () => {
        this.socketFileIdentity = this.readSocketFileIdentity();
        logger.info(`Unix socket server listening on ${this.socketPath}`);
        // Restrict the bound socket to the owner (0o600) before start() resolves,
        // so no client can connect while it is still world-accessible. listen()
        // creates the socket at the umask default (issue #4750).
        secureFile(this.socketPath).then(resolve).catch(reject);
      });

      this.server!.on("error", (error) => {
        logger.error(`Unix socket server error: ${error}`);
        reject(error);
      });
    });
  }

  /**
   * Handle a new client connection
   */
  private handleConnection(socket: Socket): void {
    const sessionId = randomUUID();
    const session: SessionContext = {
      sessionId,
      createdAt: this.timer.now(),
      requestQueue: [],
      processing: false,
    };

    this.sessions.set(sessionId, session);
    this.clientSockets.set(sessionId, socket);
    logger.info(`New client connection: ${sessionId}`);

    let buffer = "";

    socket.setTimeout(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
    socket.on("timeout", () => {
      logger.warn(
        `Daemon RPC socket ${sessionId} idle timeout after ${DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS}ms, destroying`,
      );
      socket.destroy();
    });

    socket.on("data", (data) => {
      const handler = (async () => {
        buffer += data.toString();

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          let requestId = "unknown";
          try {
            const request: DaemonRequest = JSON.parse(line);
            requestId = request.id;
            const response = await this.handleRequest(sessionId, request);
            this.writeFrame(socket, sessionId, response);
          } catch (error) {
            logger.error(`Error processing request ${requestId} from ${sessionId}:`, error);
            const errorResponse: DaemonResponse = {
              id: requestId,
              type: "mcp_response",
              success: false,
              error: errorMessage(error),
            };
            this.writeFrame(socket, sessionId, errorResponse);
          }
        }
      })();
      this.trackRequestHandler(handler);
    });

    socket.on("close", () => {
      logger.info(`Client disconnected: ${sessionId}`);
      this.sessions.delete(sessionId);
      this.clientSockets.delete(sessionId);
      this.notificationSubscribers.delete(sessionId);
      this.clearBoundMcpClientKey(sessionId);
      // Lift any streamed gesture this socket left open on the device (issue: streaming gesture
      // input). Tracked so daemon shutdown drains it rather than a fire-and-forget floating promise.
      this.trackRequestHandler(this.cancelOwnedGestures(sessionId));
    });

    socket.on("error", (error) => {
      logger.error(`Socket error for ${sessionId}:`, error);
      this.sessions.delete(sessionId);
      this.clientSockets.delete(sessionId);
      this.notificationSubscribers.delete(sessionId);
      this.clearBoundMcpClientKey(sessionId);
      this.trackRequestHandler(this.cancelOwnedGestures(sessionId));
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  }

  private trackRequestHandler(handler: Promise<void>): void {
    this.activeRequestHandlers.add(handler);
    void handler.then(
      () => this.activeRequestHandlers.delete(handler),
      () => this.activeRequestHandlers.delete(handler),
    );
  }

  /**
   * Push a list-changed notification frame to every subscribed client socket
   * (issue #3223). Best-effort per socket: a dead/mid-teardown socket is
   * skipped or destroyed by the write helper, never thrown.
   */
  private broadcastListChanged(kind: ListChangedKind): void {
    const notification: DaemonNotification = {
      type: "daemon_notification",
      method: LIST_CHANGED_NOTIFICATION_METHODS[kind],
    };
    for (const sessionId of this.notificationSubscribers) {
      const socket = this.clientSockets.get(sessionId);
      if (!socket) {
        continue;
      }
      this.writeFrame(socket, sessionId, notification);
    }
  }

  /**
   * Push a session-released notification frame to every subscribed client socket
   * (issue #4610). `releasedSessionId` is the daemon session key that was just
   * released (base or derived `${base}:${label}`); the proxy matches it against
   * its bound UUID by exact equality. Best-effort per socket, like
   * {@link broadcastListChanged}. Note `sessionId` here is the socket-client id,
   * distinct from the released daemon session carried in the frame.
   */
  private broadcastSessionReleased(releasedSessionId: string, reason?: string): void {
    const notification: DaemonNotification = {
      type: "daemon_notification",
      method: SESSION_RELEASED_NOTIFICATION_METHOD,
      sessionId: releasedSessionId,
      ...(reason !== undefined ? { reason } : {}),
    };
    for (const sessionId of this.notificationSubscribers) {
      const socket = this.clientSockets.get(sessionId);
      if (!socket) {
        continue;
      }
      this.writeFrame(socket, sessionId, notification);
    }
  }

  private writeFrame(
    socket: Socket,
    sessionId: string,
    frame: DaemonResponse | DaemonNotification,
  ): void {
    if (socket.destroyed) {
      return;
    }
    try {
      const ok = socket.write(JSON.stringify(frame) + "\n");
      if (!ok) {
        logger.debug(
          `Daemon RPC socket ${sessionId} backpressured; awaiting drain (idle timeout still armed)`,
        );
      }
    } catch (error) {
      logger.warn(`Daemon RPC write failed for ${sessionId}: ${error}`);
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  }

  /**
   * Handle a request from a client
   */
  private async handleRequest(sessionId: string, request: DaemonRequest): Promise<DaemonResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        id: request.id,
        type: "mcp_response",
        success: false,
        error: "Session not found",
      };
    }

    const handshakeError = this.rejectOnHandshakeMismatch(request);
    if (handshakeError) {
      return handshakeError;
    }

    // Notification opt-in is per-socket-session state owned here, not by the
    // daemon request handlers — answer immediately without queueing (issue #3223).
    if (request.method === DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD) {
      this.notificationSubscribers.add(sessionId);
      return {
        id: request.id,
        type: "mcp_response",
        success: true,
        result: { subscribed: true },
      };
    }

    // Enqueue request to maintain order
    return this.enqueueRequest(session, async () => {
      try {
        if (request.method.startsWith("daemon/")) {
          const daemonResponse = await handleDaemonRequest(request, this.daemonState);
          return {
            id: request.id,
            type: "mcp_response",
            ...daemonResponse,
          };
        }

        // Handle socket-local requests that don't need the MCP client
        const localResult = await this.handleLocalSocketRequest(request, sessionId);
        if (localResult !== undefined) {
          return {
            id: request.id,
            type: "mcp_response",
            success: true,
            result: localResult,
          };
        }

        const queueEnterMs = this.timer.now();
        const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
        const initialRoute = this.getMcpForwardRoute(request, sessionId);

        const result = await this.runMcpForwardForCurrentRoute(
          initialRoute,
          request,
          sessionId,
          async (route) => {
            const queueWaitMs = this.timer.now() - queueEnterMs;
            const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
            const forwardLabel = UnixSocketServer.describeMcpForwardRequest(request);
            logger.debug(
              `[McpForward] start executionKey=${route.executionKey} clientKey=${route.clientKey} socketSession=${sessionId} requestId=${request.id} ${forwardLabel} queueWaitMs=${queueWaitMs} remainingTimeoutMs=${remainingTimeoutMs}`,
            );

            if (remainingTimeoutMs <= 0) {
              const toolName =
                request.method === "tools/call"
                  ? (request.params?.name ?? request.method)
                  : request.method;
              throw new McpTimeoutError({
                toolName,
                timeoutMs: totalTimeoutMs,
                origin: "UnixSocketServer.handleRequest",
                detail: `spent ${queueWaitMs}ms waiting in queue`,
              });
            }

            const forwardStartMs = this.timer.now();
            try {
              const sessionWasActiveBeforeForward = this.wasRequestSessionActive(request);
              const response = await this.forwardMcpRequestWithRecovery({
                request,
                route,
                socketSessionId: sessionId,
                remainingTimeoutMs,
                forwardStartMs,
              });
              this.recordBoundMcpClientKey(
                request,
                sessionId,
                route,
                sessionWasActiveBeforeForward,
                response,
              );
              return response;
            } finally {
              logger.debug(
                `[McpForward] end executionKey=${route.executionKey} clientKey=${route.clientKey} socketSession=${sessionId} requestId=${request.id} ${forwardLabel} forwardMs=${this.timer.now() - forwardStartMs}`,
              );
              // The idle close is scheduled by runWithActiveMcpClient's wrapper once
              // this client's active-forward count reaches zero, so it is re-armed
              // even when a forward throws before reaching this finally (issue #4610).
            }
          },
        );

        return {
          id: request.id,
          type: "mcp_response",
          success: true,
          result,
        };
      } catch (error) {
        const errorMsg = errorMessage(error);
        const errorStack = error instanceof Error ? error.stack : "no stack";
        logger.error(`Error forwarding request to MCP server: ${errorMsg}`);
        logger.error(`Error stack: ${errorStack}`);
        logger.error(`Full error: ${JSON.stringify(error)}`);
        return {
          id: request.id,
          type: "mcp_response",
          success: false,
          error: errorMsg,
          ...(error instanceof DeviceControlTransportError
            ? { transportFailure: error.failure }
            : {}),
          ...(error instanceof InputTypeTextAppendError ? { charsSent: error.charsSent } : {}),
        };
      }
    });
  }

  /**
   * Reject an inbound request whose declared version/build identity does not match
   * this daemon (#2744). Returns an error response to short-circuit the request, or
   * null to let it through. Clients that declare no handshake fields (legacy, or the
   * gate disabled) always pass. This is the single, language-agnostic gate that
   * extends the TS proxy's build-identity enforcement to the Kotlin/Swift clients.
   */
  private rejectOnHandshakeMismatch(request: DaemonRequest): DaemonResponse | null {
    if (!this.handshakeEnforced) {
      return null;
    }
    const evaluation = evaluateClientHandshake(
      this.daemonIdentity,
      extractClientHandshake(request),
    );
    if (evaluation.ok) {
      return null;
    }
    logger.warn(
      `Rejecting daemon client on handshake ${evaluation.reason} mismatch: ${evaluation.message}`,
    );
    return {
      id: request.id,
      type: "mcp_response",
      success: false,
      error: evaluation.message,
    };
  }

  /**
   * Run one MCP forward at a time for a single execution target. Calls for different devices or
   * sessions can proceed concurrently while their loopback transports remain session-local.
   */
  private runKeyedMcpForward<T>(
    executionKey: string,
    fn: () => Promise<T>,
    idleCloseKey?: string,
  ): Promise<T> {
    if (idleCloseKey) {
      const idleCloseKeys = this.mcpForwardIdleCloseKeys.get(executionKey) ?? new Set<string>();
      idleCloseKeys.add(idleCloseKey);
      this.mcpForwardIdleCloseKeys.set(executionKey, idleCloseKeys);
    }
    const previous = this.mcpForwardTails.get(executionKey) ?? Promise.resolve();
    const run = previous.then(() => {
      if (idleCloseKey) {
        this.clearMcpClientIdleTimer(idleCloseKey);
      }
      return fn();
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.mcpForwardTails.set(executionKey, tail);
    void tail.finally(() => {
      if (this.mcpForwardTails.get(executionKey) === tail) {
        this.mcpForwardTails.delete(executionKey);
        const idleCloseKeys = this.mcpForwardIdleCloseKeys.get(executionKey);
        this.mcpForwardIdleCloseKeys.delete(executionKey);
        for (const key of idleCloseKeys ?? []) {
          this.scheduleMcpClientIdleClose(key);
        }
      }
    });
    return run;
  }

  private async runWithActiveMcpClient<T>(clientKey: string, fn: () => Promise<T>): Promise<T> {
    this.clearMcpClientIdleTimer(clientKey);
    this.activeMcpClientForwardCounts.set(
      clientKey,
      (this.activeMcpClientForwardCounts.get(clientKey) ?? 0) + 1,
    );
    try {
      return await fn();
    } finally {
      const remainingForClient = (this.activeMcpClientForwardCounts.get(clientKey) ?? 1) - 1;
      if (remainingForClient === 0) {
        this.activeMcpClientForwardCounts.delete(clientKey);
        // Re-arm the idle close around the whole active-client wrapper. A forward
        // can throw before its own cleanup runs (e.g. the pre-forward queue
        // timeout deadline throws before the forward-body finally), and this
        // wrapper cleared the client's idle timer on entry. Without this re-arm
        // the inactive transport would stay cached until another request or
        // daemon shutdown (issue #4610).
        this.scheduleMcpClientIdleClose(clientKey);
      } else {
        this.activeMcpClientForwardCounts.set(clientKey, remainingForClient);
      }
    }
  }

  private runMcpForwardForCurrentRoute<T>(
    initialRoute: McpForwardRoute,
    request: DaemonRequest,
    socketSessionId: string,
    fn: (route: McpForwardRoute) => Promise<T>,
  ): Promise<T> {
    return this.runKeyedMcpForward(initialRoute.executionKey, async () => {
      const currentRoute = this.getMcpForwardRoute(request, socketSessionId);
      if (currentRoute.executionKey !== initialRoute.executionKey) {
        logger.debug(
          `[McpForward] rekey requestId=${request.id} initialExecutionKey=${initialRoute.executionKey} currentExecutionKey=${currentRoute.executionKey}`,
        );
        return await this.runMcpForwardForCurrentRoute(currentRoute, request, socketSessionId, fn);
      }
      // The execution target is unchanged, so this request keeps the client and
      // session it was admitted with. Re-resolving may replace a session-specific
      // clientKey with the shared unbound client (e.g. a mid-flight disconnect
      // cleared the binding before this recompute) under the same executionKey;
      // that would run the admitted tool with no tool-selection profile. Only the
      // execution target may be re-resolved, never the admitted client/session
      // (issue #4610).
      //
      // Exception: when the admitted route was seeded for a specific daemon
      // session and that session was RELEASED while this request waited in the
      // queue, invoking the stale session-scoped client would re-seed the released
      // UUID and RESURRECT the session (getOrCreateSession recreates it and
      // reacquires a device the caller never asked for). A mid-flight socket
      // disconnect, by contrast, leaves the daemon session live — so the daemon
      // session still being active is exactly what distinguishes a disconnect
      // (keep the admitted client, preserving the tool-selection profile above) from a
      // real release (re-resolve to the current, unseeded route). Only re-resolve
      // when the recompute actually points somewhere else (issue #4610).
      if (
        initialRoute.sessionUuid !== undefined &&
        currentRoute.clientKey !== initialRoute.clientKey &&
        !this.hasActiveDaemonSession(initialRoute.sessionUuid)
      ) {
        logger.debug(
          `[McpForward] released-session re-resolve requestId=${request.id} releasedSession=${initialRoute.sessionUuid} clientKey=${initialRoute.clientKey} -> ${currentRoute.clientKey}`,
        );
        return await this.runWithActiveMcpClient(currentRoute.clientKey, () => fn(currentRoute));
      }
      return await this.runWithActiveMcpClient(initialRoute.clientKey, () => fn(initialRoute));
    });
  }

  private getMcpForwardRoute(request: DaemonRequest, socketSessionId: string): McpForwardRoute {
    if (request.method === "tools/call") {
      return this.getToolsCallForwardRoute(request.params?.arguments, socketSessionId);
    }

    const boundRoute = this.getBoundMcpClientRoute(socketSessionId);
    if (
      request.method === "tools/list" ||
      request.method === "resources/list" ||
      request.method === "resources/list-templates"
    ) {
      return this.getDiscoveryForwardRoute(request, socketSessionId, boundRoute);
    }

    if (request.method === "ide/getNavigationGraph") {
      return this.getNavigationGraphForwardRoute(request, socketSessionId, boundRoute);
    }

    if (request.method === "resources/read") {
      return this.getResourceReadForwardRoute(request, socketSessionId);
    }

    return this.sharedMcpForwardRoute(`method:${request.method}`);
  }

  private getDiscoveryForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
    boundRoute: McpForwardRoute | undefined,
  ): McpForwardRoute {
    if (request.method === "tools/list") {
      // A reconnected restricted discovery re-sends `{sessionUuid}` (see
      // daemonMcpProxy.listTools). A fresh socket has no boundRoute, so without
      // honoring the request's session the shared UNSEEDED client would return the
      // full, unfiltered tool list. Route to the session-scoped client so the
      // seeded loopback transport advertises the session-scoped list, completing
      // the proxy-side reconnect seeding (issue #4610).
      const listSessionUuid = this.getSessionUuid(request.params);
      const toolSelectionProfileUuid = this.getToolSelectionProfileUuid(request.params);
      this.throwIfReleasedBoundSession(request.params);
      if (listSessionUuid) {
        return this.sessionScopedForwardRoute(
          socketSessionId,
          listSessionUuid,
          undefined,
          toolSelectionProfileUuid,
        );
      }
      if (toolSelectionProfileUuid) {
        return this.toolSelectionProfileScopedForwardRoute(
          socketSessionId,
          toolSelectionProfileUuid,
          undefined,
        );
      }
      return boundRoute ?? this.sharedMcpForwardRoute(`method:${request.method}`);
    }

    const sessionUuid = this.getSessionUuid(request.params);
    const toolSelectionProfileUuid = this.getToolSelectionProfileUuid(request.params);
    this.throwIfReleasedBoundSession(request.params);
    if (sessionUuid) {
      return this.sessionScopedForwardRoute(
        socketSessionId,
        sessionUuid,
        undefined,
        toolSelectionProfileUuid,
      );
    }
    if (toolSelectionProfileUuid) {
      return this.toolSelectionProfileScopedForwardRoute(
        socketSessionId,
        toolSelectionProfileUuid,
        undefined,
      );
    }
    return boundRoute ?? this.sharedMcpForwardRoute(`method:${request.method}`);
  }

  private getNavigationGraphForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
    boundRoute: McpForwardRoute | undefined,
  ): McpForwardRoute {
    const sessionUuid = this.getSessionUuid(request.params);
    const executionKey = this.getRequestArgumentScopeKey(request.params);
    if (sessionUuid) {
      // An explicit read session routes to its OWN session-specific client so a
      // cross-session IDE read never repurposes the socket's bound transport. If
      // it reused the bound client, the loopback SessionToolBinding would be
      // rebound to this UUID while recordBoundMcpClientKey early-returns for
      // non-tools/call methods, leaving the daemon route labeled the bound
      // session and the transport filtering by a different profile (issue #4610).
      return this.sessionScopedForwardRoute(socketSessionId, sessionUuid, executionKey);
    }
    if (executionKey) {
      return boundRoute
        ? { ...boundRoute, executionKey }
        : this.sharedMcpForwardRoute(executionKey);
    }
    return boundRoute ?? this.sharedMcpForwardRoute(`method:${request.method}`);
  }

  private getResourceReadForwardRoute(
    request: DaemonRequest,
    socketSessionId: string,
  ): McpForwardRoute {
    this.throwIfReleasedBoundSession(request.params);
    const sessionUuid = this.getSessionUuid(request.params);
    if (sessionUuid) {
      return this.sessionScopedForwardRoute(socketSessionId, sessionUuid, undefined);
    }
    const uri = request.params?.uri;
    return this.sharedMcpForwardRoute(
      typeof uri === "string" ? `resource:${uri}` : "resource:unknown",
    );
  }

  private getToolsCallForwardRoute(args: unknown, socketSessionId: string): McpForwardRoute {
    this.throwIfReleasedBoundSession(args);
    const scopedKey = this.getRequestArgumentScopeKey(args);
    const boundRoute = this.getBoundMcpClientRoute(socketSessionId);
    const sessionUuid = this.getSessionUuid(args);
    const toolSelectionProfileUuid =
      this.getToolSelectionProfileUuid(args) ?? boundRoute?.toolSelectionProfileUuid;
    if (sessionUuid) {
      return this.sessionScopedForwardRoute(
        socketSessionId,
        sessionUuid,
        scopedKey,
        toolSelectionProfileUuid,
      );
    }
    if (toolSelectionProfileUuid) {
      return this.toolSelectionProfileScopedForwardRoute(
        socketSessionId,
        toolSelectionProfileUuid,
        scopedKey,
      );
    }

    if (scopedKey) {
      if (boundRoute) {
        return { ...boundRoute, executionKey: scopedKey };
      }
      return this.sharedMcpForwardRoute(scopedKey);
    }

    if (boundRoute) {
      return boundRoute;
    }

    const implicitAutolockKey = this.getImplicitAutolockScopeKey(socketSessionId, args);
    if (implicitAutolockKey) {
      return this.sharedMcpForwardRoute(implicitAutolockKey);
    }

    // The daemon injects __mcpSessionId before forwarding. Use the socket session as the
    // pre-forward key so separate daemon clients can autolock and run independently.
    return this.sharedMcpForwardRoute(`socket:${socketSessionId}`);
  }

  private sharedMcpForwardRoute(key: string): McpForwardRoute {
    return { executionKey: key, clientKey: key };
  }

  private sessionMcpClientKey(
    socketSessionId: string,
    sessionUuid: string,
    toolSelectionProfileUuid?: string,
  ): string {
    return toolSelectionProfileUuid
      ? `socket:${socketSessionId}:session:${sessionUuid}:tool-selection:${toolSelectionProfileUuid}`
      : `socket:${socketSessionId}:session:${sessionUuid}`;
  }

  private toolSelectionProfileMcpClientKey(
    socketSessionId: string,
    toolSelectionProfileUuid: string,
  ): string {
    return `socket:${socketSessionId}:tool-selection:${toolSelectionProfileUuid}`;
  }

  // Route an explicit-session request (tools/call or an IDE read) to its OWN
  // session-specific loopback client so it never repurposes the socket's bound
  // transport to a different session (issue #4610).
  private sessionScopedForwardRoute(
    socketSessionId: string,
    sessionUuid: string,
    scopedKey: string | undefined,
    toolSelectionProfileUuid?: string,
  ): McpForwardRoute {
    return {
      executionKey: scopedKey ?? `session:${sessionUuid}`,
      clientKey: this.sessionMcpClientKey(socketSessionId, sessionUuid, toolSelectionProfileUuid),
      sessionUuid,
      toolSelectionProfileUuid,
    };
  }

  private toolSelectionProfileScopedForwardRoute(
    socketSessionId: string,
    toolSelectionProfileUuid: string,
    scopedKey: string | undefined,
  ): McpForwardRoute {
    return {
      executionKey: scopedKey ?? `tool-selection:${toolSelectionProfileUuid}`,
      clientKey: this.toolSelectionProfileMcpClientKey(socketSessionId, toolSelectionProfileUuid),
      toolSelectionProfileUuid,
    };
  }

  private recordBoundMcpClientKey(
    request: DaemonRequest,
    socketSessionId: string,
    route: McpForwardRoute,
    sessionWasActiveBeforeForward: boolean,
    response: unknown,
  ): void {
    if (request.method !== "tools/call") {
      return;
    }
    const sessionUuid = this.getSessionUuid(request.params?.arguments);
    if (!sessionUuid) {
      this.recordGeneratedToolSelectionProfile(request, response, socketSessionId, route);
      return;
    }
    this.recordSessionBoundMcpClientKey(
      socketSessionId,
      route,
      sessionUuid,
      sessionWasActiveBeforeForward,
      request.params?.name,
      request.params?.arguments,
    );
  }

  private recordSessionBoundMcpClientKey(
    socketSessionId: string,
    route: McpForwardRoute,
    sessionUuid: string,
    sessionWasActiveBeforeForward: boolean,
    toolName: unknown,
    args: unknown,
  ): void {
    if (this.isReleasedBoundSession(args)) {
      this.clearBoundMcpClientKey(socketSessionId);
      return;
    }
    const sessionIsActiveAfterForward = this.hasActiveDaemonSession(sessionUuid);
    if (
      (sessionWasActiveBeforeForward || toolName === "executePlan") &&
      !sessionIsActiveAfterForward
    ) {
      this.clearBoundMcpClientKey(socketSessionId);
      return;
    }
    const previousBinding = this.boundMcpClientKeysBySocketSession.get(socketSessionId);
    this.boundMcpClientKeysBySocketSession.set(socketSessionId, {
      clientKey: route.clientKey,
      executionKey: route.executionKey,
      sessionUuid,
      toolSelectionProfileUuid: route.toolSelectionProfileUuid,
      requiresLiveDaemonSession: sessionWasActiveBeforeForward || sessionIsActiveAfterForward,
    });
    if (previousBinding && previousBinding.clientKey !== route.clientKey) {
      this.scheduleMcpClientIdleClose(previousBinding.clientKey);
    }
  }

  private recordGeneratedToolSelectionProfile(
    request: DaemonRequest,
    response: unknown,
    socketSessionId: string,
    route: McpForwardRoute,
  ): boolean {
    const toolSelectionProfileUuid = this.getGeneratedToolSelectionProfileUuid(request, response);
    if (!toolSelectionProfileUuid) {
      return false;
    }
    const previousBinding = this.boundMcpClientKeysBySocketSession.get(socketSessionId);
    this.boundMcpClientKeysBySocketSession.set(socketSessionId, {
      clientKey: route.clientKey,
      executionKey: route.executionKey,
      toolSelectionProfileUuid,
      requiresLiveDaemonSession: false,
    });
    if (previousBinding && previousBinding.clientKey !== route.clientKey) {
      this.scheduleMcpClientIdleClose(previousBinding.clientKey);
    }
    return true;
  }

  private getBoundMcpClientRoute(socketSessionId: string): McpForwardRoute | undefined {
    const boundClient = this.boundMcpClientKeysBySocketSession.get(socketSessionId);
    if (!boundClient) {
      return undefined;
    }
    if (!boundClient.requiresLiveDaemonSession || !this.daemonState.isInitialized()) {
      return {
        clientKey: boundClient.clientKey,
        executionKey: boundClient.executionKey,
        sessionUuid: boundClient.sessionUuid,
        toolSelectionProfileUuid: boundClient.toolSelectionProfileUuid,
      };
    }
    if (boundClient.sessionUuid && this.hasActiveDaemonSession(boundClient.sessionUuid)) {
      return {
        clientKey: boundClient.clientKey,
        executionKey: boundClient.executionKey,
        sessionUuid: boundClient.sessionUuid,
        toolSelectionProfileUuid: boundClient.toolSelectionProfileUuid,
      };
    }
    this.clearBoundMcpClientKey(socketSessionId);
    return undefined;
  }

  private getToolSelectionProfileUuid(params: unknown): string | undefined {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return undefined;
    }
    const value = (params as Record<string, unknown>)[DAEMON_TOOL_SELECTION_PROFILE_PARAM];
    return isNonBlankSessionUuid(value) ? value : undefined;
  }

  private getGeneratedToolSelectionProfileUuid(
    request: DaemonRequest,
    response: unknown,
  ): string | undefined {
    if (request.params?.name !== SET_TOOL_ENABLED_TOOL_NAME) {
      return undefined;
    }
    return toolSelectionProfileUuidFromResponse(response);
  }

  private clearBoundMcpClientKey(socketSessionId: string): void {
    const boundClient = this.boundMcpClientKeysBySocketSession.get(socketSessionId);
    if (!boundClient) {
      return;
    }
    this.boundMcpClientKeysBySocketSession.delete(socketSessionId);
    this.scheduleMcpClientIdleClose(boundClient.clientKey);
  }

  private clearBoundMcpClientsForReleasedSession(sessionUuid: string): void {
    for (const [socketSessionId, boundClient] of this.boundMcpClientKeysBySocketSession) {
      if (boundClient.sessionUuid === sessionUuid) {
        this.clearBoundMcpClientKey(socketSessionId);
      }
    }
  }

  private isMcpClientKeyBound(key: string): boolean {
    for (const boundClient of this.boundMcpClientKeysBySocketSession.values()) {
      if (boundClient.clientKey === key) {
        return true;
      }
    }
    return false;
  }

  private isDeviceControlSocketClosure(
    request: DaemonRequest,
    error: unknown,
  ): boolean {
    return isDeviceControlTransportRequest(request) && isUnexpectedSocketClosure(error);
  }

  private async forwardMcpRequestWithRecovery(
    context: McpForwardRecoveryContext,
  ): Promise<unknown> {
    const identity = this.getDeviceControlTransportIdentity(context.request, context.route);
    let mcpClient: Client;
    try {
      mcpClient = await this.getMcpClient(
        context.route.clientKey,
        context.route.sessionUuid,
        context.route.toolSelectionProfileUuid,
      );
    } catch (error) {
      if (!this.isDeviceControlSocketClosure(context.request, error)) {
        throw error;
      }
      return this.recoverDeviceControlTransport({
        ...context,
        phase: "connect",
        identity,
      });
    }
    return this.forwardConnectedMcpRequest(context, identity, mcpClient);
  }

  private async forwardConnectedMcpRequest(
    context: McpForwardRecoveryContext,
    identity: DeviceControlTransportIdentity,
    mcpClient: Client,
  ): Promise<unknown> {
    try {
      return await this.handleIdeRequest(
        mcpClient,
        context.request,
        context.remainingTimeoutMs,
        context.socketSessionId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Session not found")) {
        return this.retryExpiredMcpSession(context);
      }
      if (this.isDeviceControlSocketClosure(context.request, error)) {
        return this.recoverDeviceControlTransport({
          ...context,
          phase: "response",
          identity,
        });
      }
      throw error;
    }
  }

  private async retryExpiredMcpSession(
    context: McpForwardRecoveryContext,
  ): Promise<unknown> {
    logger.warn("MCP client session expired, reconnecting and retrying...");
    await this.resetMcpClient(context.route.clientKey);
    const freshClient = await this.getMcpClient(
      context.route.clientKey,
      context.route.sessionUuid,
      context.route.toolSelectionProfileUuid,
    );
    const retryRemainingMs =
      context.remainingTimeoutMs - (this.timer.now() - context.forwardStartMs);
    if (retryRemainingMs <= 0) {
      const toolName = context.request.method === "tools/call"
        ? context.request.params?.name ?? context.request.method
        : context.request.method;
      throw new McpTimeoutError({
        toolName,
        timeoutMs: context.remainingTimeoutMs,
        origin: "UnixSocketServer.handleRequest",
        detail: `no budget remaining after session reconnect (elapsed ${this.timer.now() - context.forwardStartMs}ms)`,
      });
    }
    return this.handleIdeRequest(
      freshClient,
      context.request,
      retryRemainingMs,
      context.socketSessionId,
    );
  }

  private getDeviceControlTransportIdentity(
    request: DaemonRequest,
    route: McpForwardRoute,
  ): DeviceControlTransportIdentity {
    const args = request.method === "tools/call" ? request.params?.arguments : undefined;
    const sessionUuid = route.sessionUuid ?? this.getSessionUuid(args);
    const deviceId = this.resolveDeviceControlDeviceId(args, sessionUuid);
    const deviceSessionUuid = this.resolveDeviceControlSessionUuid(deviceId);
    return { sessionUuid, deviceId, deviceSessionUuid };
  }

  private resolveDeviceControlDeviceId(
    args: unknown,
    sessionUuid?: string,
  ): string | undefined {
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const explicitDeviceId = (args as Record<string, unknown>).deviceId;
      if (typeof explicitDeviceId === "string") {
        return explicitDeviceId;
      }
    }
    if (!sessionUuid || !this.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      return this.daemonState.getSessionManager().getSession(sessionUuid)?.assignedDevice;
    } catch (error) {
      logger.debug(`Unable to resolve transport session ${sessionUuid}: ${error}`);
      return undefined;
    }
  }

  private resolveDeviceControlSessionUuid(deviceId?: string): string | undefined {
    if (!deviceId || !this.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      return this.daemonState
        .getDeviceSessionRegistry()
        .list()
        .find(record => record.deviceId === deviceId)
        ?.deviceSessionUuid;
    } catch (error) {
      logger.debug(`Unable to resolve transport device epoch for ${deviceId}: ${error}`);
      return undefined;
    }
  }

  private isDeviceControlTransportIdentityValid(
    identity: DeviceControlTransportIdentity,
  ): boolean {
    if (
      !this.daemonState.isInitialized()
      || !identity.deviceId
      || !identity.deviceSessionUuid
    ) {
      return false;
    }
    try {
      if (identity.sessionUuid) {
        const session = this.daemonState.getSessionManager().getSession(identity.sessionUuid);
        if (!session || session.assignedDevice !== identity.deviceId) {
          return false;
        }
      }
      const liveDeviceSession = this.daemonState
        .getDeviceSessionRegistry()
        .list()
        .find(record => record.deviceId === identity.deviceId);
      return liveDeviceSession?.deviceSessionUuid === identity.deviceSessionUuid;
    } catch (error) {
      logger.debug(`Unable to validate device-control transport identity: ${error}`);
      return false;
    }
  }

  private deviceControlTransportError(input: {
    request: DaemonRequest;
    identity: DeviceControlTransportIdentity;
    phase: DeviceControlTransportPhase;
    reconnectAttempted: boolean;
    replayAttempted: boolean;
    recoveryExhausted: boolean;
  }): DeviceControlTransportError {
    const toolName = deviceControlToolName(input.request);
    const sessionValid = this.isDeviceControlTransportIdentityValid(input.identity);
    const retryable =
      sessionValid
      && (
        input.phase === "connect"
        || isReplaySafeAfterResponseClosure(input.request)
      );
    const failure: DeviceControlTransportFailure = {
      code: DEVICE_CONTROL_TRANSPORT_FAILURE_CODE,
      transport: "daemon_loopback_http",
      toolName,
      ...(input.identity.deviceId ? { deviceId: input.identity.deviceId } : {}),
      ...(input.identity.deviceSessionUuid
        ? { deviceSessionUuid: input.identity.deviceSessionUuid }
        : {}),
      ...(input.identity.sessionUuid ? { sessionUuid: input.identity.sessionUuid } : {}),
      sessionValid,
      phase: input.phase,
      retryable,
      reconnectAttempted: input.reconnectAttempted,
      replayAttempted: input.replayAttempted,
    };
    const message = input.recoveryExhausted
      ? `Device-control transport recovery exhausted while handling ${toolName}`
      : `Device-control transport closed while handling ${toolName}`;
    return new DeviceControlTransportError(message, failure);
  }

  private async recoverDeviceControlTransport(input: {
    request: DaemonRequest;
    route: McpForwardRoute;
    socketSessionId: string;
    remainingTimeoutMs: number;
    forwardStartMs: number;
    phase: DeviceControlTransportPhase;
    identity: DeviceControlTransportIdentity;
  }): Promise<unknown> {
    if (!this.isDeviceControlTransportIdentityValid(input.identity)) {
      throw this.deviceControlTransportError({
        request: input.request,
        identity: input.identity,
        phase: input.phase,
        reconnectAttempted: false,
        replayAttempted: false,
        recoveryExhausted: false,
      });
    }

    const replayAfterResponse =
      input.phase === "response"
      && isReplaySafeAfterResponseClosure(input.request);
    logger.warn(
      `[McpForward] device-control transport closed for ${deviceControlToolName(input.request)} during ${input.phase}; reconnecting once`,
    );
    await this.resetMcpClient(input.route.clientKey);
    const retryRemainingMs =
      input.remainingTimeoutMs - (this.timer.now() - input.forwardStartMs);
    if (retryRemainingMs <= 0) {
      throw this.deviceControlTransportError({
        request: input.request,
        identity: input.identity,
        phase: input.phase,
        reconnectAttempted: true,
        replayAttempted: false,
        recoveryExhausted: true,
      });
    }

    let freshClient: Client;
    try {
      freshClient = await this.getMcpClient(
        input.route.clientKey,
        input.route.sessionUuid,
        input.route.toolSelectionProfileUuid,
      );
    } catch {
      logger.warn(
        `[McpForward] device-control transport reconnect failed for ${deviceControlToolName(input.request)}`,
      );
      throw this.deviceControlTransportError({
        request: input.request,
        identity: input.identity,
        phase: input.phase,
        reconnectAttempted: true,
        replayAttempted: false,
        recoveryExhausted: true,
      });
    }

    if (!this.isDeviceControlTransportIdentityValid(input.identity)) {
      throw this.deviceControlTransportError({
        request: input.request,
        identity: input.identity,
        phase: input.phase,
        reconnectAttempted: true,
        replayAttempted: false,
        recoveryExhausted: false,
      });
    }
    if (input.phase === "response" && !replayAfterResponse) {
      throw this.deviceControlTransportError({
        request: input.request,
        identity: input.identity,
        phase: input.phase,
        reconnectAttempted: true,
        replayAttempted: false,
        recoveryExhausted: false,
      });
    }

    try {
      return await this.handleIdeRequest(
        freshClient,
        input.request,
        retryRemainingMs,
        input.socketSessionId,
      );
    } catch (error) {
      if (!isUnexpectedSocketClosure(error)) {
        throw error;
      }
      throw this.deviceControlTransportError({
        request: input.request,
        identity: input.identity,
        phase: "response",
        reconnectAttempted: true,
        replayAttempted: replayAfterResponse,
        recoveryExhausted: true,
      });
    }
  }

  private wasRequestSessionActive(request: DaemonRequest): boolean {
    const sessionUuid =
      request.method === "tools/call" ? this.getSessionUuid(request.params?.arguments) : undefined;
    return sessionUuid ? this.hasActiveDaemonSession(sessionUuid) : false;
  }

  private hasActiveDaemonSession(sessionUuid: string): boolean {
    if (!this.daemonState.isInitialized()) {
      return false;
    }
    try {
      return this.daemonState.getSessionManager().getSession(sessionUuid) !== null;
    } catch (error) {
      logger.debug(`Unable to resolve bound session ${sessionUuid}: ${error}`);
      return false;
    }
  }

  private getSessionUuid(args: unknown): string | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    const sessionUuid = (args as Record<string, unknown>).sessionUuid;
    return isNonBlankSessionUuid(sessionUuid) ? sessionUuid : undefined;
  }

  private isReleasedBoundSession(args: unknown): boolean {
    if (
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      !this.daemonState.isInitialized()
    ) {
      return false;
    }
    const record = args as Record<string, unknown>;
    const sessionUuid = this.getSessionUuid(record);
    return (
      sessionUuid !== undefined &&
      record[DAEMON_BOUND_SESSION_PARAM] === sessionUuid &&
      !this.hasActiveDaemonSession(sessionUuid)
    );
  }

  private throwIfReleasedBoundSession(args: unknown): void {
    if (!this.isReleasedBoundSession(args)) {
      return;
    }
    throw new Error(`Session not found: ${this.getSessionUuid(args)}`);
  }

  private getRequestArgumentScopeKey(args: unknown): string | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }

    const record = args as Record<string, unknown>;
    const hasSessionUuid = isNonBlankSessionUuid(record.sessionUuid);
    const hasDeviceLabel = typeof record.device === "string" && record.device.length > 0;

    // Precedence (pinned by #2565 review): a device label resolves the mapped session before
    // an explicit deviceId, which in turn beats a raw session, which beats implicit autolock.
    if (hasSessionUuid && hasDeviceLabel) {
      return this.sessionToScopeKey(
        this.resolveDeviceLabelSession(record.sessionUuid as string, record.device),
      );
    }
    // An explicit target device must serialize by physical device even when a session is present.
    if (typeof record.deviceId === "string" && record.deviceId.length > 0) {
      return `device:${record.deviceId}`;
    }
    if (hasSessionUuid) {
      return this.sessionToScopeKey(record.sessionUuid as string);
    }
    if (typeof record.__mcpSessionId === "string" && record.__mcpSessionId.length > 0) {
      return (
        this.getImplicitAutolockScopeKey(record.__mcpSessionId, args) ??
        `mcp-session:${record.__mcpSessionId}`
      );
    }
    return undefined;
  }

  /**
   * Resolve a session UUID to its forwarding scope key: the bound physical device when one is
   * assigned (so independent devices serialize together), otherwise the raw session. This is the
   * single resolver every session-keyed branch feeds, including implicit autolock resolution.
   */
  private sessionToScopeKey(sessionUuid: string): string {
    const assignedDevice = this.getAssignedDeviceForSession(sessionUuid);
    return assignedDevice ? `device:${assignedDevice}` : `session:${sessionUuid}`;
  }

  private getImplicitAutolockScopeKey(mcpSessionId: string, args: unknown): string | undefined {
    if (!this.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      const platform = this.getRequestPlatform(args);
      const autolockSession = this.daemonState
        .getDevicePool()
        .resolveAutolockSessionForMcpSession?.(mcpSessionId, platform);
      if (!autolockSession) {
        return undefined;
      }
      return this.sessionToScopeKey(autolockSession);
    } catch (error) {
      logger.debug(`Unable to resolve autolock session for MCP session ${mcpSessionId}: ${error}`);
      return undefined;
    }
  }

  private getRequestPlatform(args: unknown): "android" | "ios" | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }
    const platform = (args as Record<string, unknown>).platform;
    return platform === "android" || platform === "ios" ? platform : undefined;
  }

  private resolveDeviceLabelSession(baseSessionUuid: string, deviceLabel: unknown): string {
    if (
      typeof deviceLabel !== "string" ||
      deviceLabel.length === 0 ||
      !this.daemonState.isInitialized()
    ) {
      return baseSessionUuid;
    }
    try {
      const labelMap = this.daemonState.getSessionManager().getDeviceLabels(baseSessionUuid);
      if (!labelMap) {
        return baseSessionUuid;
      }
      const mappedSession = labelMap[deviceLabel];
      return typeof mappedSession === "string" && mappedSession.length > 0
        ? mappedSession
        : baseSessionUuid;
    } catch (error) {
      logger.debug(
        `Unable to resolve device label ${deviceLabel} for session ${baseSessionUuid}: ${error}`,
      );
      return baseSessionUuid;
    }
  }

  private getAssignedDeviceForSession(sessionUuid: string): string | undefined {
    if (!this.daemonState.isInitialized()) {
      return undefined;
    }
    try {
      return this.daemonState.getSessionManager().getSession(sessionUuid)?.assignedDevice;
    } catch (error) {
      logger.debug(`Unable to resolve device for session ${sessionUuid}: ${error}`);
      return undefined;
    }
  }

  /** Compact label for debug logs (method + tool name or resource URI). */
  private static describeMcpForwardRequest(request: DaemonRequest): string {
    if (request.method === "tools/call") {
      const name = request.params?.name;
      return `method=tools/call tool=${typeof name === "string" ? name : "?"}`;
    }
    if (request.method === "resources/read") {
      const uri = request.params?.uri;
      return `method=resources/read uri=${typeof uri === "string" ? uri : "?"}`;
    }
    return `method=${request.method}`;
  }

  /**
   * Handle socket requests that don't require the MCP client.
   * Returns undefined if the request should be forwarded to MCP.
   */
  private async handleLocalSocketRequest(
    request: DaemonRequest,
    socketSessionId?: string,
  ): Promise<any | undefined> {
    if (request.method === "input/tap") {
      return await this.handleInputTap(request, socketSessionId);
    }
    if (request.method === "input/swipe") {
      return await this.handleInputSwipe(request, socketSessionId);
    }
    if (request.method === "input/typeText") {
      return await this.handleInputTypeText(request, socketSessionId);
    }
    if (request.method === "input/pressButton") {
      return await this.handleInputPressButton(request, socketSessionId);
    }
    if (request.method === "input/key") {
      return await this.handleInputKey(request, socketSessionId);
    }
    if (request.method === "input/gestureStart") {
      return await this.handleInputGesture(request, "start", socketSessionId);
    }
    if (request.method === "input/gestureMove") {
      return await this.handleInputGesture(request, "move", socketSessionId);
    }
    if (request.method === "input/gestureEnd") {
      return await this.handleInputGesture(request, "end", socketSessionId);
    }

    switch (request.method) {
      case "ide/listFeatureFlags": {
        if (!this.featureFlagService) {
          throw new Error("Feature flag service not available");
        }
        const flags = await this.featureFlagService.listFlags();
        return { flags };
      }
      case "ide/setFeatureFlag": {
        if (!this.featureFlagService) {
          throw new Error("Feature flag service not available");
        }
        const args = request.params as {
          key?: string;
          enabled?: boolean;
          config?: Record<string, unknown> | null;
        };
        if (!args.key || typeof args.enabled !== "boolean") {
          throw new Error("setFeatureFlag requires 'key' (string) and 'enabled' (boolean) params");
        }
        const updated = await this.featureFlagService.setFlag(
          args.key as FeatureFlagKey,
          args.enabled,
          args.config,
        );
        return updated;
      }
      case "ide/setSessionToolEnabled": {
        const args = request.params as {
          sessionUuid?: string;
          toolName?: string;
          enabled?: boolean;
        };
        if (
          !args.sessionUuid ||
          !args.toolName ||
          !ToolRegistry.isUserConfigurableTool(args.toolName) ||
          typeof args.enabled !== "boolean"
        ) {
          throw new Error(
            "setSessionToolEnabled requires sessionUuid, a user-configurable toolName, and enabled boolean params",
          );
        }
        await (this.sessionToolSelectionService ?? getSessionToolSelectionService()).setEnabled(
          args.sessionUuid,
          args.toolName,
          args.enabled,
        );
        ListChangedBroadcaster.emit("tools");
        return {
          sessionUuid: args.sessionUuid,
          toolName: args.toolName,
          enabled: args.enabled,
        };
      }
      case "ide/ping": {
        return { ok: true, timestamp: this.timer.now() };
      }
      case "ide/status": {
        return {
          // Concrete pinned version (honors AUTOMOBILE_VERSION), never the
          // floating "latest" tag — external consumers must see exactly what the
          // daemon will fetch (#2746).
          version: getMcpServerVersion(),
          releaseVersion: resolveAssetVersion(resolvePinnedVersion()),
          android: {
            ctrlProxy: {
              expectedSha256: resolveApkChecksum(),
              url: resolveApkUrl(),
            },
          },
          ios: {
            xcTestService: {
              expectedSha256: resolveIpaChecksum(),
              expectedAppHash: IOS_CTRL_PROXY_APP_HASH,
              url: resolveIpaUrl(),
            },
          },
        };
      }
      case "ide/updateService": {
        const args = request.params as { deviceId?: string; platform?: string };
        if (!args.deviceId || !args.platform) {
          throw new Error(
            "updateService requires 'deviceId' (string) and 'platform' (string) params",
          );
        }
        if (args.platform !== "android" && args.platform !== "ios") {
          throw new Error(`Invalid platform: ${args.platform}. Must be 'android' or 'ios'.`);
        }

        // Find the booted device
        const bootedDevices = await PlatformDeviceManagerFactory.getInstance().getBootedDevices(
          args.platform,
        );
        const targetDevice = bootedDevices.find((d) => d.deviceId === args.deviceId);
        if (!targetDevice) {
          throw new Error(`Device not found: ${args.deviceId}`);
        }

        if (args.platform === "android") {
          const manager = AndroidCtrlProxyManager.getInstance(targetDevice);
          const result = await manager.ensureCompatibleVersion({
            allowDownloadWhenInstalled: true,
            bypassVersionCheckCache: true,
          });
          const successStatuses = new Set(["compatible", "upgraded", "installed", "reinstalled"]);
          return {
            success: successStatuses.has(result.status),
            message: `Accessibility service ${result.status}${result.error ? `: ${result.error}` : ""}`,
            status: result,
          };
        } else {
          const manager = IOSCtrlProxyManager.getInstance(targetDevice);
          await manager.forceRestart();
          return {
            success: true,
            message: "CtrlProxy iOS restarted",
          };
        }
      }
      case "ide/setKeyValue": {
        const args = request.params as {
          platform?: string;
          deviceId?: string;
          appId?: string;
          fileName?: string;
          key?: string;
          value?: string | null;
          type?: string;
        };
        if (!args.deviceId || !args.appId || !args.fileName || !args.key || !args.type) {
          throw new Error("setKeyValue requires deviceId, appId, fileName, key, and type params");
        }
        await this.assertSocketToolEnabled(args.deviceId, "setKeyValue");
        const client = await this.resolveKeyValueMutationClient(args.platform, args.deviceId);
        if (args.value === null || args.value === undefined) {
          await client.removePreference(args.appId, args.fileName, args.key);
        } else {
          await client.setPreference(
            args.appId,
            args.fileName,
            args.key,
            args.value,
            args.type as KeyValueType,
          );
        }
        return { success: true };
      }
      case "ide/removeKeyValue": {
        const args = request.params as {
          platform?: string;
          deviceId?: string;
          appId?: string;
          fileName?: string;
          key?: string;
        };
        if (!args.deviceId || !args.appId || !args.fileName || !args.key) {
          throw new Error("removeKeyValue requires deviceId, appId, fileName, and key params");
        }
        await this.assertSocketToolEnabled(args.deviceId, "removeKeyValue");
        const client = await this.resolveKeyValueMutationClient(args.platform, args.deviceId);
        await client.removePreference(args.appId, args.fileName, args.key);
        return { success: true };
      }
      case "ide/clearKeyValueFile": {
        const args = request.params as {
          platform?: string;
          deviceId?: string;
          appId?: string;
          fileName?: string;
        };
        if (!args.deviceId || !args.appId || !args.fileName) {
          throw new Error("clearKeyValueFile requires deviceId, appId, and fileName params");
        }
        await this.assertSocketToolEnabled(args.deviceId, "clearKeyValueFile");
        const client = await this.resolveKeyValueMutationClient(args.platform, args.deviceId);
        await client.clearPreferenceStore(args.appId, args.fileName);
        return { success: true };
      }
      default:
        return undefined;
    }
  }

  /**
   * Resolve the platform-appropriate storage-mutation client for a key-value
   * `ide/*` request. iOS Storage-facet edits carry `platform: "ios"` so the pane
   * targets the iOS simulator + IOSCtrlProxyClient; a missing platform defaults
   * to Android for backward compatibility with older desktop clients (#4708).
   */
  private async resolveKeyValueMutationClient(
    platformValue: string | undefined,
    deviceId: string,
  ): Promise<KeyValueMutationClient> {
    const platform = platformValue ?? "android";
    if (platform !== "android" && platform !== "ios") {
      throw new Error(`Invalid platform: ${platform}. Must be 'android' or 'ios'.`);
    }
    const bootedDevices =
      await PlatformDeviceManagerFactory.getInstance().getBootedDevices(platform);
    const targetDevice = bootedDevices.find((d) => d.deviceId === deviceId);
    if (!targetDevice) {
      throw new Error(`Device not found: ${deviceId}`);
    }
    return platform === "ios"
      ? IOSCtrlProxyClient.getInstance(targetDevice)
      : AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
  }

  private async assertSocketToolEnabled(deviceId: string, toolName: string): Promise<void> {
    const registeredTool = ToolRegistry.getRegisteredTool(toolName);
    // Direct IDE storage routes have a fixed exact-tool allowlist and may run
    // before any loopback MCP client has populated the process registry.
    const declaredDefault = registeredTool?.defaultEnabled ?? false;
    if (!this.daemonState.isInitialized()) {
      await assertToolEnabledForAnySession(
        toolName,
        declaredDefault,
        [undefined],
        this.sessionToolSelectionService,
      );
      return;
    }
    const sessionManager = this.daemonState.getSessionManager();
    // The device's owning session may be a derived `${base}:${label}` label
    // session. Enforce the UNION of base + derived (issue #4611 Gap B, product
    // decision) so a tool is enabled when EITHER grants it — symmetric with the
    // MCP `registerDeviceAware` path. The shared helper resolves the base.
    const derivedSessionUuid = sessionManager.getSessionForDevice?.(deviceId) ?? undefined;
    const baseSessionUuid = resolveToolSelectionBaseSessionUuid(derivedSessionUuid, sessionManager);
    await assertToolEnabledForAnySession(
      toolName,
      declaredDefault,
      [baseSessionUuid, derivedSessionUuid],
      this.sessionToolSelectionService,
    );
  }

  /**
   * Convert incoming `input/*` coordinates to the units the iOS XCUITest runner expects (points).
   *
   * A control client that renders a canonical-pixel observation frame (#4549) sends taps/swipes in
   * PIXELS, so divide by the runner-reported `nativeScale` before dispatch — the inverse of the
   * daemon's publish-side point->pixel conversion, so the tap lands at the same physical location.
   * The divide is EXACT (fractional points; XCUITest accepts them), so the round-trip carries only
   * the single publish-side quantization.
   *
   * The scale metadata is populated by #4548 on hierarchy RECEIPT, which has not happened yet if a
   * control client sends its first input before the daemon has received any hierarchy for this
   * device — dispatching those pixels as points would land a 3x tap at 1/3 scale. So when the
   * metadata is null we fetch one hierarchy first (no observation-stream push, bounded by
   * `probeTimeoutMs`) to populate it, then decide:
   *  - probe FAILS (throws, or returns no hierarchy — not connected / timed out): fail closed with
   *    an actionable error rather than mis-dispatching; do NOT cache (the next input re-probes).
   *  - probe SUCCEEDS but the runner carries no metadata: a genuine pre-#4548 legacy runner, whose
   *    control client sends point-space coordinates — pass through, and cache the verdict so
   *    subsequent legacy taps skip the round trip. The cache entry is dropped the moment metadata
   *    appears, so a runner upgrade is not pinned to the legacy verdict.
   *
   * The caller must charge the probe's elapsed time against the gesture budget (recompute the
   * remaining timeout after this resolves) so probe + gesture never exceed one request budget.
   */
  /**
   * The gesture budget remaining after the iOS scale probe (if any) ran, charging its elapsed
   * wall-time against the request's total budget so probe + gesture never exceed one budget (#3351).
   * Throws a timeout when the probe already consumed the budget, rather than starting a full-budget
   * gesture on top of it. On the common path (metadata already known) the probe is synchronous, so
   * the elapsed time is just the queue wait and this returns ~the full remaining budget.
   */
  private remainingBudgetAfterProbe(
    queueEnterMs: number,
    totalTimeoutMs: number,
    toolName: string,
    origin: string,
  ): number {
    const remaining = totalTimeoutMs - (this.timer.now() - queueEnterMs);
    if (remaining <= 0) {
      throw new McpTimeoutError({
        toolName,
        timeoutMs: totalTimeoutMs,
        origin: `UnixSocketServer.${origin}`,
        detail: "iOS screen-scale probe consumed the request budget",
      });
    }
    return remaining;
  }

  private async toIosRunnerCoordinates(
    client: IOSCtrlProxyClient,
    deviceId: string,
    coordinates: number[],
    probeTimeoutMs: number,
    validateCanonicalCoordinates?: (geometry: ScreenScaleMetadata) => void,
  ): Promise<number[]> {
    const knownMetadata = client.getScreenScaleMetadata();
    if (knownMetadata) {
      // Metadata present: a runner upgrade drops any stale confirmed-legacy verdict for this device.
      this.confirmedLegacyScaleDevices.delete(deviceId);
      validateCanonicalCoordinates?.(knownMetadata);
      return coordinates.map((coordinate) =>
        canonicalPixelsToPoints(coordinate, knownMetadata.nativeScale),
      );
    }
    if (this.confirmedLegacyScaleDevices.has(deviceId)) {
      // A prior probe SUCCEEDED with no metadata: a confirmed legacy runner. Skip the round trip.
      return coordinates;
    }

    // Startup window: no hierarchy received yet, so #4548 receipt-based retention has not run. Fetch
    // one (without an observation-stream push) so the scale is known before we decide the space.
    let probed: unknown;
    try {
      probed = await client.requestHierarchySyncWithoutObservationStreamPush(
        undefined,
        false,
        undefined,
        probeTimeoutMs,
      );
    } catch (error) {
      // Probe threw: a transient failure, NOT evidence of a legacy runner. Fail closed rather than
      // mis-dispatching pixels as points.
      throw toActionableError(
        error,
        `Could not determine iOS screen scale for ${deviceId}; the input coordinate scale probe failed`,
      );
    }
    if (!probed) {
      // Probe returned no hierarchy (not connected / timed out): a FAILURE, distinct from a runner
      // that answered with no metadata. Fail closed and do NOT cache — the next input re-probes.
      throw new ActionableError(
        `Could not determine iOS screen scale for ${deviceId}: the hierarchy probe returned no data. ` +
          `Retry once the device has produced a hierarchy.`,
      );
    }

    const probedMetadata = client.getScreenScaleMetadata();
    if (!probedMetadata) {
      // Probe SUCCEEDED but the runner reported no scale metadata: a genuine pre-#4548 legacy
      // runner. The control client never received px bounds, so it sends points — pass through, and
      // cache the verdict so subsequent legacy taps skip the probe.
      this.confirmedLegacyScaleDevices.add(deviceId);
      return coordinates;
    }
    validateCanonicalCoordinates?.(probedMetadata);
    return coordinates.map((coordinate) =>
      canonicalPixelsToPoints(coordinate, probedMetadata.nativeScale),
    );
  }

  /**
   * Canonical pixel bounds arrive with the complete runner metadata. A missing tuple is a legacy
   * runner or an unseen hierarchy, where preserving the existing pass-through behavior is safer
   * than guessing dimensions.
   */
  private requireCoordinatesWithinKnownScreenGeometry(
    coordinates: readonly [number, number],
    geometry: ScreenScaleMetadata | null,
  ): void {
    if (!geometry) {
      return;
    }
    const [x, y] = coordinates;
    if (x < 0 || x >= geometry.pixelWidth || y < 0 || y >= geometry.pixelHeight) {
      throw new Error(
        `input/tap coordinates x=${x}, y=${y} are outside device canonical pixel bounds ` +
          `x: 0..${geometry.pixelWidth - 1}, y: 0..${geometry.pixelHeight - 1}`,
      );
    }
  }

  private async handleInputTap(
    request: DaemonRequest,
    socketSessionId?: string,
  ): Promise<any | undefined> {
    const queueEnterMs = this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputTapParams(request.params);
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      "input/tap",
    );
    const gestureResult = await this.runKeyedMcpForward(
      `device:${targetDevice.deviceId}`,
      async () => {
        this.requireCurrentFrameContext(targetDevice.deviceId, args.frameContext, "input/tap");
        const queueWaitMs = this.timer.now() - queueEnterMs;
        const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
        if (remainingTimeoutMs <= 0) {
          throw new McpTimeoutError({
            toolName: request.method,
            timeoutMs: totalTimeoutMs,
            origin: "UnixSocketServer.handleInputTap",
            detail: `spent ${queueWaitMs}ms waiting in queue`,
          });
        }

        if (args.platform === "android") {
          const client = AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
          this.requireCoordinatesWithinKnownScreenGeometry(
            [args.x, args.y],
            client.getScreenScaleMetadata?.() ?? null,
          );
          return args.frameContext === undefined
            ? await client.requestTapCoordinates(args.x, args.y, args.duration, remainingTimeoutMs)
            : await client.requestTapCoordinates(
                args.x,
                args.y,
                args.duration,
                remainingTimeoutMs,
                undefined,
                args.frameContext,
              );
        }
        const iosClient = IOSCtrlProxyClient.getInstance(targetDevice);
        const [x, y] = await this.toIosRunnerCoordinates(
          iosClient,
          targetDevice.deviceId,
          [args.x, args.y],
          remainingTimeoutMs,
          (geometry) =>
            this.requireCoordinatesWithinKnownScreenGeometry([args.x, args.y], geometry),
        );
        const gestureTimeoutMs = this.remainingBudgetAfterProbe(
          queueEnterMs,
          totalTimeoutMs,
          request.method,
          "handleInputTap",
        );
        return args.frameContext === undefined
          ? await iosClient.requestTapCoordinates(x, y, args.duration, gestureTimeoutMs)
          : await iosClient.requestTapCoordinates(
              x,
              y,
              args.duration,
              gestureTimeoutMs,
              undefined,
              args.frameContext,
            );
      },
      `device:${targetDevice.deviceId}`,
    );

    if (!gestureResult.success) {
      throw new Error(gestureResult.error ?? `input/tap failed on ${args.platform}`);
    }

    return {
      action: "input/tap",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      coordinates: { x: args.x, y: args.y },
    };
  }

  private async handleInputSwipe(
    request: DaemonRequest,
    socketSessionId?: string,
  ): Promise<any | undefined> {
    const queueEnterMs = this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputSwipeParams(request.params);
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      "input/swipe",
    );
    const gestureResult = await this.runKeyedMcpForward(
      `device:${targetDevice.deviceId}`,
      async () => {
        this.requireCurrentFrameContext(targetDevice.deviceId, args.frameContext, "input/swipe");
        const queueWaitMs = this.timer.now() - queueEnterMs;
        const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
        if (remainingTimeoutMs <= 0) {
          throw new McpTimeoutError({
            toolName: request.method,
            timeoutMs: totalTimeoutMs,
            origin: "UnixSocketServer.handleInputSwipe",
            detail: `spent ${queueWaitMs}ms waiting in queue`,
          });
        }

        if (args.platform === "android") {
          const client = AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
          return args.frameContext === undefined
            ? await client.requestSwipe(
                args.startX,
                args.startY,
                args.endX,
                args.endY,
                args.durationMs,
                remainingTimeoutMs,
              )
            : await client.requestSwipe(
                args.startX,
                args.startY,
                args.endX,
                args.endY,
                args.durationMs,
                remainingTimeoutMs,
                undefined,
                args.frameContext,
              );
        }
        const client = IOSCtrlProxyClient.getInstance(targetDevice);
        const [startX, startY, endX, endY] = await this.toIosRunnerCoordinates(
          client,
          targetDevice.deviceId,
          [args.startX, args.startY, args.endX, args.endY],
          remainingTimeoutMs,
        );
        const gestureTimeoutMs = this.remainingBudgetAfterProbe(
          queueEnterMs,
          totalTimeoutMs,
          request.method,
          "handleInputSwipe",
        );
        return args.frameContext === undefined
          ? await client.requestDrag(
              startX,
              startY,
              endX,
              endY,
              0,
              args.durationMs,
              0,
              gestureTimeoutMs,
            )
          : await client.requestDrag(
              startX,
              startY,
              endX,
              endY,
              0,
              args.durationMs,
              0,
              gestureTimeoutMs,
              args.frameContext,
            );
      },
      `device:${targetDevice.deviceId}`,
    );

    if (!gestureResult.success) {
      throw new Error(gestureResult.error ?? `input/swipe failed on ${args.platform}`);
    }

    return {
      action: "input/swipe",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      start: { x: args.startX, y: args.startY },
      end: { x: args.endX, y: args.endY },
      durationMs: args.durationMs,
    };
  }

  /**
   * One streamed-gesture frame (start / move / end). A live drag arrives as one `input/gestureStart`,
   * many `input/gestureMove`, and one `input/gestureEnd` sharing a `gestureId`; the runner chains
   * them into a single continued on-device gesture. Android only — streaming has no XCUITest
   * equivalent, so the desktop client keeps the atomic `input/swipe` for iOS and old daemons.
   *
   * Frame-identity-free like taps: no `frameContext` is required or checked, so a snapshot advancing
   * mid-drag cannot reject an in-flight gesture as stale. Each frame is serialized through the same
   * per-device keyed forward as taps/swipes, so gesture ordering is preserved.
   */
  private async handleInputGesture(
    request: DaemonRequest,
    kind: "start" | "move" | "end",
    socketSessionId?: string,
  ): Promise<any | undefined> {
    const method = GESTURE_FRAME_METHODS[kind];
    const queueEnterMs = this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputGestureParams(request.params, method);
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      method,
    );
    const gestureResult = await this.runKeyedMcpForward(
      `device:${targetDevice.deviceId}`,
      async () => {
        const queueWaitMs = this.timer.now() - queueEnterMs;
        const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
        if (remainingTimeoutMs <= 0) {
          throw new McpTimeoutError({
            toolName: method,
            timeoutMs: totalTimeoutMs,
            origin: "UnixSocketServer.handleInputGesture",
            detail: `spent ${queueWaitMs}ms waiting in queue`,
          });
        }
        const client = AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
        return this.forwardGestureFrame(client, kind, args, remainingTimeoutMs);
      },
      `device:${targetDevice.deviceId}`,
    );

    if (!gestureResult.success) {
      throw new Error(gestureResult.error ?? `${method} failed on ${args.platform}`);
    }

    // Track ownership so a socket that tears down mid-drag can lift its still-open on-device stroke.
    // Only an acked start opens the gesture; an end (release OR cancel) closes it. A socket-less
    // forward (no client session) can't be cancelled on close, so it isn't tracked.
    if (socketSessionId) {
      if (kind === "start") {
        this.rememberOwnedGesture(socketSessionId, targetDevice, args.gestureId);
      } else if (kind === "end") {
        this.forgetOwnedGesture(socketSessionId, targetDevice.deviceId, args.gestureId);
      }
    }

    return {
      action: method,
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      gestureId: args.gestureId,
      point: { x: args.x, y: args.y },
      ...(kind === "end" ? { cancel: args.cancel } : {}),
    };
  }

  private static ownedGestureKey(deviceId: string, gestureId: string): string {
    return `${deviceId}::${gestureId}`;
  }

  private rememberOwnedGesture(
    socketSessionId: string,
    targetDevice: BootedDevice,
    gestureId: string,
  ): void {
    const key = UnixSocketServer.ownedGestureKey(targetDevice.deviceId, gestureId);
    const forSocket =
      this.ownedGesturesBySocket.get(socketSessionId) ?? new Map<string, OwnedGesture>();
    forSocket.set(key, { targetDevice, gestureId });
    this.ownedGesturesBySocket.set(socketSessionId, forSocket);
  }

  private forgetOwnedGesture(socketSessionId: string, deviceId: string, gestureId: string): void {
    const forSocket = this.ownedGesturesBySocket.get(socketSessionId);
    if (!forSocket) {
      return;
    }
    forSocket.delete(UnixSocketServer.ownedGestureKey(deviceId, gestureId));
    if (forSocket.size === 0) {
      this.ownedGesturesBySocket.delete(socketSessionId);
    }
  }

  /**
   * Cancel every gesture a closing/erroring socket still owns. Best-effort: each cancelling
   * `gestureEnd` is forwarded through the same per-device keyed queue as live frames (so it can't
   * race an in-flight frame) and a failure is logged, never thrown — the socket is already gone.
   */
  private async cancelOwnedGestures(socketSessionId: string): Promise<void> {
    const forSocket = this.ownedGesturesBySocket.get(socketSessionId);
    if (!forSocket || forSocket.size === 0) {
      this.ownedGesturesBySocket.delete(socketSessionId);
      return;
    }
    this.ownedGesturesBySocket.delete(socketSessionId);
    for (const { targetDevice, gestureId } of forSocket.values()) {
      try {
        await this.runKeyedMcpForward(
          `device:${targetDevice.deviceId}`,
          async () => {
            const client = AndroidCtrlProxyClient.getInstance(
              targetDevice,
              defaultAdbClientFactory,
            );
            // Coordinates are ignored for a cancel (the runner lifts in place), so 0,0 is fine.
            return client.requestGestureEnd(gestureId, 0, 0, true, OWNED_GESTURE_CANCEL_TIMEOUT_MS);
          },
          `device:${targetDevice.deviceId}`,
        );
      } catch (error) {
        logger.warn(
          `Failed to cancel orphaned gesture ${gestureId} on ${targetDevice.deviceId} for closed socket ${socketSessionId}: ${error}`,
        );
      }
    }
  }

  /** Relay one gesture frame to the Android runner's continued-gesture path. */
  private forwardGestureFrame(
    client: AndroidCtrlProxyClient,
    kind: "start" | "move" | "end",
    args: { gestureId: string; x: number; y: number; cancel: boolean },
    timeoutMs: number,
  ) {
    switch (kind) {
      case "start":
        return client.requestGestureStart(args.gestureId, args.x, args.y, timeoutMs);
      case "move":
        return client.requestGestureMove(args.gestureId, args.x, args.y, timeoutMs);
      case "end":
        return client.requestGestureEnd(args.gestureId, args.x, args.y, args.cancel, timeoutMs);
    }
  }

  private parseInputGestureParams(
    params: unknown,
    method: string,
  ): {
    platform: "android";
    deviceId?: string;
    gestureId: string;
    x: number;
    y: number;
    cancel: boolean;
  } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error(`${method} requires params object`);
    }
    const args = params as Record<string, unknown>;
    // Streaming gestures have no XCUITest equivalent, so the wire is Android-only. A client that
    // reaches here for iOS bypassed the tool-selection check; reject rather than silently degrade.
    if (args.platform !== "android") {
      throw new Error(`${method} is only supported on platform 'android'`);
    }
    if (typeof args.gestureId !== "string" || args.gestureId.length === 0) {
      throw new Error(`${method} requires a non-empty gestureId`);
    }
    const x = this.requireGestureCoordinate(args.x, method);
    const y = this.requireGestureCoordinate(args.y, method);
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error(`${method} deviceId must be a string when provided`);
    }
    if (args.cancel !== undefined && typeof args.cancel !== "boolean") {
      throw new Error(`${method} cancel must be a boolean when provided`);
    }
    return {
      platform: args.platform,
      deviceId: args.deviceId,
      gestureId: args.gestureId,
      x,
      y,
      cancel: args.cancel === true,
    };
  }

  private requireGestureCoordinate(value: unknown, method: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${method} requires numeric x and y params`);
    }
    return value;
  }

  private async handleInputTypeText(
    request: DaemonRequest,
    socketSessionId?: string,
  ): Promise<any | undefined> {
    const queueEnterMs = this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputTypeTextParams(request.params);
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      "input/typeText",
      args.append,
    );
    let confirmedAppendCharsSent: number | undefined;
    const inputResult = await this.runKeyedMcpForward(
      `device:${targetDevice.deviceId}`,
      async () => {
        // A same-serial emulator may reconnect while this request waits behind an
        // earlier input. Re-read its ADB transport inside the keyed callback so the
        // append-helper lookup cannot reuse a capability from that older instance.
        const executionTargetDevice =
          args.append && args.platform === "android"
            ? await this.resolveInputTargetDevice(
                args.platform,
                targetDevice.deviceId,
                socketSessionId,
                "input/typeText",
                true,
              )
            : targetDevice;
        this.requireCurrentFrameContext(targetDevice.deviceId, args.frameContext, "input/typeText");
        const queueWaitMs = this.timer.now() - queueEnterMs;
        const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
        if (remainingTimeoutMs <= 0) {
          throw new McpTimeoutError({
            toolName: request.method,
            timeoutMs: totalTimeoutMs,
            origin: "UnixSocketServer.handleInputTypeText",
            detail: `spent ${queueWaitMs}ms waiting in queue`,
          });
        }

        const imeAction: ImeAction | undefined = args.submit ? "done" : undefined;
        return await this.runInputOperationWithTimeout(
          request.method,
          totalTimeoutMs,
          remainingTimeoutMs,
          "UnixSocketServer.handleInputTypeText",
          () =>
            this.executeInputTypeText(
              args.platform,
              executionTargetDevice,
              args.text,
              imeAction,
              remainingTimeoutMs,
              args.append,
              args.frameContext,
              (charsSent) => {
                confirmedAppendCharsSent = charsSent;
              },
            ),
          (timeoutError) =>
            args.append && confirmedAppendCharsSent !== undefined
              ? new InputTypeTextAppendError(timeoutError.message, confirmedAppendCharsSent)
              : undefined,
        );
      },
      `device:${targetDevice.deviceId}`,
    );

    if (!inputResult.success) {
      if (args.append && inputResult.charsSent !== undefined) {
        throw new InputTypeTextAppendError(
          inputResult.error ?? `input/typeText failed on ${args.platform}`,
          inputResult.charsSent,
        );
      }
      throw new Error(inputResult.error ?? `input/typeText failed on ${args.platform}`);
    }

    return {
      action: "input/typeText",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      textLength: args.text.length,
      submitted: args.submit,
    };
  }

  private async handleInputPressButton(
    request: DaemonRequest,
    socketSessionId?: string,
  ): Promise<any | undefined> {
    const queueEnterMs = this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputPressButtonParams(request.params);
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      "input/pressButton",
    );
    const buttonResult = await this.runKeyedMcpForward(
      `device:${targetDevice.deviceId}`,
      async () => {
        this.requireCurrentFrameContext(
          targetDevice.deviceId,
          args.frameContext,
          "input/pressButton",
        );
        const queueWaitMs = this.timer.now() - queueEnterMs;
        const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
        if (remainingTimeoutMs <= 0) {
          throw new McpTimeoutError({
            toolName: request.method,
            timeoutMs: totalTimeoutMs,
            origin: "UnixSocketServer.handleInputPressButton",
            detail: `spent ${queueWaitMs}ms waiting in queue`,
          });
        }

        const pressButton = new PressButton(targetDevice);
        return args.frameContext === undefined
          ? await pressButton.press(args.button, remainingTimeoutMs)
          : await pressButton.press(args.button, remainingTimeoutMs, args.frameContext);
      },
      `device:${targetDevice.deviceId}`,
    );

    if (!buttonResult.success) {
      throw new Error(buttonResult.error ?? `input/pressButton failed on ${args.platform}`);
    }

    return {
      action: "input/pressButton",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      button: args.responseButton,
    };
  }

  private async handleInputKey(
    request: DaemonRequest,
    socketSessionId?: string,
  ): Promise<any | undefined> {
    const queueEnterMs = this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputKeyParams(request.params);
    if (args.platform === "ios") {
      throw new Error(INPUT_KEY_IOS_UNSUPPORTED_ERROR);
    }
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      "input/key",
    );
    const keyResult = await this.runKeyedMcpForward(
      `device:${targetDevice.deviceId}`,
      async () => {
        this.requireCurrentFrameContext(targetDevice.deviceId, args.frameContext, "input/key");
        const queueWaitMs = this.timer.now() - queueEnterMs;
        const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
        if (remainingTimeoutMs <= 0) {
          throw new McpTimeoutError({
            toolName: request.method,
            timeoutMs: totalTimeoutMs,
            origin: "UnixSocketServer.handleInputKey",
            detail: `spent ${queueWaitMs}ms waiting in queue`,
          });
        }

        const inputKey = new InputKey(targetDevice);
        return args.frameContext === undefined
          ? await inputKey.press(args.key, remainingTimeoutMs)
          : await inputKey.press(args.key, remainingTimeoutMs, args.frameContext);
      },
      `device:${targetDevice.deviceId}`,
    );

    if (!keyResult.success) {
      throw new Error(keyResult.error ?? `input/key failed on ${args.platform}`);
    }

    return {
      action: "input/key",
      platform: args.platform,
      deviceId: targetDevice.deviceId,
      success: true,
      key: args.key,
    };
  }

  private async executeInputTypeText(
    platform: "android" | "ios",
    targetDevice: BootedDevice,
    text: string,
    imeAction: ImeAction | undefined,
    timeoutMs: number,
    append: boolean = false,
    frameContext?: string,
    onConfirmedAppendCharsSent?: (charsSent: number) => void,
  ): Promise<{ success: boolean; error?: string; charsSent?: number }> {
    // Charge set-text and the optional submit/IME action against a single
    // shared budget. Otherwise submit:true would hand each request the full
    // timeout, letting the combined operation run up to 2x the caller's
    // budget while the per-device queue stays held until it settles.
    const deadline = this.timer.now() + timeoutMs;
    const client: DeviceService =
      platform === "android"
        ? AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory)
        : IOSCtrlProxyClient.getInstance(targetDevice);

    // Append emits real key events on Android. iOS invokes its focused-field insert
    // primitive, falling back on runners that predate that command to untargeted
    // requestSetText, which is the same XCUITest typeText-at-caret operation.
    //
    // The budget is threaded in for the same reason the replace path gets it: this
    // runs while the per-device queue is held, and the outer race only *reports* a
    // timeout — it still waits for the operation to settle before releasing the
    // queue. An unbounded adb subprocess here would therefore wedge every later
    // input for this device, not just this one request.
    let appendCharsSent: number | undefined;
    if (append && platform === "android") {
      const textResult = await this.executeAndroidAppendText(
        targetDevice,
        text,
        deadline,
        timeoutMs,
        frameContext,
        client as AndroidCtrlProxyClient,
      );
      if (textResult.charsSent !== undefined) {
        onConfirmedAppendCharsSent?.(textResult.charsSent);
      }
      if (!textResult.success) {
        return {
          success: false,
          error: textResult.error,
          ...(textResult.charsSent !== undefined ? { charsSent: textResult.charsSent } : {}),
        };
      }
      appendCharsSent = textResult.charsSent;
    } else {
      const textResult = append
        ? await (client as IOSCtrlProxyClient).requestAppendText(
            text,
            timeoutMs,
            undefined,
            frameContext,
          )
        : await client.requestSetText(text, { timeoutMs, frameContext });
      if (!textResult.success) {
        return { success: false, error: textResult.error };
      }
    }
    return await this.runImeActionWithinBudget(
      client,
      imeAction,
      deadline,
      timeoutMs,
      appendCharsSent,
    );
  }

  private async executeAndroidAppendText(
    targetDevice: BootedDevice,
    text: string,
    deadline: number,
    totalTimeoutMs: number,
    frameContext: string | undefined,
    client: AndroidCtrlProxyClient,
  ): Promise<{ success: boolean; error?: string; charsSent?: number }> {
    const appendTimeoutMs = deadline - this.timer.now();
    if (appendTimeoutMs <= 0) {
      return {
        success: false,
        error: `input/typeText exceeded ${totalTimeoutMs}ms budget before append key events`,
      };
    }
    return await this.getAppendTextInput(targetDevice).appendText(
      text,
      appendTimeoutMs,
      frameContext === undefined
        ? undefined
        : () => this.validateAppendFrameContext(client, frameContext, deadline, totalTimeoutMs),
    );
  }

  private async validateAppendFrameContext(
    client: AndroidCtrlProxyClient,
    frameContext: string,
    deadline: number,
    totalTimeoutMs: number,
  ): Promise<{ success: boolean; error?: string }> {
    const validationTimeoutMs = deadline - this.timer.now();
    if (validationTimeoutMs <= 0) {
      return {
        success: false,
        error: `input/typeText exceeded ${totalTimeoutMs}ms budget before append frame context validation`,
      };
    }
    const validation = await client.validateFrameContext(frameContext, validationTimeoutMs);
    return validation.success
      ? { success: true }
      : {
          success: false,
          error:
            validation.error ??
            "Frame context is stale or unavailable; observe a fresh frame before retrying",
        };
  }

  private async runImeActionWithinBudget(
    client: Pick<DeviceService, "requestImeAction">,
    imeAction: ImeAction | undefined,
    deadline: number,
    totalTimeoutMs: number,
    appendCharsSent?: number,
  ): Promise<{ success: boolean; error?: string; charsSent?: number }> {
    const withAppendProgress = (result: { success: boolean; error?: string }) =>
      appendCharsSent !== undefined ? { ...result, charsSent: appendCharsSent } : result;
    if (!imeAction) {
      return withAppendProgress({ success: true });
    }
    const remainingTimeoutMs = deadline - this.timer.now();
    if (remainingTimeoutMs <= 0) {
      // Defensive: in practice the outer Promise.race timeout fires first, so
      // this path is only reached if set-text spends the entire budget before
      // the submit action starts.
      return withAppendProgress({
        success: false,
        error: `input/typeText exceeded ${totalTimeoutMs}ms budget before submit`,
      });
    }
    try {
      return withAppendProgress(await client.requestImeAction(imeAction, remainingTimeoutMs));
    } catch (error) {
      if (appendCharsSent === undefined) {
        throw error;
      }
      return {
        success: false,
        error: errorMessage(error),
        charsSent: appendCharsSent,
      };
    }
  }

  private async runInputOperationWithTimeout<T>(
    toolName: string,
    totalTimeoutMs: number,
    remainingTimeoutMs: number,
    origin: string,
    operation: () => Promise<T>,
    timeoutError?: (timeout: McpTimeoutError) => Error | undefined,
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    let timedOut = false;
    const operationPromise = operation();
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = this.timer.setTimeout(() => {
        timedOut = true;
        resolve("timeout");
      }, remainingTimeoutMs);
    });

    try {
      const result = await Promise.race([operationPromise, timeout]);
      if (result !== "timeout") {
        return result;
      }

      const error = new McpTimeoutError({
        toolName,
        timeoutMs: totalTimeoutMs,
        origin,
        detail: `operation exceeded remaining budget ${remainingTimeoutMs}ms`,
      });
      throw timeoutError?.(error) ?? error;
    } finally {
      if (timeoutHandle) {
        this.timer.clearTimeout(timeoutHandle);
      }
      if (timedOut) {
        // Hold the per-device queue until the in-flight CtrlProxy request
        // settles so a following same-device input cannot interleave its text
        // write with this one. This defers delivery of the timeout error until
        // the operation ends; the wait normally tracks the caller's budget
        // (executeInputTypeText bounds set-text + IME to it) but can exceed it
        // if a CtrlProxy request ignores its own timeout or blocks in an
        // unbounded connect phase. This serialization-over-responsiveness
        // trade-off matches input/tap and input/swipe.
        await operationPromise.catch(() => undefined);
      }
    }
  }

  private parseInputTapParams(params: unknown): {
    platform: "android" | "ios";
    deviceId?: string;
    x: number;
    y: number;
    duration?: number;
    frameContext?: string;
  } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("input/tap requires params object");
    }

    const args = params as Record<string, unknown>;
    if (args.platform !== "android" && args.platform !== "ios") {
      throw new Error("input/tap requires platform 'android' or 'ios'");
    }
    // Reject NaN AND ±Infinity (finiteness), matching parseInputSwipeParams. Number.isNaN
    // alone lets ±Infinity through, violating the "numeric x and y" contract (#3615).
    if (
      typeof args.x !== "number" ||
      !Number.isFinite(args.x) ||
      typeof args.y !== "number" ||
      !Number.isFinite(args.y)
    ) {
      throw new Error("input/tap requires numeric x and y params");
    }
    if (
      args.duration !== undefined &&
      (typeof args.duration !== "number" || !Number.isFinite(args.duration))
    ) {
      throw new Error("input/tap duration must be numeric when provided");
    }
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error("input/tap deviceId must be a string when provided");
    }
    if (
      args.frameContext !== undefined &&
      (typeof args.frameContext !== "string" || args.frameContext.length === 0)
    ) {
      throw new Error("input/tap frameContext must be a non-empty string when provided");
    }

    return {
      platform: args.platform,
      deviceId: args.deviceId,
      x: args.x,
      y: args.y,
      duration: args.duration,
      frameContext: args.frameContext,
    };
  }

  private parseInputSwipeParams(params: unknown): {
    platform: "android" | "ios";
    deviceId?: string;
    startX: number;
    startY: number;
    endX: number;
    endY: number;
    durationMs: number;
    frameContext?: string;
  } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("input/swipe requires params object");
    }

    const args = params as Record<string, unknown>;
    if (args.platform !== "android" && args.platform !== "ios") {
      throw new Error("input/swipe requires platform 'android' or 'ios'");
    }
    if (
      typeof args.startX !== "number" ||
      !Number.isFinite(args.startX) ||
      typeof args.startY !== "number" ||
      !Number.isFinite(args.startY) ||
      typeof args.endX !== "number" ||
      !Number.isFinite(args.endX) ||
      typeof args.endY !== "number" ||
      !Number.isFinite(args.endY)
    ) {
      throw new Error("input/swipe requires numeric startX, startY, endX, and endY params");
    }
    if (
      args.durationMs !== undefined &&
      (typeof args.durationMs !== "number" ||
        !Number.isFinite(args.durationMs) ||
        args.durationMs < 1 ||
        args.durationMs > 60_000)
    ) {
      throw new Error("input/swipe durationMs must be between 1 and 60000 milliseconds");
    }
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error("input/swipe deviceId must be a string when provided");
    }
    if (
      args.frameContext !== undefined &&
      (typeof args.frameContext !== "string" || args.frameContext.length === 0)
    ) {
      throw new Error("input/swipe frameContext must be a non-empty string when provided");
    }

    return {
      platform: args.platform,
      deviceId: args.deviceId,
      startX: args.startX,
      startY: args.startY,
      endX: args.endX,
      endY: args.endY,
      durationMs: args.durationMs ?? 300,
      frameContext: args.frameContext,
    };
  }

  private parseInputTypeTextParams(params: unknown): {
    platform: "android" | "ios";
    deviceId?: string;
    text: string;
    submit: boolean;
    append: boolean;
    frameContext?: string;
  } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("input/typeText requires params object");
    }

    const args = params as Record<string, unknown>;
    const supportedParams = new Set([
      "platform",
      "deviceId",
      "text",
      "submit",
      "mode",
      "frameContext",
    ]);
    const unsupportedParams = Object.keys(args).filter((key) => !supportedParams.has(key));
    if (unsupportedParams.length > 0) {
      throw new Error(`input/typeText unsupported params: ${unsupportedParams.join(", ")}`);
    }
    if (args.platform !== "android" && args.platform !== "ios") {
      throw new Error("input/typeText requires platform 'android' or 'ios'");
    }
    if (typeof args.text !== "string" || args.text.length === 0) {
      throw new Error("input/typeText requires non-empty string text param");
    }
    if (args.submit !== undefined && typeof args.submit !== "boolean") {
      throw new Error("input/typeText submit must be a boolean when provided");
    }
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error("input/typeText deviceId must be a string when provided");
    }
    this.validateFrameContextParam(args.frameContext, "input/typeText");
    // "append" adds to the focused field instead of replacing it, which is what
    // an interactive client mirroring one keystroke at a time needs: the default
    // replace semantics would leave only the last character typed (#3351).
    if (args.mode !== undefined && args.mode !== "append") {
      throw new Error('input/typeText mode must be "append" when provided');
    }
    return {
      platform: args.platform,
      deviceId: args.deviceId,
      text: args.text,
      submit: args.submit ?? false,
      append: args.mode === "append",
      frameContext: args.frameContext as string | undefined,
    };
  }

  private parseInputPressButtonParams(params: unknown): {
    platform: "android" | "ios";
    deviceId?: string;
    button: string;
    responseButton: string;
    frameContext?: string;
  } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("input/pressButton requires params object");
    }

    const args = params as Record<string, unknown>;
    if (args.platform !== "android" && args.platform !== "ios") {
      throw new Error("input/pressButton requires platform 'android' or 'ios'");
    }
    if (typeof args.button !== "string") {
      throw new Error("input/pressButton requires button");
    }
    const supportedButtons = [
      "home",
      "back",
      "menu",
      "power",
      "volume_up",
      "volume_down",
      "recent",
      "app_switch",
    ];
    if (!supportedButtons.includes(args.button)) {
      throw new Error(`input/pressButton button must be one of: ${supportedButtons.join(", ")}`);
    }
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error("input/pressButton deviceId must be a string when provided");
    }
    this.validateFrameContextParam(args.frameContext, "input/pressButton");
    const button = args.button === "app_switch" ? "recent" : args.button;

    return {
      platform: args.platform,
      deviceId: args.deviceId,
      button,
      responseButton: args.button,
      frameContext: args.frameContext as string | undefined,
    };
  }

  private parseInputKeyParams(params: unknown): {
    platform: "android" | "ios";
    deviceId?: string;
    key: InputKeyName;
    frameContext?: string;
  } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("input/key requires params object");
    }

    const args = params as Record<string, unknown>;
    const supportedParams = new Set(["platform", "deviceId", "key", "frameContext"]);
    const unsupportedParams = Object.keys(args).filter((key) => !supportedParams.has(key));
    if (unsupportedParams.length > 0) {
      throw new Error(`input/key unsupported params: ${unsupportedParams.join(", ")}`);
    }
    if (args.platform !== "android" && args.platform !== "ios") {
      throw new Error("input/key requires platform 'android' or 'ios'");
    }
    if (typeof args.key !== "string") {
      throw new Error("input/key requires key");
    }
    if (!isInputKeyName(args.key)) {
      throw new Error(`input/key key must be one of: ${SUPPORTED_INPUT_KEYS.join(", ")}`);
    }
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error("input/key deviceId must be a string when provided");
    }
    this.validateFrameContextParam(args.frameContext, "input/key");

    return {
      platform: args.platform,
      deviceId: args.deviceId,
      key: args.key,
      frameContext: args.frameContext as string | undefined,
    };
  }

  private validateFrameContextParam(frameContext: unknown, action: string): void {
    if (
      frameContext !== undefined &&
      (typeof frameContext !== "string" || frameContext.length === 0)
    ) {
      throw new Error(`${action} frameContext must be a non-empty string when provided`);
    }
  }

  /**
   * Input that carries a device-authored context is safe only if the newest observation from that
   * device still reports that exact context. Missing context fails closed: a caller can re-observe
   * and retry, whereas executing against an unproven screen could actuate the wrong UI.
   */
  private requireCurrentFrameContext(
    deviceId: string,
    frameContext: string | undefined,
    action: string,
  ): void {
    if (frameContext === undefined) {
      return;
    }
    const current = getDeviceDataStreamServer()?.getCurrentFrameContext(deviceId);
    if (current !== frameContext) {
      throw new Error(
        `${action} frameContext is stale or unavailable; observe a fresh frame before retrying`,
      );
    }
  }

  private async resolveInputTargetDevice(
    platform: "android" | "ios",
    deviceId: string | undefined,
    socketSessionId: string | undefined,
    action:
      | "input/tap"
      | "input/swipe"
      | "input/typeText"
      | "input/pressButton"
      | "input/key"
      | "input/gestureStart"
      | "input/gestureMove"
      | "input/gestureEnd",
    bypassAndroidDeviceListCache: boolean = false,
  ): Promise<BootedDevice> {
    const bootedDevices = await this.discoverInputTargetDevices(
      platform,
      action,
      bypassAndroidDeviceListCache,
    );
    if (deviceId) {
      const targetDevice = bootedDevices.find((device) => device.deviceId === deviceId);
      if (!targetDevice) {
        throw new Error(`Device not found: ${deviceId}`);
      }
      return targetDevice;
    }

    const autolockSessionId = this.daemonState.isInitialized()
      ? this.daemonState
          .getDevicePool()
          .resolveAutolockSessionForMcpSession?.(socketSessionId, platform)
      : undefined;
    const autolockDeviceId = autolockSessionId
      ? this.daemonState.getSessionManager().getSession(autolockSessionId)?.assignedDevice
      : undefined;
    if (autolockDeviceId) {
      const targetDevice = bootedDevices.find((device) => device.deviceId === autolockDeviceId);
      if (!targetDevice) {
        throw new Error(`Device not found: ${autolockDeviceId}`);
      }
      return targetDevice;
    }

    if (bootedDevices.length === 1) {
      return bootedDevices[0];
    }
    if (bootedDevices.length === 0) {
      throw new Error(`No booted ${platform} devices found for ${action}`);
    }
    throw new Error(`${action} requires deviceId when multiple ${platform} devices are booted`);
  }

  private async discoverInputTargetDevices(
    platform: "android" | "ios",
    action:
      | "input/tap"
      | "input/swipe"
      | "input/typeText"
      | "input/pressButton"
      | "input/key"
      | "input/gestureStart"
      | "input/gestureMove"
      | "input/gestureEnd",
    bypassAndroidDeviceListCache: boolean,
  ): Promise<BootedDevice[]> {
    const discovery = await PlatformDeviceManagerFactory.getInstance().getBootedDevicesDetailed(
      platform,
      {
        bypassAndroidDeviceListCache,
      },
    );
    if (!discovery.succeededPlatforms.has(platform)) {
      throw new Error(`Unable to discover booted ${platform} devices for ${action}`);
    }
    return discovery.devices;
  }

  private async handleIdeRequest(
    mcpClient: Client,
    request: DaemonRequest,
    timeoutMs: number,
    socketSessionId: string,
  ): Promise<any> {
    const requestOptions = { timeout: timeoutMs };

    switch (request.method) {
      case "tools/list": {
        return await mcpClient.listTools();
      }
      case "tools/call": {
        return await mcpClient.callTool(
          {
            name: request.params.name,
            arguments: this.withSocketSessionAutolockKey(request.params.arguments, socketSessionId),
          },
          undefined,
          requestOptions,
        );
      }
      case "resources/list": {
        return await mcpClient.listResources();
      }
      case "resources/read": {
        if (!request.params?.uri) {
          throw new Error("resources/read requires params.uri");
        }
        return await mcpClient.readResource({ uri: request.params.uri }, undefined, requestOptions);
      }
      case "resources/list-templates": {
        return await mcpClient.listResourceTemplates();
      }
      case "ide/getNavigationGraph": {
        const args = request.params ?? {};
        return await mcpClient.callTool(
          { name: "getNavigationGraph", arguments: args },
          undefined,
          requestOptions,
        );
      }
      default:
        throw new Error(`Unsupported daemon method: ${request.method}`);
    }
  }

  private withSocketSessionAutolockKey(args: unknown, socketSessionId: string): unknown {
    if (args === null || args === undefined) {
      return {
        __mcpSessionId: socketSessionId,
      };
    }

    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return args;
    }

    const forwardedArgs = { ...args } as Record<string, unknown>;
    delete forwardedArgs[DAEMON_TOOL_SELECTION_PROFILE_PARAM];
    this.throwIfReleasedBoundSession(forwardedArgs);
    const boundSessionUuid = this.getSessionUuid(forwardedArgs);
    const usesBoundSession = forwardedArgs[DAEMON_BOUND_SESSION_PARAM] === boundSessionUuid;
    delete forwardedArgs[DAEMON_BOUND_SESSION_PARAM];
    // Connection-bound sessions are carried by the loopback transport header.
    // Never let a stale injected UUID reach ToolExecutionContext, whose legacy
    // explicit-session contract would otherwise create a replacement session.
    if (usesBoundSession) {
      delete forwardedArgs.sessionUuid;
    }
    return {
      ...forwardedArgs,
      __mcpSessionId: socketSessionId,
    };
  }

  /**
   * Create an MCP client connected to the HTTP server
   */
  private async createMcpClient(
    boundSessionUuid?: string,
    toolSelectionProfileUuid?: string,
  ): Promise<Client> {
    logger.info(`Creating MCP client with endpoint: "${this.mcpEndpoint}"`);
    if (!this.mcpEndpoint) {
      logger.error(`ERROR: mcpEndpoint is empty or undefined when creating client!`);
      throw new Error("mcpEndpoint is not set");
    }
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpEndpoint), {
      reconnectionOptions: DAEMON_LOOPBACK_STREAMABLE_HTTP_RECONNECTION,
      ...(boundSessionUuid || toolSelectionProfileUuid
        ? {
            requestInit: {
              headers: {
                ...(boundSessionUuid
                  ? { [DAEMON_SESSION_TOOL_BINDING_HEADER]: boundSessionUuid }
                  : {}),
                ...(toolSelectionProfileUuid
                  ? { [DAEMON_TOOL_SELECTION_PROFILE_HEADER]: toolSelectionProfileUuid }
                  : {}),
              },
            },
          }
        : {}),
    });

    const client = new Client(
      {
        name: "auto-mobile-daemon-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    await client.connect(transport);
    logger.info(`MCP client connected to ${this.mcpEndpoint}`);

    return client;
  }

  /**
   * Get or create the MCP client for a target key.
   */
  private async getMcpClient(
    key: string,
    boundSessionUuid?: string,
    toolSelectionProfileUuid?: string,
  ): Promise<Client> {
    this.clearMcpClientIdleTimer(key);

    const existingClient = this.mcpClients.get(key);
    if (existingClient) {
      return existingClient;
    }

    const existingPromise = this.mcpClientPromises.get(key);
    if (existingPromise) {
      return existingPromise;
    }

    const generation = this.lifecycleGeneration;
    const clientPromise = this.mcpClientFactory(boundSessionUuid, toolSelectionProfileUuid)
      .then(async (client) => {
        if (this.closing || generation !== this.lifecycleGeneration) {
          await client.close();
          throw new Error("Unix socket server is closing");
        }
        this.mcpClients.set(key, client);
        if (this.mcpClientPromises.get(key) === clientPromise) {
          this.mcpClientPromises.delete(key);
        }
        return client;
      })
      .catch((error) => {
        if (this.mcpClientPromises.get(key) === clientPromise) {
          this.mcpClientPromises.delete(key);
        }
        throw error;
      });

    this.mcpClientPromises.set(key, clientPromise);
    return clientPromise;
  }

  private async resetMcpClient(key: string): Promise<void> {
    this.clearMcpClientIdleTimer(key);
    const existingClient = this.mcpClients.get(key);
    this.mcpClients.delete(key);
    this.mcpClientPromises.delete(key);
    if (!existingClient) {
      return;
    }
    try {
      await existingClient.close();
    } catch (error) {
      logger.warn(`Error closing MCP client for key ${key}:`, error);
    }
  }

  private scheduleMcpClientIdleClose(key: string): void {
    this.clearMcpClientIdleTimer(key);
    const timer = this.timer.setTimeout(() => {
      void this.closeIdleMcpClient(key);
    }, MCP_CLIENT_IDLE_CLOSE_MS);
    this.mcpClientIdleTimers.set(key, timer);
  }

  private clearMcpClientIdleTimer(key: string): void {
    const timer = this.mcpClientIdleTimers.get(key);
    if (!timer) {
      return;
    }
    this.timer.clearTimeout(timer);
    this.mcpClientIdleTimers.delete(key);
  }

  private async closeIdleMcpClient(key: string): Promise<void> {
    this.mcpClientIdleTimers.delete(key);
    if (
      this.mcpForwardTails.has(key) ||
      this.activeMcpClientForwardCounts.has(key) ||
      this.isMcpClientKeyBound(key)
    ) {
      return;
    }
    // The append helper shares the device's idle lifecycle: once nothing has
    // used this device key for the idle window, drop the cached InputText so
    // its API-level cache cannot go stale across a device swap under the same id.
    const devicePrefix = "device:";
    if (key.startsWith(devicePrefix)) {
      this.appendTextInputs.delete(key.slice(devicePrefix.length));
    }
    await this.resetMcpClient(key);
  }

  /**
   * Drop the cached append helper after a device lifecycle change (issue #3351).
   *
   * The cache is keyed by deviceId and otherwise lives until the 5-minute idle
   * close. If an emulator is replaced under a reused serial (`emulator-5554`)
   * before then, the next device would inherit the previous one's cached API-level
   * capability — an API 31+ / pre-31 mismatch that mis-handles SHIFT and uppercase.
   * The device pool calls this after it adds a device, rediscovers it during a
   * refresh, or binds it after startDevice. Direct socket discovery also rebuilds
   * a helper when ADB reports a changed transport id for the same serial. The
   * confirmed-disconnect monitor remains a backstop.
   * Idempotent; safe for an unknown id.
   */
  evictDeviceInputCache(deviceId: string): void {
    if (this.appendTextInputs.delete(deviceId)) {
      logger.debug(`[UnixSocketServer] Evicted cached append helper for device ${deviceId}`);
    }
  }

  /** Cached-per-device accessor for the append helper; see {@link appendTextInputs}. */
  private getAppendTextInput(device: BootedDevice): AppendTextInput {
    const existing = this.appendTextInputs.get(device.deviceId);
    if (existing?.transportId !== undefined && device.transportId === existing.transportId) {
      return existing.input;
    }
    if (existing) {
      logger.debug(
        `[UnixSocketServer] Rebuilding cached append helper for ${device.deviceId}: ` +
          `ADB transport changed from ${existing.transportId} to ${device.transportId}`,
      );
    }
    const created = this.appendTextFactory(device);
    this.appendTextInputs.set(device.deviceId, { input: created, transportId: device.transportId });
    return created;
  }

  /**
   * Enqueue a request in the session to maintain sequential order
   */
  private async enqueueRequest<T>(session: SessionContext, handler: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      session.requestQueue.push(async () => {
        try {
          const result = await handler();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      // Process queue if not already processing
      if (!session.processing) {
        this.processQueue(session);
      }
    });
  }

  /**
   * Process queued requests sequentially
   */
  private async processQueue(session: SessionContext): Promise<void> {
    if (session.processing || session.requestQueue.length === 0) {
      return;
    }

    session.processing = true;

    while (session.requestQueue.length > 0) {
      const handler = session.requestQueue.shift()!;
      try {
        await handler();
      } catch (error) {
        logger.error(`Error processing queued request:`, error);
      }
    }

    session.processing = false;
  }

  /**
   * Check if socket server is listening
   */
  isListening(): boolean {
    return this.server !== null && this.server.listening;
  }

  /**
   * Stop the Unix socket server
   */
  async close(): Promise<void> {
    logger.info("Closing Unix socket server...");
    this.closing = true;
    this.lifecycleGeneration += 1;

    // Stop receiving list-changed events (mirrors the subscribe in start()).
    this.listChangedUnsubscribe?.();
    this.listChangedUnsubscribe = null;

    // Stop receiving session-release events (mirrors the subscribe in start()).
    this.sessionReleaseUnsubscribe?.();
    this.sessionReleaseUnsubscribe = null;

    // Close MCP clients
    const clients = Array.from(this.mcpClients.entries());
    this.mcpClients.clear();
    this.mcpClientPromises.clear();
    this.boundMcpClientKeysBySocketSession.clear();
    for (const timer of this.mcpClientIdleTimers.values()) {
      this.timer.clearTimeout(timer);
    }
    this.mcpClientIdleTimers.clear();
    for (const [key, client] of clients) {
      try {
        await client.close();
      } catch (error) {
        logger.warn(`Error closing MCP client for key ${key}:`, error);
      }
    }
    this.mcpForwardTails.clear();
    this.mcpForwardIdleCloseKeys.clear();
    this.appendTextInputs.clear();

    // Capture clients before clearing their session bookkeeping. server.close() stops
    // accepting new connections, but waits for existing ones; destroy them before
    // awaiting its callback so daemon shutdown cannot hang on an idle client.
    const clientSockets = Array.from(this.clientSockets.values());

    // Clear sessions
    this.sessions.clear();
    this.clientSockets.clear();
    this.notificationSubscribers.clear();

    const ownsSocketPath = this.isOwnedSocketFile();
    const serverClosed = this.closeListeningServer(ownsSocketPath);
    const requestHandlersDrained = this.drainActiveRequestHandlers();

    this.destroyClientSockets(clientSockets);
    await serverClosed;
    await requestHandlersDrained;
    this.server = null;

    // The listener removes the socket it created as part of close(). Do not
    // unlink the pathname afterward: a successor can bind in the interval and
    // filesystems are allowed to reuse the original socket inode immediately.
    this.socketFileIdentity = null;
  }

  private closeListeningServer(ownsSocketPath: boolean): Promise<void> {
    if (!this.server) {
      return Promise.resolve();
    }
    if (!ownsSocketPath && existsSync(this.socketPath)) {
      logger.warn(
        `Unix socket path ${this.socketPath} no longer belongs to this server; leaving listener for process teardown`,
      );
      this.server.unref();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.server!.close(() => {
        logger.info("Unix socket server closed");
        resolve();
      });
    });
  }

  private destroyClientSockets(clientSockets: Socket[]): void {
    for (const socket of clientSockets) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  }

  private async drainActiveRequestHandlers(): Promise<void> {
    const handlers = Array.from(this.activeRequestHandlers);
    if (handlers.length === 0) {
      return;
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timeoutHandle = this.timer.setTimeout(
        () => resolve(false),
        DAEMON_REQUEST_HANDLER_DRAIN_TIMEOUT_MS,
      );
    });

    try {
      const drained = await Promise.race([Promise.allSettled(handlers).then(() => true), timeout]);
      if (!drained) {
        logger.warn(
          `Timed out waiting for ${handlers.length} in-flight Unix socket request handler(s) to finish during shutdown`,
        );
      }
    } finally {
      if (timeoutHandle !== undefined) {
        this.timer.clearTimeout(timeoutHandle);
      }
    }
  }

  private readSocketFileIdentity(): SocketFileIdentity | null {
    try {
      const stats = statSync(this.socketPath);
      return { dev: stats.dev, ino: stats.ino };
    } catch (error) {
      // statSync fails if the socket file was removed/replaced concurrently; callers
      // treat a null identity as "can't confirm ownership" rather than a hard error.
      logger.debug(`src/daemon/socketServer.ts fallback failed: ${error}`, error);
      return null;
    }
  }

  private isOwnedSocketFile(): boolean {
    if (!this.socketFileIdentity || !existsSync(this.socketPath)) {
      return false;
    }
    const currentIdentity = this.readSocketFileIdentity();
    return (
      currentIdentity?.dev === this.socketFileIdentity.dev &&
      currentIdentity.ino === this.socketFileIdentity.ino
    );
  }
}
