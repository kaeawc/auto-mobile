import { DaemonClient, DaemonUnavailableError, type DaemonClientLike, type DaemonClientFactory } from "./client";
import { DaemonManager, type DaemonManagerLike } from "./manager";
import { logger } from "../utils/logger";
import { SOCKET_PATH, DAEMON_STARTUP_TIMEOUT_MS, CONNECTION_TIMEOUT_MS, DAEMON_VERSION, DAEMON_VERSION_RESTART_COOLDOWN_MS } from "./constants";
import type { DaemonOptions } from "./types";
import { compareVersions } from "../server/deviceMatcher";
import { releaseVersion } from "../utils/mcpVersion";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import {
  type BuildIdentity,
  buildIdentitiesMatch,
  getCurrentBuildIdentity,
} from "./buildIdentity";

export type VersionMismatchReason =
  | "autoStartDisabled"
  | "cooldown"
  | "daemonNewer"
  | "nonNumeric"
  | "restartMismatch";

export type BuildMismatchReason =
  | "autoStartDisabled"
  | "cooldown"
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
    // The git-SHA build metadata on dev builds is not an installable npm tag,
    // so the bunx hint must point at the plain published version.
    const installableVersion = releaseVersion(params.clientVersion);
    const restartCommand = installableVersion.length > 0 && installableVersion !== "unknown"
      ? `bunx @kaeawc/auto-mobile@${installableVersion} --daemon restart`
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
 * Raised when the running daemon is a *different build* than this client even
 * though the version strings may be identical (e.g. two checkouts that both
 * report a pre-release version sharing one per-uid socket). Detected via the
 * build-identity content hash rather than the version string.
 */
export class DaemonBuildMismatchError extends DaemonUnavailableError {
  readonly clientBuildId: string;
  readonly daemonBuildId: string;
  readonly clientEntryScript: string;
  readonly daemonEntryScript: string;
  readonly reason: BuildMismatchReason;
  readonly retryAfterMs?: number;

  constructor(params: {
    client: BuildIdentity;
    daemon: BuildIdentity;
    reason: BuildMismatchReason;
    detail: string;
    retryAfterMs?: number;
  }) {
    const daemonScript = params.daemon.entryScript || "unknown";
    const clientScript = params.client.entryScript || "unknown";
    const retryGuidance = params.retryAfterMs !== undefined
      ? ` Retry after ${params.retryAfterMs}ms.`
      : "";
    super(
      `AutoMobile daemon build mismatch: the running daemon is a different build than this client ` +
      `(${params.detail}). daemon build=${params.daemon.buildId} (${daemonScript}), ` +
      `client build=${params.client.buildId} (${clientScript}).${retryGuidance}`
    );
    this.name = "DaemonBuildMismatchError";
    this.clientBuildId = params.client.buildId;
    this.daemonBuildId = params.daemon.buildId;
    this.clientEntryScript = params.client.entryScript;
    this.daemonEntryScript = params.daemon.entryScript;
    this.reason = params.reason;
    this.retryAfterMs = params.retryAfterMs;
  }
}

/**
 * Raised when a tool the frontend advertises is rejected by the daemon as
 * "Unknown tool" even after the proxy reconciled build identity and retried.
 * Replaces the opaque `-32603` with an actionable message naming both builds.
 */
export class DaemonToolUnavailableError extends Error {
  readonly toolName: string;
  readonly clientBuildId: string;
  readonly daemonBuildId: string;

