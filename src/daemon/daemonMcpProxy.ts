import { DaemonClient, DaemonUnavailableError, type DaemonClientLike, type DaemonClientFactory } from "./client";
import { DaemonManager, type DaemonManagerLike } from "./manager";
import { logger } from "../utils/logger";
import { SOCKET_PATH, DAEMON_STARTUP_TIMEOUT_MS, CONNECTION_TIMEOUT_MS, DAEMON_VERSION, DAEMON_VERSION_RESTART_COOLDOWN_MS } from "./constants";
import type { DaemonOptions } from "./types";
import { compareVersions } from "../server/deviceMatcher";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

export type VersionMismatchReason =
  | "autoStartDisabled"
  | "cooldown"
  | "daemonNewer"
  | "nonNumeric"
  | "restartMismatch";

/**
 * Raised before connecting when the running daemon and MCP client package
 * versions differ but the proxy cannot safely reconcile them immediately.
 */
export class DaemonVersionMismatchError extends DaemonUnavailableError {
  readonly clientVersion: string;
  readonly daemonVersion: string;
  readonly reason: VersionMismatchReason;
  readonly retryAfterMs?: number;

  constructor(params: {
    clientVersion: string;
    daemonVersion: string;
    reason: VersionMismatchReason;
    detail: string;
    retryAfterMs?: number;
  }) {
    const restartCommand = params.clientVersion.length > 0 && params.clientVersion !== "unknown"
      ? `bunx @kaeawc/auto-mobile@${params.clientVersion} --daemon restart`
      : "the same installed auto-mobile package";
    const retryGuidance = params.retryAfterMs !== undefined
      ? ` Retry after ${params.retryAfterMs}ms or restart the daemon with: ${restartCommand}`
      : ` Restart the daemon with: ${restartCommand}`;
    super(
      `AutoMobile daemon version mismatch: daemon=${params.daemonVersion}, client=${params.clientVersion} ` +
      `(${params.detail}).${retryGuidance}`
    );
    this.name = "DaemonVersionMismatchError";
    this.clientVersion = params.clientVersion;
    this.daemonVersion = params.daemonVersion;
    this.reason = params.reason;
    this.retryAfterMs = params.retryAfterMs;
  }
}

/**
 * Configuration for the DaemonMcpProxy
 */
export interface DaemonMcpProxyConfig {
  /** Whether to automatically start the daemon if not running */
  autoStartDaemon?: boolean;
  /** Socket path for daemon communication */
  socketPath?: string;
  /** Connection timeout in milliseconds */
  connectionTimeoutMs?: number;
  /** Factory for creating daemon clients (for testing) */
  clientFactory?: DaemonClientFactory;
  /** Custom daemon manager (for testing) */
  daemonManager?: DaemonManagerLike;
  /** Options to pass when auto-starting the daemon */
  daemonOptions?: DaemonOptions;
  /** Timer for version restart cooldown checks */
  timer?: Pick<Timer, "now">;
}

/**
 * Tool definition from daemon
 */
export interface ProxiedToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Resource definition from daemon
 */
export interface ProxiedResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * Resource template definition from daemon
 */
export interface ProxiedResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * DaemonMcpProxy - Proxy layer for MCP server to communicate with daemon
 *
 * This class handles:
 * - Auto-connecting to an existing daemon
 * - Auto-starting a daemon if one isn't running
 * - Forwarding MCP tool calls to the daemon
 * - Forwarding MCP resource requests to the daemon
 * - Caching tool/resource definitions from daemon
 */
export class DaemonMcpProxy {
  private client: DaemonClientLike | null = null;
  private config: DaemonMcpProxyConfig;
  private daemonManager: DaemonManagerLike;
  private clientFactory: DaemonClientFactory;
  private readonly timer: Pick<Timer, "now">;
  private connecting: Promise<void> | null = null;
  private connected: boolean = false;

  // Cached definitions from daemon
  private cachedTools: ProxiedToolDefinition[] | null = null;
  private cachedResources: ProxiedResourceDefinition[] | null = null;
  private cachedResourceTemplates: ProxiedResourceTemplate[] | null = null;

