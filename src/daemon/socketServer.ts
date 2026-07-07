import { createServer, Server as NetServer, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPReconnectionOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../utils/logger";
import { resolveMcpRequestTimeoutMs, MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS } from "./mcpRequestTimeout";
import { McpTimeoutError } from "./McpTimeoutError";
import {
  DaemonNotification,
  DaemonRequest,
  DaemonResponse,
  SessionContext,
} from "./types";
import {
  SOCKET_PATH,
  DAEMON_HANDSHAKE_ENABLED,
  DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
  DAEMON_VERSION,
} from "./constants";
import {
  ListChangedBroadcaster,
  LIST_CHANGED_NOTIFICATION_METHODS,
  type ListChangedKind,
} from "../server/listChangedBroadcast";
import {
  evaluateClientHandshake,
  extractClientHandshake,
  type DaemonSelfIdentity,
} from "./daemonHandshake";
import { getCurrentBuildIdentity } from "./buildIdentity";
import { DaemonState } from "./daemonState";
import { DaemonStateAccess, handleDaemonRequest } from "./daemonRequestHandlers";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import type { FeatureFlagService } from "../features/featureFlags/FeatureFlagService";
import type { FeatureFlagKey } from "../features/featureFlags/FeatureFlagDefinitions";
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
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { KeyValueType } from "../features/storage/storageTypes";
import type { BootedDevice } from "../models";
/** Must exceed the longest per-request MCP timeout (executePlan = 10 min), else long tool calls get killed mid-flight. */
const DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS = MIN_EXECUTE_PLAN_MCP_TIMEOUT_MS + 5 * 60 * 1000;
const MCP_CLIENT_IDLE_CLOSE_MS = 5 * 60 * 1000;

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

export class UnixSocketServer {
  private server: NetServer | null = null;
  private socketFileIdentity: SocketFileIdentity | null = null;
  private sessions: Map<string, SessionContext> = new Map();
  /** Live client sockets by session ID, for server-pushed notification frames (issue #3223). */
  private clientSockets: Map<string, Socket> = new Map();
  /** Socket sessions that opted in to server-pushed notifications. */
  private notificationSubscribers: Set<string> = new Set();
  private listChangedUnsubscribe: (() => void) | null = null;
  private socketPath: string;
  private mcpEndpoint: string;
  private daemonState: DaemonStateAccess;
  private mcpClients: Map<string, Client> = new Map();
  private mcpClientPromises: Map<string, Promise<Client>> = new Map();
  /** Promise tails that serialize MCP HTTP forwards only within the same target key. */
  private mcpForwardTails: Map<string, Promise<void>> = new Map();
  private mcpClientIdleTimers: Map<string, NodeJS.Timeout> = new Map();
  private timer: Timer;
  private featureFlagService: FeatureFlagService | null;
  private readonly handshakeEnforced: boolean;
  private readonly daemonIdentity: DaemonSelfIdentity;

  constructor(
    socketPath: string = SOCKET_PATH,
    mcpEndpoint: string,
    daemonState: DaemonStateAccess = DaemonState.getInstance(),
    timer: Timer = defaultTimer,
    featureFlagService: FeatureFlagService | null = null,
    handshakeConfig: { identity?: DaemonSelfIdentity; enforce?: boolean } = {}
  ) {
    this.socketPath = socketPath;
    this.mcpEndpoint = mcpEndpoint;
    this.daemonState = daemonState;
    this.timer = timer;
    this.featureFlagService = featureFlagService;
    this.handshakeEnforced = handshakeConfig.enforce ?? DAEMON_HANDSHAKE_ENABLED;
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
    // Remove existing socket file if it exists
    if (existsSync(this.socketPath)) {
      await unlink(this.socketPath);
    }

    this.server = createServer(socket => {
      this.handleConnection(socket);
    });

    // Fan list-changed events out to subscribed socket clients (issue #3223).
    // Subscribed here (not in the daemon) so a socket-server recreation during
    // recovery re-wires itself; close() unsubscribes symmetrically.
    this.listChangedUnsubscribe?.();
    this.listChangedUnsubscribe = ListChangedBroadcaster.subscribe(kind => {
      this.broadcastListChanged(kind);
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.socketPath, () => {
        this.socketFileIdentity = this.readSocketFileIdentity();
        logger.info(`Unix socket server listening on ${this.socketPath}`);
        resolve();
      });

      this.server!.on("error", error => {
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
        `Daemon RPC socket ${sessionId} idle timeout after ${DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS}ms, destroying`
      );
      socket.destroy();
    });

    socket.on("data", async data => {
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
            error: error instanceof Error ? error.message : String(error),
          };
          this.writeFrame(socket, sessionId, errorResponse);
        }
      }
    });

    socket.on("close", () => {
      logger.info(`Client disconnected: ${sessionId}`);
      this.sessions.delete(sessionId);
      this.clientSockets.delete(sessionId);
      this.notificationSubscribers.delete(sessionId);
    });

    socket.on("error", error => {
      logger.error(`Socket error for ${sessionId}:`, error);
      this.sessions.delete(sessionId);
      this.clientSockets.delete(sessionId);
      this.notificationSubscribers.delete(sessionId);
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
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

  private writeFrame(socket: Socket, sessionId: string, frame: DaemonResponse | DaemonNotification): void {
    if (socket.destroyed) {
      return;
    }
    try {
      const ok = socket.write(JSON.stringify(frame) + "\n");
      if (!ok) {
        logger.debug(
          `Daemon RPC socket ${sessionId} backpressured; awaiting drain (idle timeout still armed)`
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
  private async handleRequest(
    sessionId: string,
    request: DaemonRequest
  ): Promise<DaemonResponse> {
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
        const initialForwardKey = this.getMcpForwardKey(request, sessionId);

        const result = await this.runMcpForwardForCurrentKey(initialForwardKey, request, sessionId, async forwardKey => {
          const queueWaitMs = this.timer.now() - queueEnterMs;
          const remainingTimeoutMs = totalTimeoutMs - queueWaitMs;
          const forwardLabel = UnixSocketServer.describeMcpForwardRequest(request);
          logger.debug(
            `[McpForward] start key=${forwardKey} socketSession=${sessionId} requestId=${request.id} ${forwardLabel} queueWaitMs=${queueWaitMs} remainingTimeoutMs=${remainingTimeoutMs}`
          );

          if (remainingTimeoutMs <= 0) {
            const toolName = request.method === "tools/call" ? request.params?.name ?? request.method : request.method;
            throw new McpTimeoutError({
              toolName,
              timeoutMs: totalTimeoutMs,
              origin: "UnixSocketServer.handleRequest",
              detail: `spent ${queueWaitMs}ms waiting in queue`,
            });
          }

          const forwardStartMs = this.timer.now();
          try {
            const mcpClient = await this.getMcpClient(forwardKey);

            try {
              return await this.handleIdeRequest(mcpClient, request, remainingTimeoutMs, sessionId);
            } catch (ideError) {
              const ideErrorMessage = ideError instanceof Error ? ideError.message : String(ideError);
              if (ideErrorMessage.includes("Session not found")) {
                logger.warn("MCP client session expired, reconnecting and retrying...");
                await this.resetMcpClient(forwardKey);
                const freshClient = await this.getMcpClient(forwardKey);
                const retryRemainingMs = remainingTimeoutMs - (this.timer.now() - forwardStartMs);
                if (retryRemainingMs <= 0) {
                  const toolName = request.method === "tools/call" ? request.params?.name ?? request.method : request.method;
                  throw new McpTimeoutError({
                    toolName,
                    timeoutMs: remainingTimeoutMs,
                    origin: "UnixSocketServer.handleRequest",
                    detail: `no budget remaining after session reconnect (elapsed ${this.timer.now() - forwardStartMs}ms)`,
                  });
                }
                return await this.handleIdeRequest(freshClient, request, retryRemainingMs, sessionId);
              }
              throw ideError;
            }
          } finally {
            logger.debug(
              `[McpForward] end key=${forwardKey} socketSession=${sessionId} requestId=${request.id} ${forwardLabel} forwardMs=${this.timer.now() - forwardStartMs}`
            );
          }
        });

        return {
          id: request.id,
          type: "mcp_response",
          success: true,
          result,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : "no stack";
        logger.error(`Error forwarding request to MCP server: ${errorMessage}`);
        logger.error(`Error stack: ${errorStack}`);
        logger.error(`Full error: ${JSON.stringify(error)}`);
        return {
          id: request.id,
          type: "mcp_response",
          success: false,
          error: errorMessage,
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
    const evaluation = evaluateClientHandshake(this.daemonIdentity, extractClientHandshake(request));
    if (evaluation.ok) {
      return null;
    }
    logger.warn(
      `Rejecting daemon client on handshake ${evaluation.reason} mismatch: ${evaluation.message}`
    );
    return {
      id: request.id,
      type: "mcp_response",
      success: false,
      error: evaluation.message,
    };
  }

  /**
   * Run one MCP forward at a time for a single target key. Each key owns a separate MCP client,
   * so calls for different devices or sessions can proceed concurrently without sharing one
   * Streamable HTTP session.
   */
  private runKeyedMcpForward<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mcpForwardTails.get(key) ?? Promise.resolve();
    const run = previous.then(() => {
      this.clearMcpClientIdleTimer(key);
      return fn();
    });
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.mcpForwardTails.set(key, tail);
    void tail.finally(() => {
      if (this.mcpForwardTails.get(key) === tail) {
        this.mcpForwardTails.delete(key);
        this.scheduleMcpClientIdleClose(key);
      }
    });
    return run;
  }

  private runMcpForwardForCurrentKey<T>(
    initialKey: string,
    request: DaemonRequest,
    socketSessionId: string,
    fn: (forwardKey: string) => Promise<T>
  ): Promise<T> {
    return this.runKeyedMcpForward(initialKey, async () => {
      const currentKey = this.getMcpForwardKey(request, socketSessionId);
      if (currentKey !== initialKey) {
        logger.debug(
          `[McpForward] rekey requestId=${request.id} initialKey=${initialKey} currentKey=${currentKey}`
        );
        return await this.runMcpForwardForCurrentKey(currentKey, request, socketSessionId, fn);
      }
      return await fn(currentKey);
    });
  }

  private getMcpForwardKey(request: DaemonRequest, socketSessionId: string): string {
    if (request.method === "tools/call") {
      const args = request.params?.arguments;
      const scopedKey = this.getRequestArgumentScopeKey(args);
      if (scopedKey) {
        return scopedKey;
      }

      const implicitAutolockKey = this.getImplicitAutolockScopeKey(socketSessionId, args);
      if (implicitAutolockKey) {
        return implicitAutolockKey;
      }

      // The daemon injects __mcpSessionId before forwarding. Use the socket session as the
      // pre-forward key so separate daemon clients can autolock and run independently.
      return `socket:${socketSessionId}`;
    }

    if (request.method === "ide/getNavigationGraph") {
      return this.getRequestArgumentScopeKey(request.params) ?? `method:${request.method}`;
    }

    if (request.method === "resources/read") {
      const uri = request.params?.uri;
      return typeof uri === "string" ? `resource:${uri}` : "resource:unknown";
    }

    return `method:${request.method}`;
  }

  private getRequestArgumentScopeKey(args: unknown): string | undefined {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return undefined;
    }

    const record = args as Record<string, unknown>;
    const hasSessionUuid = typeof record.sessionUuid === "string" && record.sessionUuid.length > 0;
    const hasDeviceLabel = typeof record.device === "string" && record.device.length > 0;

    // Precedence (pinned by #2565 review): a device label resolves the mapped session before
    // an explicit deviceId, which in turn beats a raw session, which beats implicit autolock.
    if (hasSessionUuid && hasDeviceLabel) {
      return this.sessionToScopeKey(this.resolveDeviceLabelSession(record.sessionUuid as string, record.device));
    }
    // An explicit target device must serialize by physical device even when a session is present.
    if (typeof record.deviceId === "string" && record.deviceId.length > 0) {
      return `device:${record.deviceId}`;
    }
    if (hasSessionUuid) {
      return this.sessionToScopeKey(record.sessionUuid as string);
    }
    if (typeof record.__mcpSessionId === "string" && record.__mcpSessionId.length > 0) {
      return this.getImplicitAutolockScopeKey(record.__mcpSessionId, args) ?? `mcp-session:${record.__mcpSessionId}`;
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
    if (typeof deviceLabel !== "string" || deviceLabel.length === 0 || !this.daemonState.isInitialized()) {
      return baseSessionUuid;
    }
    try {
      const labelMap = this.daemonState
        .getSessionManager()
        .getDeviceLabels(baseSessionUuid);
      if (!labelMap) {
        return baseSessionUuid;
      }
      const mappedSession = labelMap[deviceLabel];
      return typeof mappedSession === "string" && mappedSession.length > 0
        ? mappedSession
        : baseSessionUuid;
    } catch (error) {
      logger.debug(`Unable to resolve device label ${deviceLabel} for session ${baseSessionUuid}: ${error}`);
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
    socketSessionId?: string
  ): Promise<any | undefined> {
    if (request.method === "input/tap") {
      return await this.handleInputTap(request, socketSessionId);
    }
    if (request.method === "input/swipe") {
      return await this.handleInputSwipe(request, socketSessionId);
    }
    if (request.method === "input/pressButton") {
      return await this.handleInputPressButton(request, socketSessionId);
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
        const args = request.params as { key?: string; enabled?: boolean; config?: Record<string, unknown> | null };
        if (!args.key || typeof args.enabled !== "boolean") {
          throw new Error("setFeatureFlag requires 'key' (string) and 'enabled' (boolean) params");
        }
        const updated = await this.featureFlagService.setFlag(
          args.key as FeatureFlagKey,
          args.enabled,
          args.config
        );
        return updated;
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
          throw new Error("updateService requires 'deviceId' (string) and 'platform' (string) params");
        }
        if (args.platform !== "android" && args.platform !== "ios") {
          throw new Error(`Invalid platform: ${args.platform}. Must be 'android' or 'ios'.`);
        }

        // Find the booted device
        const bootedDevices = await PlatformDeviceManagerFactory.getInstance().getBootedDevices(args.platform);
        const targetDevice = bootedDevices.find(d => d.deviceId === args.deviceId);
        if (!targetDevice) {
          throw new Error(`Device not found: ${args.deviceId}`);
        }

        if (args.platform === "android") {
          const manager = AndroidCtrlProxyManager.getInstance(targetDevice);
          const result = await manager.ensureCompatibleVersion({
            allowDownloadWhenInstalled: true,
            bypassVersionCheckCache: true
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
        const bootedDevices = await PlatformDeviceManagerFactory.getInstance().getBootedDevices("android");
        const targetDevice = bootedDevices.find(d => d.deviceId === args.deviceId);
        if (!targetDevice) {
          throw new Error(`Device not found: ${args.deviceId}`);
        }
        const client = AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
        if (args.value === null || args.value === undefined) {
          await client.removePreference(args.appId, args.fileName, args.key);
        } else {
          await client.setPreference(
            args.appId,
            args.fileName,
            args.key,
            args.value,
            args.type as KeyValueType
          );
        }
        return { success: true };
      }
      case "ide/removeKeyValue": {
        const args = request.params as {
          deviceId?: string;
          appId?: string;
          fileName?: string;
          key?: string;
        };
        if (!args.deviceId || !args.appId || !args.fileName || !args.key) {
          throw new Error("removeKeyValue requires deviceId, appId, fileName, and key params");
        }
        const bootedDevices = await PlatformDeviceManagerFactory.getInstance().getBootedDevices("android");
        const targetDevice = bootedDevices.find(d => d.deviceId === args.deviceId);
        if (!targetDevice) {
          throw new Error(`Device not found: ${args.deviceId}`);
        }
        const client = AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
        await client.removePreference(args.appId, args.fileName, args.key);
        return { success: true };
      }
      case "ide/clearKeyValueFile": {
        const args = request.params as {
          deviceId?: string;
          appId?: string;
          fileName?: string;
        };
        if (!args.deviceId || !args.appId || !args.fileName) {
          throw new Error("clearKeyValueFile requires deviceId, appId, and fileName params");
        }
        const bootedDevices = await PlatformDeviceManagerFactory.getInstance().getBootedDevices("android");
        const targetDevice = bootedDevices.find(d => d.deviceId === args.deviceId);
        if (!targetDevice) {
          throw new Error(`Device not found: ${args.deviceId}`);
        }
        const client = AndroidCtrlProxyClient.getInstance(targetDevice, defaultAdbClientFactory);
        await client.clearPreferenceStore(args.appId, args.fileName);
        return { success: true };
      }
      default:
        return undefined;
    }
  }

  private async handleInputTap(
    request: DaemonRequest,
    socketSessionId?: string
  ): Promise<any | undefined> {
    const queueEnterMs = this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputTapParams(request.params);
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      "input/tap"
    );
    const gestureResult = await this.runKeyedMcpForward(`device:${targetDevice.deviceId}`, async () => {
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

      return args.platform === "android"
        ? await AndroidCtrlProxyClient
          .getInstance(targetDevice, defaultAdbClientFactory)
          .requestTapCoordinates(args.x, args.y, args.duration, remainingTimeoutMs)
        : await IOSCtrlProxyClient
          .getInstance(targetDevice)
          .requestTapCoordinates(args.x, args.y, args.duration, remainingTimeoutMs);
    });

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
    socketSessionId?: string
  ): Promise<any | undefined> {
    const queueEnterMs = this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputSwipeParams(request.params);
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      "input/swipe"
    );
    const gestureResult = await this.runKeyedMcpForward(`device:${targetDevice.deviceId}`, async () => {
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

      return args.platform === "android"
        ? await AndroidCtrlProxyClient
          .getInstance(targetDevice, defaultAdbClientFactory)
          .requestSwipe(args.startX, args.startY, args.endX, args.endY, args.durationMs, remainingTimeoutMs)
        : await IOSCtrlProxyClient
          .getInstance(targetDevice)
          .requestDrag(args.startX, args.startY, args.endX, args.endY, 0, args.durationMs, 0, remainingTimeoutMs);
    });

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

  private async handleInputPressButton(
    request: DaemonRequest,
    socketSessionId?: string
  ): Promise<any | undefined> {
    const queueEnterMs = this.timer.now();
    const totalTimeoutMs = resolveMcpRequestTimeoutMs(request);
    const args = this.parseInputPressButtonParams(request.params);
    const targetDevice = await this.resolveInputTargetDevice(
      args.platform,
      args.deviceId,
      socketSessionId,
      "input/pressButton"
    );
    const buttonResult = await this.runKeyedMcpForward(`device:${targetDevice.deviceId}`, async () => {
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

      return await new PressButton(targetDevice).press(args.button);
    });

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

  private parseInputTapParams(params: unknown): {
    platform: "android" | "ios";
    deviceId?: string;
    x: number;
    y: number;
    duration?: number;
  } {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("input/tap requires params object");
    }

    const args = params as Record<string, unknown>;
    if (args.platform !== "android" && args.platform !== "ios") {
      throw new Error("input/tap requires platform 'android' or 'ios'");
    }
    if (typeof args.x !== "number" || Number.isNaN(args.x) || typeof args.y !== "number" || Number.isNaN(args.y)) {
      throw new Error("input/tap requires numeric x and y params");
    }
    if (args.duration !== undefined && (typeof args.duration !== "number" || Number.isNaN(args.duration))) {
      throw new Error("input/tap duration must be numeric when provided");
    }
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error("input/tap deviceId must be a string when provided");
    }

    return {
      platform: args.platform,
      deviceId: args.deviceId,
      x: args.x,
      y: args.y,
      duration: args.duration,
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
      (
        typeof args.durationMs !== "number" ||
        !Number.isFinite(args.durationMs) ||
        args.durationMs < 1 ||
        args.durationMs > 60_000
      )
    ) {
      throw new Error("input/swipe durationMs must be between 1 and 60000 milliseconds");
    }
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error("input/swipe deviceId must be a string when provided");
    }

    return {
      platform: args.platform,
      deviceId: args.deviceId,
      startX: args.startX,
      startY: args.startY,
      endX: args.endX,
      endY: args.endY,
      durationMs: args.durationMs ?? 300,
    };
  }

  private parseInputPressButtonParams(params: unknown): {
    platform: "android" | "ios";
    deviceId?: string;
    button: string;
    responseButton: string;
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
    const supportedButtons = ["home", "back", "menu", "power", "volume_up", "volume_down", "recent", "app_switch", "enter"];
    if (!supportedButtons.includes(args.button)) {
      throw new Error(`input/pressButton button must be one of: ${supportedButtons.join(", ")}`);
    }
    if (args.deviceId !== undefined && typeof args.deviceId !== "string") {
      throw new Error("input/pressButton deviceId must be a string when provided");
    }
    const button = args.button === "app_switch" ? "recent" : args.button;

    return {
      platform: args.platform,
      deviceId: args.deviceId,
      button,
      responseButton: args.button,
    };
  }

  private async resolveInputTargetDevice(
    platform: "android" | "ios",
    deviceId: string | undefined,
    socketSessionId: string | undefined,
    action: "input/tap" | "input/swipe" | "input/pressButton"
  ): Promise<BootedDevice> {
    const discovery = await PlatformDeviceManagerFactory.getInstance().getBootedDevicesDetailed(platform);
    if (!discovery.succeededPlatforms.has(platform)) {
      throw new Error(`Unable to discover booted ${platform} devices for ${action}`);
    }
    const bootedDevices = discovery.devices;
    if (deviceId) {
      const targetDevice = bootedDevices.find(device => device.deviceId === deviceId);
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
      const targetDevice = bootedDevices.find(device => device.deviceId === autolockDeviceId);
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

  private async handleIdeRequest(
    mcpClient: Client,
    request: DaemonRequest,
    timeoutMs: number,
    socketSessionId: string
  ): Promise<any> {
    const requestOptions = { timeout: timeoutMs };

    switch (request.method) {
      case "tools/list": {
        return await mcpClient.listTools();
      }
      case "tools/call": {
        return await mcpClient.callTool({
          name: request.params.name,
          arguments: this.withSocketSessionAutolockKey(request.params.arguments, socketSessionId),
        }, undefined, requestOptions);
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
        return await mcpClient.callTool({ name: "getNavigationGraph", arguments: args }, undefined, requestOptions);
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

    return {
      ...args,
      __mcpSessionId: socketSessionId,
    };
  }

  /**
   * Create an MCP client connected to the HTTP server
   */
  private async createMcpClient(): Promise<Client> {
    logger.info(`Creating MCP client with endpoint: "${this.mcpEndpoint}"`);
    if (!this.mcpEndpoint) {
      logger.error(`ERROR: mcpEndpoint is empty or undefined when creating client!`);
      throw new Error("mcpEndpoint is not set");
    }
    const transport = new StreamableHTTPClientTransport(
      new URL(this.mcpEndpoint),
      {
        reconnectionOptions: DAEMON_LOOPBACK_STREAMABLE_HTTP_RECONNECTION,
      }
    );

    const client = new Client(
      {
        name: "auto-mobile-daemon-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    await client.connect(transport);
    logger.info(`MCP client connected to ${this.mcpEndpoint}`);

    return client;
  }

  /**
   * Get or create the MCP client for a target key.
   */
  private async getMcpClient(key: string): Promise<Client> {
    this.clearMcpClientIdleTimer(key);

    const existingClient = this.mcpClients.get(key);
    if (existingClient) {
      return existingClient;
    }

    const existingPromise = this.mcpClientPromises.get(key);
    if (existingPromise) {
      return existingPromise;
    }

    const clientPromise = this.createMcpClient()
      .then(client => {
        this.mcpClients.set(key, client);
        this.mcpClientPromises.delete(key);
        return client;
      })
      .catch(error => {
        this.mcpClientPromises.delete(key);
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
    if (this.mcpForwardTails.has(key)) {
      return;
    }
    await this.resetMcpClient(key);
  }

  /**
   * Enqueue a request in the session to maintain sequential order
   */
  private async enqueueRequest<T>(
    session: SessionContext,
    handler: () => Promise<T>
  ): Promise<T> {
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

    // Stop receiving list-changed events (mirrors the subscribe in start()).
    this.listChangedUnsubscribe?.();
    this.listChangedUnsubscribe = null;

    // Close MCP clients
    const clients = Array.from(this.mcpClients.entries());
    this.mcpClients.clear();
    this.mcpClientPromises.clear();
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

    // Clear sessions
    this.sessions.clear();
    this.clientSockets.clear();
    this.notificationSubscribers.clear();

    const ownsSocketPath = this.isOwnedSocketFile();

    if (this.server && (ownsSocketPath || !existsSync(this.socketPath))) {
      await new Promise<void>(resolve => {
        this.server!.close(() => {
          logger.info("Unix socket server closed");
          resolve();
        });
      });
      this.server = null;
    } else if (this.server) {
      logger.warn(
        `Unix socket path ${this.socketPath} no longer belongs to this server; leaving listener for process teardown`
      );
      this.server.unref();
      this.server = null;
    }

    if (ownsSocketPath && existsSync(this.socketPath)) {
      await unlink(this.socketPath);
    }
    this.socketFileIdentity = null;
  }

  private readSocketFileIdentity(): SocketFileIdentity | null {
    try {
      const stats = statSync(this.socketPath);
      return { dev: stats.dev, ino: stats.ino };
    } catch {
      return null;
    }
  }

  private isOwnedSocketFile(): boolean {
    if (!this.socketFileIdentity || !existsSync(this.socketPath)) {
      return false;
    }
    const currentIdentity = this.readSocketFileIdentity();
    return currentIdentity?.dev === this.socketFileIdentity.dev &&
      currentIdentity.ino === this.socketFileIdentity.ino;
  }
}