  constructor(params: {
    toolName: string;
    client: BuildIdentity;
    daemon: BuildIdentity;
  }) {
    const daemonScript = params.daemon.entryScript || "unknown";
    const clientScript = params.client.entryScript || "unknown";
    super(
      `Tool "${params.toolName}" is advertised by this AutoMobile client but the connected daemon ` +
      `does not provide it, even after restarting and refreshing the tool list. This usually means a ` +
      `wrong-build daemon is serving this frontend. ` +
      `client build=${params.client.buildId} (${clientScript}), ` +
      `daemon build=${params.daemon.buildId} (${daemonScript}). ` +
      `Restart the daemon from this checkout to resolve the skew.`
    );
    this.name = "DaemonToolUnavailableError";
    this.toolName = params.toolName;
    this.clientBuildId = params.client.buildId;
    this.daemonBuildId = params.daemon.buildId;
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
  /** This client's build identity (for testing; defaults to the current process build) */
  buildIdentity?: BuildIdentity;
  /** This client's version for the daemon version gate (defaults to DAEMON_VERSION; injectable for testing) */
  clientVersion?: string;
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
  private readonly buildIdentity: BuildIdentity;
  private readonly clientVersion: string;
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
    this.buildIdentity = config.buildIdentity ?? getCurrentBuildIdentity();
    this.clientVersion = config.clientVersion ?? DAEMON_VERSION;
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
      await this.ensureBuildMatches();
      await this.ensureStartupOptionsMatch();
    } else {
      await this.ensureVersionMatches();
      await this.ensureBuildMatches();
      await this.ensureStartupOptionsMatch();
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
    if (runningVersion === this.clientVersion) {
      return;
    }

    // The release portions (before the `+g<sha>` dev stamp) drive the
    // newer/older decision. Equal release + differing full strings means two
    // source checkouts at the same release but different commits (dev-skew).
    const runningBase = releaseVersion(runningVersion);
    const clientBase = releaseVersion(this.clientVersion);
    const sameRelease = runningBase === clientBase;

    if (!this.config.autoStartDaemon) {
      throw this.versionMismatchError(runningVersion, "autoStartDisabled", "auto-start is disabled");
    }

    if (!sameRelease) {
      const cmp = runningBase.length > 0
        ? compareVersions(clientBase, runningBase)
        : Number.POSITIVE_INFINITY;

      if (runningBase.length > 0 && !Number.isFinite(cmp)) {
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
    }

    // Reach here when the client is strictly newer OR the daemon is a same-release
    // dev-skew (different git stamp). Both reconcile by restarting the daemon from
    // this client's build. Same-release dev-skew must be handled HERE rather than
    // deferred to ensureBuildMatches: the build-identity hash covers only the entry
    // script (process.argv[1]), so in unbundled source-mode runs (`bun src/index.ts`)
    // it is blind to commits that change non-entry files — the git stamp is the only
    // signal. The restart is cooldown-bounded below so two checkouts cannot thrash.

    if (status.startedAt) {
      const daemonAgeMs = this.timer.now() - status.startedAt;
      if (daemonAgeMs < DAEMON_VERSION_RESTART_COOLDOWN_MS) {
        logger.warn(
          `[DaemonMcpProxy] Skipping version-mismatch restart due to cooldown: daemon ${runningVersion || "unknown"} is ${daemonAgeMs}ms old, client version is ${this.clientVersion}`
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
      `[DaemonMcpProxy] Daemon version ${runningVersion || "unknown"} differs from MCP server ${this.clientVersion}, restarting daemon`
    );
    await this.daemonManager.restart(this.config.daemonOptions ?? {});
    // The replacement daemon may expose a different tool set; drop the cache so we
    // never advertise the old daemon's tools against the new build.
    this.invalidateCache();
    const ready = await this.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon failed to restart within ${DAEMON_STARTUP_TIMEOUT_MS}ms`
      );
    }

    const restartedStatus = await this.daemonManager.status();
    const restartedVersion = restartedStatus.version?.trim() ?? "";
    if (!restartedStatus.running || restartedVersion !== this.clientVersion) {
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
    const clientVersion = this.clientVersion.trim();
    return new DaemonVersionMismatchError({
      clientVersion,
      daemonVersion,
      reason,
      detail,
      retryAfterMs,
    });
  }

  /**
   * Ensure the client never attaches to a daemon built from a *different* checkout.
   * The version string alone cannot detect this (two checkouts can both report the
   * same pre-release version), so we compare a content hash of the entry script.
   * On mismatch, restart the daemon from this client's own entrypoint so the live
   * frontend and backend run the same code. Independent of, and complementary to,
   * {@link ensureVersionMatches}.
   */
  private async ensureBuildMatches(): Promise<void> {
    const status = await this.daemonManager.status();
    if (!status.running) {
      return;
    }

    const daemonIdentity: BuildIdentity = {
      entryScript: status.entryScript ?? "",
      buildId: status.buildId ?? "unknown",
    };
    if (buildIdentitiesMatch(this.buildIdentity, daemonIdentity)) {
      return;
    }

    if (!this.config.autoStartDaemon) {
      throw this.buildMismatchError(daemonIdentity, "autoStartDisabled", "auto-start is disabled");
    }

    if (status.startedAt) {
      const daemonAgeMs = this.timer.now() - status.startedAt;
      if (daemonAgeMs < DAEMON_VERSION_RESTART_COOLDOWN_MS) {
        logger.warn(
          `[DaemonMcpProxy] Skipping build-mismatch restart due to cooldown: daemon build ${daemonIdentity.buildId} is ${daemonAgeMs}ms old, client build is ${this.buildIdentity.buildId}`
        );
        throw this.buildMismatchError(
          daemonIdentity,
          "cooldown",
          "restart is in cooldown",
          DAEMON_VERSION_RESTART_COOLDOWN_MS - daemonAgeMs
        );
      }
    }

    logger.info(
      `[DaemonMcpProxy] Daemon build ${daemonIdentity.buildId} (${daemonIdentity.entryScript || "unknown"}) differs from client build ${this.buildIdentity.buildId} (${this.buildIdentity.entryScript || "unknown"}), restarting daemon`
    );
    await this.daemonManager.restart(this.config.daemonOptions ?? {});
    // The replacement daemon may expose a different tool set; drop the cache so we
    // never advertise the old daemon's tools against the new build.
    this.invalidateCache();
    const ready = await this.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon failed to restart within ${DAEMON_STARTUP_TIMEOUT_MS}ms`
      );
    }

    const restartedStatus = await this.daemonManager.status();
    const restartedIdentity: BuildIdentity = {
      entryScript: restartedStatus.entryScript ?? "",
      buildId: restartedStatus.buildId ?? "unknown",
    };
    if (!restartedStatus.running || !buildIdentitiesMatch(this.buildIdentity, restartedIdentity)) {
      throw this.buildMismatchError(
        restartedIdentity,
        "restartMismatch",
        "daemon restart completed but build still differs"
      );
    }
  }

  private buildMismatchError(
    daemon: BuildIdentity,
    reason: BuildMismatchReason,
    detail: string,
    retryAfterMs?: number,
  ): DaemonBuildMismatchError {
    return new DaemonBuildMismatchError({
      client: this.buildIdentity,
      daemon,
      reason,
      detail,
      retryAfterMs,
    });
  }

  private async ensureStartupOptionsMatch(): Promise<void> {
    const status = await this.daemonManager.status();
    if (!status.running) {
      return;
    }

    const requestedEmbeddedSdk = this.config.daemonOptions?.embeddedSdk === true;
    const runningEmbeddedSdk = status.options?.embeddedSdk === true;
    if (requestedEmbeddedSdk === runningEmbeddedSdk) {
      return;
    }

    if (!this.config.autoStartDaemon) {
      throw new DaemonUnavailableError(
        "Daemon startup options differ from MCP server options and auto-start is disabled"
      );
    }

    logger.info(
      `[DaemonMcpProxy] Daemon embeddedSdk=${runningEmbeddedSdk} differs from MCP server embeddedSdk=${requestedEmbeddedSdk}, restarting daemon`
    );
    await this.daemonManager.restart(this.config.daemonOptions ?? {});
    const ready = await this.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon failed to restart within ${DAEMON_STARTUP_TIMEOUT_MS}ms`
      );
    }

    const restartedStatus = await this.daemonManager.status();
    const restartedEmbeddedSdk = restartedStatus.options?.embeddedSdk === true;
    if (!restartedStatus.running || restartedEmbeddedSdk !== requestedEmbeddedSdk) {
      throw new DaemonUnavailableError(
        "Daemon restart completed but startup options still differ"
      );
    }
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
    // "Unknown tool" means the frontend advertised a tool the daemon rejects —
    // typically a wrong-build daemon serving this frontend. Reconnecting drops the
    // stale tool cache and re-runs the build-identity handshake (which restarts the
    // daemon to the correct build on skew), so retry once before giving up.
    return message.includes("Session not found") || this.isUnknownToolError(error);
  }

  private isUnknownToolError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Unknown tool:");
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
    try {
      return await this.withRecoverableReconnect(() => this.client!.callTool(name, args));
    } catch (error) {
      // withRecoverableReconnect already reconciled build identity and retried once.
      // A still-"Unknown tool" failure means the daemon genuinely cannot provide a
      // tool this frontend advertises — surface an actionable error naming both
      // builds instead of the opaque -32603.
      if (this.isUnknownToolError(error)) {
        throw await this.toolUnavailableError(name);
      }
      throw error;
    }
  }

  private async toolUnavailableError(name: string): Promise<DaemonToolUnavailableError> {
    let daemonIdentity: BuildIdentity = { entryScript: "", buildId: "unknown" };
    try {
      const status = await this.daemonManager.status();
      daemonIdentity = {
        entryScript: status.entryScript ?? "",
        buildId: status.buildId ?? "unknown",
      };
    } catch (error) {
      logger.warn(`[DaemonMcpProxy] Failed to read daemon status for tool-unavailable error: ${error}`);
    }
    return new DaemonToolUnavailableError({
      toolName: name,
      client: this.buildIdentity,
      daemon: daemonIdentity,
    });
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