  constructor(config: DaemonMcpProxyConfig = {}) {
    this.config = {
      autoStartDaemon: true,
      socketPath: SOCKET_PATH,
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
      ...config,
    };
    this.daemonManager = config.daemonManager ?? new DaemonManager();
    this.clientFactory = config.clientFactory ?? (() => new DaemonClient(
      this.config.socketPath,
      this.config.connectionTimeoutMs
    ));
    this.timer = config.timer ?? defaultTimer;
  }

  /**
   * Ensure we have a connection to the daemon
   * Will auto-start daemon if configured and daemon is not running
   */
  async ensureConnected(): Promise<void> {
    if (this.connected && this.client) {
      return;
    }

    // Prevent multiple concurrent connection attempts
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = this.doConnect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async doConnect(): Promise<void> {
    // Check if daemon is available
    const socketPath = this.config.socketPath ?? SOCKET_PATH;
    const isAvailable = await DaemonClient.isAvailable(socketPath);

    if (!isAvailable) {
      if (!this.config.autoStartDaemon) {
        throw new DaemonUnavailableError(
          "Daemon is not running and auto-start is disabled"
        );
      }
      logger.info("[DaemonMcpProxy] Daemon not available, starting daemon...");
      await this.startDaemon();
      await this.ensureVersionMatches();
    } else {
      await this.ensureVersionMatches();
    }

    // Create and connect client
    this.client = this.clientFactory();
    await this.client.connect();
    this.connected = true;
    logger.info("[DaemonMcpProxy] Connected to daemon");
  }

  /**
   * Ensure the client never attaches to a daemon running a different package version.
   * Newer clients may restart older daemons, but every mismatch remains a hard gate.
   */
  private async ensureVersionMatches(): Promise<void> {
    const status = await this.daemonManager.status();
    if (!status.running) {
      return;
    }

    const runningVersion = status.version?.trim() ?? "";
    if (runningVersion === DAEMON_VERSION) {
      return;
    }

    const cmp = runningVersion.length > 0
      ? compareVersions(DAEMON_VERSION, runningVersion)
      : Number.POSITIVE_INFINITY;

    if (!this.config.autoStartDaemon) {
      throw this.versionMismatchError(runningVersion, "autoStartDisabled", "auto-start is disabled");
    }

    if (runningVersion.length > 0 && !Number.isFinite(cmp)) {
      throw this.versionMismatchError(
        runningVersion,
        "nonNumeric",
        "version comparison is not numeric"
      );
    }

    if (cmp <= 0) {
      throw this.versionMismatchError(
        runningVersion,
        "daemonNewer",
        "the running daemon is newer than this client"
      );
    }

    if (status.startedAt) {
      const daemonAgeMs = this.timer.now() - status.startedAt;
      if (daemonAgeMs < DAEMON_VERSION_RESTART_COOLDOWN_MS) {
        logger.warn(
          `[DaemonMcpProxy] Skipping version-mismatch restart due to cooldown: daemon ${runningVersion || "unknown"} is ${daemonAgeMs}ms old, client version is ${DAEMON_VERSION}`
        );
        throw this.versionMismatchError(
          runningVersion,
          "cooldown",
          "restart is in cooldown",
          DAEMON_VERSION_RESTART_COOLDOWN_MS - daemonAgeMs
        );
      }
    }

    logger.info(
      `[DaemonMcpProxy] Daemon version ${runningVersion || "unknown"} differs from MCP server ${DAEMON_VERSION}, restarting daemon`
    );
    await this.daemonManager.restart(this.config.daemonOptions ?? {});
    const ready = await this.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon failed to restart within ${DAEMON_STARTUP_TIMEOUT_MS}ms`
      );
    }

    const restartedStatus = await this.daemonManager.status();
    const restartedVersion = restartedStatus.version?.trim() ?? "";
    if (!restartedStatus.running || restartedVersion !== DAEMON_VERSION) {
      throw this.versionMismatchError(
        restartedVersion,
        "restartMismatch",
        "daemon restart completed but version still differs"
      );
    }
  }

  private versionMismatchError(
    runningVersion: string,
    reason: VersionMismatchReason,
    detail: string,
    retryAfterMs?: number,
  ): DaemonVersionMismatchError {
    const daemonVersion = runningVersion.length > 0 ? runningVersion : "unknown";
    const clientVersion = DAEMON_VERSION.trim();
    return new DaemonVersionMismatchError({
      clientVersion,
      daemonVersion,
      reason,
      detail,
      retryAfterMs,
    });
  }

  /**
   * Start the daemon process
   */
  private async startDaemon(): Promise<void> {
    const status = await this.daemonManager.status();

    if (!status.running) {
      logger.info("[DaemonMcpProxy] Starting daemon...");
      // Pass through daemon options (debug flags, video defaults, etc.)
      await this.daemonManager.start(this.config.daemonOptions ?? {});

      // Wait for daemon to be ready
      const ready = await this.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
      if (!ready) {
        throw new DaemonUnavailableError(
          `Daemon failed to start within ${DAEMON_STARTUP_TIMEOUT_MS}ms`
        );
      }
      logger.info("[DaemonMcpProxy] Daemon started successfully");
    }
  }

  private async withRecoverableReconnect<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    await this.ensureConnected();

    try {
      return await operation();
    } catch (error) {
      if (!this.isRecoverableDaemonSessionError(error)) {
        throw error;
      }

      logger.warn(
        `[DaemonMcpProxy] Daemon session is stale, reconnecting and retrying once: ${error instanceof Error ? error.message : String(error)}`
      );
      await this.resetConnection();
      await this.ensureConnected();
      return await operation();
    }
  }

  private isRecoverableDaemonSessionError(error: unknown): boolean {
    if (error instanceof DaemonUnavailableError) {
      return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Session not found");
  }

  private async resetConnection(): Promise<void> {
    const staleClient = this.client;
    this.connected = false;
    this.client = null;
    this.invalidateCache();

    if (!staleClient) {
      return;
    }

    try {
      await staleClient.close();
    } catch (error) {
      logger.warn(`[DaemonMcpProxy] Failed to close stale daemon client: ${error}`);
    }
  }

  /**
   * Get list of available tools from daemon
   */
  async listTools(): Promise<ProxiedToolDefinition[]> {
    // Return cached tools if available
    if (this.cachedTools) {
      return this.cachedTools;
    }

    try {
      const result = await this.withRecoverableReconnect(() =>
        this.client!.callDaemonMethod("tools/list", {})
      );
      const tools = result?.tools ?? [];
      this.cachedTools = tools;
      return tools;
    } catch (error) {
      logger.error(`[DaemonMcpProxy] Failed to list tools: ${error}`);
      throw error;
    }
  }

  /**
   * Call a tool on the daemon
   */
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<any> {
    return await this.withRecoverableReconnect(() => this.client!.callTool(name, args));
  }

  /**
   * Get list of available resources from daemon
   */
  async listResources(): Promise<ProxiedResourceDefinition[]> {
    // Return cached resources if available
    if (this.cachedResources) {
      return this.cachedResources;
    }

    try {
      const result = await this.withRecoverableReconnect(() =>
        this.client!.callDaemonMethod("resources/list", {})
      );
      const resources = result?.resources ?? [];
      this.cachedResources = resources;
      return resources;
    } catch (error) {
      logger.error(`[DaemonMcpProxy] Failed to list resources: ${error}`);
      throw error;
    }
  }

  /**
   * Get list of resource templates from daemon
   */
  async listResourceTemplates(): Promise<ProxiedResourceTemplate[]> {
    // Return cached templates if available
    if (this.cachedResourceTemplates) {
      return this.cachedResourceTemplates;
    }

    try {
      const result = await this.withRecoverableReconnect(() =>
        this.client!.callDaemonMethod("resources/list-templates", {})
      );
      const templates = result?.resourceTemplates ?? [];
      this.cachedResourceTemplates = templates;
      return templates;
    } catch (error) {
      logger.error(`[DaemonMcpProxy] Failed to list resource templates: ${error}`);
      throw error;
    }
  }

  /**
   * Read a resource from the daemon
   */
  async readResource(uri: string): Promise<any> {
    return await this.withRecoverableReconnect(() => this.client!.readResource(uri));
  }

  /**
   * Invalidate cached definitions (call when daemon restarts)
   */
  invalidateCache(): void {
    this.cachedTools = null;
    this.cachedResources = null;
    this.cachedResourceTemplates = null;
  }

  /**
   * Check if connected to daemon
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Close the connection to daemon
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.connected = false;
    this.invalidateCache();
    logger.debug("[DaemonMcpProxy] Disconnected from daemon");
  }
}
