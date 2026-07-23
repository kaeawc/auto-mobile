import { DaemonClient, DaemonUnavailableError, type DaemonClientLike, type DaemonClientFactory } from "./client";
import { DaemonManager, type DaemonManagerLike } from "./manager";
import { logger } from "../utils/logger";
import { SOCKET_PATH, DAEMON_STARTUP_TIMEOUT_MS, CONNECTION_TIMEOUT_MS, DAEMON_VERSION, DAEMON_VERSION_RESTART_COOLDOWN_MS } from "./constants";
import type { DaemonNotification, DaemonOptions } from "./types";
import { listChangedKindForMethod, type ListChangedKind } from "../server/listChangedBroadcast";
import { OUTPUT_REDUCTION_FLAG_SPECS } from "../utils/outputReductionFlags";
import { compareVersions } from "../server/deviceMatcher";
import { releaseVersion } from "../utils/mcpVersion";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { isExplicitPin, resolveAssetVersion, resolvePinnedVersion } from "../constants/release";
import {
  type BuildIdentity,
  buildIdentitiesMatch,
  buildIdentityFromStatus,
  describeBuildIdentity,
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
    const retryGuidance = params.retryAfterMs !== undefined
      ? ` Retry after ${params.retryAfterMs}ms.`
      : "";
    super(
      `AutoMobile daemon build mismatch: the running daemon is a different build than this client ` +
      `(${params.detail}). daemon build=${describeBuildIdentity(params.daemon)}, ` +
      `client build=${describeBuildIdentity(params.client)}.${retryGuidance}`
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

export class DaemonAssetVersionMismatchError extends DaemonUnavailableError {
  readonly clientAssetVersion: string;
  readonly daemonAssetVersion: string;

  constructor(clientAssetVersion: string, daemonAssetVersion: string) {
    super(
      `AutoMobile AUTOMOBILE_VERSION mismatch: caller requested ${clientAssetVersion}, ` +
      `but the shared daemon was started with ${daemonAssetVersion}. Restart the daemon ` +
      `from the caller's environment (for example, run auto-mobile --daemon restart) before reusing it.`
    );
    this.name = "DaemonAssetVersionMismatchError";
    this.clientAssetVersion = clientAssetVersion;
    this.daemonAssetVersion = daemonAssetVersion;
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
    super(
      `Tool "${params.toolName}" is advertised by this AutoMobile client but the connected daemon ` +
      `does not provide it, even after restarting and refreshing the tool list. This usually means a ` +
      `wrong-build daemon is serving this frontend. ` +
      `client build=${describeBuildIdentity(params.client)}, ` +
      `daemon build=${describeBuildIdentity(params.daemon)}. ` +
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
 * The daemon startup options that change its observable MCP behavior and so must
 * match before a running daemon can be reused: `embeddedSdk`, `networkMockable`,
 * marker-based eventAll promotion config, plus every output-reduction flag. A
 * same-build MCP client that requests one of these against an already-running
 * daemon started without it (or vice versa) would otherwise silently get the
 * wrong tool-output or inputText behavior until a manual restart (issue #2759 —
 * the `toolResultsNoStructuredContent` case). `embeddedSdk` and `networkMockable`
 * additionally gate whole tool families out of the registry, so reusing a daemon
 * that lacks the requested flag makes those tools unreachable (issue #4247). The
 * output-reduction fields are derived from `OUTPUT_REDUCTION_FLAG_SPECS` (whose
 * `field` names map 1:1 to `DaemonOptions`) so a new flag is covered
 * automatically.
 */
const REUSE_CRITICAL_OPTION_KEYS: (keyof DaemonOptions)[] = [
  "embeddedSdk",
  "networkMockable",
  "safeAreaWarnings",
  ...OUTPUT_REDUCTION_FLAG_SPECS.map(spec => spec.field),
];

const REUSE_CRITICAL_STRING_OPTION_KEYS: (keyof DaemonOptions)[] = [
  "toolOutputsDir",
];

/** The value of a startup option when it is a string, else undefined. */
function stringOption(
  options: DaemonOptions | undefined,
  key: keyof DaemonOptions
): string | undefined {
  const value = options?.[key];
  return typeof value === "string" ? value : undefined;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Reuse-critical startup options the connecting client *explicitly requests*
 * that the running daemon lacks. Reconciliation is **one-directional** (issue
 * #3846): a client that does not ask for a flag has no opinion on it, so a flag
 * the daemon already has is never reported as a deficit just because a
 * particular caller (e.g. a bare short-lived CLI client) didn't request it.
 * Booleans are compared strictly (`=== true`), so `undefined` and `false` both
 * read as "no opinion"; strings and marker arrays count only when the client
 * supplies one that differs from the daemon's. Returns a human-readable list
 * (empty when the daemon already satisfies every requested flag) for logging and
 * error messages.
 */
function startupOptionDeficits(
  requested: DaemonOptions | undefined,
  running: DaemonOptions | undefined
): string[] {
  const deficits: string[] = [];
  for (const key of REUSE_CRITICAL_OPTION_KEYS) {
    const want = requested?.[key] === true;
    const have = running?.[key] === true;
    if (want && !have) {
      deficits.push(`${key} (requested=${want}, running=${have})`);
    }
  }
  for (const key of REUSE_CRITICAL_STRING_OPTION_KEYS) {
    const want = stringOption(requested, key);
    const have = stringOption(running, key);
    if (want !== undefined && want !== have) {
      deficits.push(`${key} (requested=${want}, running=${have ?? "unset"})`);
    }
  }
  const requestedEventAllMarkers = requested?.eventAllMarkers;
  if (requestedEventAllMarkers !== undefined) {
    const runningEventAllMarkers = running?.eventAllMarkers ?? [];
    if (!arraysEqual(requestedEventAllMarkers, runningEventAllMarkers)) {
      deficits.push(
        `eventAllMarkers (requested=${JSON.stringify(requestedEventAllMarkers)}, running=${JSON.stringify(runningEventAllMarkers)})`
      );
    }
  }
  return deficits;
}

/**
 * Options to launch a replacement daemon with when a restart is unavoidable
 * (version/build skew, or a genuine startup-option deficit). Preserves the
 * *running* daemon's existing options as the base and overlays the connecting
 * client's requested options, so a restart triggered for any reason can never
 * silently strip a flag the daemon was already launched with (issue #3846) —
 * it only ever adds flags the client explicitly asks for. Reuse-critical flags
 * the running daemon already has are force-preserved so an explicit-`false`
 * from the client cannot turn them back off.
 */
function mergeDaemonOptions(
  running: DaemonOptions | undefined,
  requested: DaemonOptions | undefined
): DaemonOptions {
  const merged: DaemonOptions = { ...(running ?? {}), ...(requested ?? {}) };
  const mergedRecord = merged as Record<string, unknown>;
  for (const key of REUSE_CRITICAL_OPTION_KEYS) {
    if (running?.[key] === true) {
      mergedRecord[key] = true;
    }
  }
  for (const key of REUSE_CRITICAL_STRING_OPTION_KEYS) {
    const runningString = stringOption(running, key);
    if (stringOption(requested, key) === undefined && runningString !== undefined) {
      mergedRecord[key] = runningString;
    }
  }
  return merged;
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
  private readonly clientAssetVersion: string | null;
  private connecting: Promise<void> | null = null;
  private connected: boolean = false;

  // Cached definitions from daemon
  private cachedTools: ProxiedToolDefinition[] | null = null;
  private cachedResources: ProxiedResourceDefinition[] | null = null;
  private cachedResourceTemplates: ProxiedResourceTemplate[] | null = null;

  // Listeners for daemon-forwarded list-changed notifications (issue #3223),
  // fired after the matching cache is invalidated so a re-fetch is never stale.
  private readonly listChangedListeners = new Set<(kind: ListChangedKind) => void>();
  // Releases this proxy's handler on the current client. Needed because a
  // clientFactory may return a shared/reused client (test fakes do); without it
  // every reconnect would stack another handler on that client.
  private notificationUnsubscribe: (() => void) | null = null;

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
    this.clientAssetVersion = isExplicitPin()
      ? resolveAssetVersion(resolvePinnedVersion())
      : null;
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
      await this.ensureAssetVersionPinMatches();
      await this.ensureBuildMatches();
      await this.ensureStartupOptionsMatch();
    } else {
      await this.ensureVersionMatches();
      await this.ensureAssetVersionPinMatches();
      await this.ensureBuildMatches();
      await this.ensureStartupOptionsMatch();
    }

    // Create and connect client
    this.client = this.clientFactory();
    const client = this.client;
    // Wire daemon-pushed list-changed forwarding (issue #3223) when the client
    // supports it. The handler is registered BEFORE connect so no early frame
    // is dropped; the opt-in subscription request goes out after connect.
    const supportsNotifications =
      typeof client.onNotification === "function" &&
      typeof client.subscribeToNotifications === "function";
    if (supportsNotifications) {
      this.notificationUnsubscribe?.();
      this.notificationUnsubscribe = client.onNotification!(
        notification => this.handleDaemonNotification(notification)
      );
    }
    await client.connect();
    this.connected = true;
    logger.info("[DaemonMcpProxy] Connected to daemon");

    if (supportsNotifications) {
      try {
        await client.subscribeToNotifications!();
      } catch (error) {
        // Best-effort: without the subscription the proxy degrades to the old
        // cached behavior instead of failing the connection. Unexpected against
        // a same-version daemon (the handshake gate pins versions), so warn.
        logger.warn(`[DaemonMcpProxy] Failed to subscribe to daemon notifications: ${error}`);
      }
    }
  }

  /**
   * Register a listener for daemon-forwarded list-changed notifications
   * (issue #3223). The proxy invalidates the matching cache before firing, so
   * listeners re-fetching `listTools()`/`listResources()` always see fresh
   * definitions. Returns an unsubscribe function.
   */
  onListChanged(listener: (kind: ListChangedKind) => void): () => void {
    this.listChangedListeners.add(listener);
    return () => {
      this.listChangedListeners.delete(listener);
    };
  }

  private handleDaemonNotification(notification: DaemonNotification): void {
    const kind = listChangedKindForMethod(notification.method);
    if (kind === undefined) {
      // Unknown pushed methods are expected as the daemon grows new
      // notification families; ignoring keeps old proxies forward-compatible.
      logger.debug(`[DaemonMcpProxy] Ignoring unknown daemon notification: ${notification.method}`);
      return;
    }

    if (kind === "tools") {
      this.cachedTools = null;
    } else {
      this.cachedResources = null;
      this.cachedResourceTemplates = null;
    }

    for (const listener of this.listChangedListeners) {
      try {
        listener(kind);
      } catch (error) {
        // Best-effort re-emit: a dead/mid-teardown client transport must not
        // break cache invalidation or sibling listeners.
        logger.warn(`[DaemonMcpProxy] list_changed listener failed for ${kind}: ${error}`);
      }
    }
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
    // Preserve the running daemon's existing options across the restart rather
    // than resetting to this client's config, which would strip flags the
    // daemon was launched with when the connecting client is bare (issue #3846).
    await this.daemonManager.restart(mergeDaemonOptions(status.options, this.config.daemonOptions));
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

  private async ensureAssetVersionPinMatches(): Promise<void> {
    if (!this.clientAssetVersion) {
      return;
    }
    const status = await this.daemonManager.status();
    if (!status.running) {
      return;
    }
    const daemonAssetVersion = status.assetVersion?.trim() ?? "";
    if (daemonAssetVersion === this.clientAssetVersion) {
      return;
    }
    throw new DaemonAssetVersionMismatchError(
      this.clientAssetVersion,
      daemonAssetVersion.length > 0 ? daemonAssetVersion : "unknown"
    );
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

    const daemonIdentity = buildIdentityFromStatus(status);
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
    // Preserve the running daemon's existing options across the restart rather
    // than resetting to this client's config, which would strip flags the
    // daemon was launched with when the connecting client is bare (issue #3846).
    await this.daemonManager.restart(mergeDaemonOptions(status.options, this.config.daemonOptions));
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
    const restartedIdentity = buildIdentityFromStatus(restartedStatus);
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

    const requested = this.config.daemonOptions;
    const deficits = startupOptionDeficits(requested, status.options);
    if (deficits.length === 0) {
      return;
    }

    if (!this.config.autoStartDaemon) {
      throw new DaemonUnavailableError(
        `Daemon startup options differ from MCP server options (${deficits.join(", ")}) and auto-start is disabled`
      );
    }

    logger.info(
      `[DaemonMcpProxy] Daemon startup options differ (${deficits.join(", ")}), restarting daemon`
    );
    // Preserve the running daemon's existing options and add the requested ones
    // so the restart gains the missing flag without stripping any the daemon
    // already had (issue #3846).
    await this.daemonManager.restart(mergeDaemonOptions(status.options, requested));
    const ready = await this.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon failed to restart within ${DAEMON_STARTUP_TIMEOUT_MS}ms`
      );
    }

    const restartedStatus = await this.daemonManager.status();
    const remaining = startupOptionDeficits(requested, restartedStatus.options);
    if (!restartedStatus.running || remaining.length > 0) {
      throw new DaemonUnavailableError(
        `Daemon restart completed but startup options still differ (${remaining.join(", ")})`
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
    this.notificationUnsubscribe?.();
    this.notificationUnsubscribe = null;
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
      daemonIdentity = buildIdentityFromStatus(status);
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
    this.notificationUnsubscribe?.();
    this.notificationUnsubscribe = null;
    this.connected = false;
    this.invalidateCache();
    logger.debug("[DaemonMcpProxy] Disconnected from daemon");
  }
}
