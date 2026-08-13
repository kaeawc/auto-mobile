import { DaemonClient, DaemonUnavailableError, type DaemonClientLike, type DaemonClientFactory } from "./client";
import { DaemonManager, type DaemonManagerLike } from "./manager";
import { logger } from "../utils/logger";
import {
  SOCKET_PATH,
  DAEMON_STARTUP_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  DAEMON_VERSION,
  DAEMON_VERSION_RESTART_COOLDOWN_MS,
  DAEMON_BOUND_SESSION_REPLAY_TTL_MS,
  DAEMON_CAPABILITY_PROFILE_PARAM,
  DAEMON_BOUND_SESSION_PARAM,
} from "./constants";
import type { DaemonNotification, DaemonOptions } from "./types";
import { listChangedKindForMethod, type ListChangedKind } from "../server/listChangedBroadcast";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../server/sessionReleaseBroadcast";
import { capabilityProfileUuidFromToolResponse, SET_TOOL_CAPABILITY_TOOL_NAME } from "../features/toolCapabilities/toolCapabilityControl";
import { OUTPUT_REDUCTION_FLAG_SPECS } from "../utils/outputReductionFlags";
import { compareStrictNumericVersions } from "../server/deviceMatcher";
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
  /** Existing device-pool session bound before the first discovery request. */
  initialSessionUuid?: string;
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
 * match before a running daemon can be reused: `debug`, `embeddedSdk`, `networkMockable`,
 * marker-based eventAll promotion config, plus every output-reduction flag. A
 * same-build MCP client that requests one of these against an already-running
 * daemon started without it (or vice versa) would otherwise silently get the
 * wrong tool-output or inputText behavior until a manual restart (issue #2759 —
 * the `toolResultsNoStructuredContent` case). `debug`, `embeddedSdk`, and `networkMockable`
 * additionally gate whole tool families out of the registry, so reusing a daemon
 * that lacks the requested flag makes those tools unreachable (issue #4247). The
 * output-reduction fields are derived from `OUTPUT_REDUCTION_FLAG_SPECS` (whose
 * `field` names map 1:1 to `DaemonOptions`) so a new flag is covered
 * automatically.
 */
export const REUSE_CRITICAL_OPTION_KEYS: (keyof DaemonOptions)[] = [
  "debug",
  "embeddedSdk",
  "networkMockable",
  ...OUTPUT_REDUCTION_FLAG_SPECS.map(spec => spec.field),
];

const REUSE_CRITICAL_STRING_OPTION_KEYS: (keyof DaemonOptions)[] = [
  "toolOutputsDir",
];

const REUSE_CRITICAL_NUMBER_OPTION_KEYS: (keyof DaemonOptions)[] = [
  "runnerReadinessTimeoutMs",
];

/** The value of a startup option when it is a string, else undefined. */
function stringOption(
  options: DaemonOptions | undefined,
  key: keyof DaemonOptions
): string | undefined {
  const value = options?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberOption(
  options: DaemonOptions | undefined,
  key: keyof DaemonOptions
): number | undefined {
  const value = options?.[key];
  return typeof value === "number" ? value : undefined;
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
  for (const key of REUSE_CRITICAL_NUMBER_OPTION_KEYS) {
    const want = numberOption(requested, key);
    const have = numberOption(running, key);
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
  // The daemon clears socket-local state when its RPC connection drops. Keep this
  // proxy's successful explicit binding so subsequent sessionless calls can seed
  // a replacement socket without sharing the binding with other proxies.
  private boundSessionUuid: string | undefined;
  // When the binding above was last set/refreshed, on the injected clock. Once
  // the daemon's session idle window elapses with no explicit-sessionUuid call
  // refreshing it, the remembered UUID is treated as retired so a sessionless
  // call is not rewritten to a released session (issue #4610).
  private boundSessionUuidAt: number | undefined;
  // Startup bindings remain authoritative until the daemon signals release.
  // Replay expiration only protects bindings inferred from ordinary calls.
  private initialSessionBindingConfigured = false;
  // A connection-level capability profile is not a daemon device session. It
  // survives executePlan's device-session release and is forwarded through the
  // socket only when no explicit/remembered routing session is in use.
  private capabilityProfileUuid: string | undefined;
  // Monotonic release-epoch counter, bumped every time the daemon signals that a
  // session was released (via handleDaemonNotification). `releasedSessionEpochs`
  // records, per released UUID, the epoch at which it was last released. A
  // callTool captures the epoch at forward time; on completion the post-call
  // remember/refresh asks "was the SPECIFIC UUID I forwarded released at a later
  // epoch?" and, if so, declines to resurrect it. Scoping the guard to the
  // forwarded UUID (issue #4655) — rather than a single global generation bumped
  // by ANY binding change (issue #4611's first cut) — means the release of an
  // UNRELATED session mid-call no longer blocks remembering the session THIS call
  // actually forwarded, while a release of the forwarded UUID still preserves.
  private releaseEpoch: number = 0;
  private readonly releasedSessionEpochs = new Map<string, number>();
  // Monotonic counter bumped whenever a daemon push invalidates a discovery cache
  // or the session binding mid-flight (list_changed nulls a cache; a bound-session
  // release changes the session scope). A `tools/list` / `resources/list` captures
  // this at forward time and, if it has advanced by completion, declines to store
  // the now-stale response into the cache the invalidation just cleared — the next
  // discovery refetches under the current scope (issue #4655).
  private discoveryEpoch: number = 0;

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
    if (typeof config.initialSessionUuid === "string" && config.initialSessionUuid.trim().length > 0) {
      this.boundSessionUuid = config.initialSessionUuid.trim();
      this.boundSessionUuidAt = this.timer.now();
      this.initialSessionBindingConfigured = true;
    }
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
    if (notification.method === SESSION_RELEASED_NOTIFICATION_METHOD) {
      // The daemon actually released a session. Record the release against the
      // SPECIFIC UUID (issue #4655) so an in-flight call that forwarded exactly
      // this session declines to re-remember it on completion — regardless of
      // whether it is the currently-bound session. If it IS the one this proxy
      // remembers, also drop the binding NOW so a later sessionless call is not
      // rewritten to the retired UUID (issue #4610). A non-matching key —
      // including a derived `${base}:${label}` release when we hold the base —
      // leaves the binding intact. The replay TTL stays as a dropped-frame
      // backstop for when this signal never arrives.
      if (typeof notification.sessionId === "string" && notification.sessionId.length > 0) {
        this.recordSessionReleased(notification.sessionId);
      }
      if (
        this.boundSessionUuid !== undefined &&
        notification.sessionId === this.boundSessionUuid
      ) {
        // A bound-session release changes the scope of any in-flight discovery
        // forwarded with that UUID, so invalidate pending discovery too (#4655).
        this.discoveryEpoch += 1;
        this.clearBoundSessionUuid();
      }
      return;
    }

    const kind = listChangedKindForMethod(notification.method);
    if (kind === undefined) {
      // Unknown pushed methods are expected as the daemon grows new
      // notification families; ignoring keeps old proxies forward-compatible.
      logger.debug(`[DaemonMcpProxy] Ignoring unknown daemon notification: ${notification.method}`);
      return;
    }

    // Bump the discovery epoch so a discovery request whose response is still in
    // flight declines to repopulate the cache this invalidation just cleared
    // (issue #4655).
    this.discoveryEpoch += 1;
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
    // newer/older decision. A plain release client intentionally matches a
    // source-stamped daemon at that release; two stamped versions still detect
    // source-checkout dev-skew.
    const runningBase = releaseVersion(runningVersion);
    const clientBase = releaseVersion(this.clientVersion);
    const sameRelease = runningBase === clientBase;
    const clientDeclaresFullVersion = clientBase !== this.clientVersion;

    if (sameRelease && !clientDeclaresFullVersion) {
      return;
    }

    if (!this.config.autoStartDaemon) {
      throw this.versionMismatchError(runningVersion, "autoStartDisabled", "auto-start is disabled");
    }

    if (!sameRelease) {
      const cmp = runningBase.length > 0
        ? compareStrictNumericVersions(clientBase, runningBase)
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
      try {
        return await operation();
      } catch (retryError) {
        // A configured binding normally survives beyond the replay TTL, because
        // only an actual daemon release may retire it. If the release push was
        // missed, two authoritative "Session not found" responses prove the
        // configured session is gone, so unblock an explicit replacement.
        if (this.initialSessionBindingConfigured && this.isDaemonSessionNotFoundError(retryError)) {
          this.discoveryEpoch += 1;
          this.clearBoundSessionUuid();
        }
        throw retryError;
      }
    }
  }

  private isRecoverableDaemonSessionError(error: unknown): boolean {
    if (error instanceof DaemonUnavailableError) {
      return true;
    }

    // "Unknown tool" means the frontend advertised a tool the daemon rejects —
    // typically a wrong-build daemon serving this frontend. Reconnecting drops the
    // stale tool cache and re-runs the build-identity handshake (which restarts the
    // daemon to the correct build on skew), so retry once before giving up.
    return this.isDaemonSessionNotFoundError(error) || this.isUnknownToolError(error);
  }

  private isDaemonSessionNotFoundError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Session not found");
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
      // Bind discovery to the session like callTool does. Without this, a
      // recoverable reconnect INSIDE withRecoverableReconnect retries tools/list
      // with empty params against the fresh UNSEEDED transport, which returns the
      // full unfiltered tool list instead of the session-scoped one. Computing the
      // forwarded params inside the operation closure re-seeds the retry after a
      // reconnect (issue #4610).
      const discoveryEpoch = this.discoveryEpoch;
      const result = await this.withRecoverableReconnect(() =>
        this.client!.callDaemonMethod("tools/list", this.withCapabilityProfile(this.withBoundSessionUuid({})))
      );
      const tools = result?.tools ?? [];
      // If a list_changed or bound-session release invalidated this cache WHILE the
      // response was in flight, the response is scoped to the now-stale binding.
      // Return it to THIS caller but leave the cache empty so the next listTools()
      // refetches under the current scope, instead of resurrecting the list the
      // invalidation just cleared (issue #4655).
      if (this.discoveryEpoch === discoveryEpoch) {
        this.cachedTools = tools;
      }
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
    // An omitted `sessionUuid` on the control tool means the connection profile,
    // not the proxy's retained device-routing session. Preserve that distinction
    // after a device has been bound.
    const routingArgs = name === SET_TOOL_CAPABILITY_TOOL_NAME ? args : this.withBoundSessionUuid(args);
    const forwardedArgs = this.withCapabilityProfile(routingArgs);
    // Snapshot the release epoch at forward time. If a session-released signal for
    // the SPECIFIC forwarded UUID lands WHILE this call is in flight, that UUID's
    // recorded epoch advances past this snapshot and the completion path below
    // declines to resurrect the released UUID (issue #4611/#4655). A release of an
    // UNRELATED session bumps the global epoch but not the forwarded UUID's entry,
    // so it does not block remembering the session this call forwarded.
    const callReleaseEpoch = this.releaseEpoch;
    try {
      const result = await this.withRecoverableReconnect(() => this.client!.callTool(name, forwardedArgs));
      this.rememberCapabilityProfile(name, args, result);
      // Remember what was actually forwarded, not the caller's raw args. An
      // implicit sessionless call injects the bound UUID into forwardedArgs and
      // extends the live daemon session in getOrCreateSession(); refreshing the
      // replay lease off forwardedArgs keeps continuous implicit activity from
      // being mistaken for idleness, so a later reconnect re-seeds the still-live
      // session instead of creating an unseeded transport (issue #4610).
      this.rememberSessionUuid(name, forwardedArgs, callReleaseEpoch);
      return result;
    } catch (error) {
      // The success-only rememberSessionUuid above never runs when the handler
      // rejects, but an admitted-then-rejected call still reached
      // getOrCreateSession() and refreshed the LIVE daemon session. Without
      // refreshing the replay lease here too, repeated admitted-but-failed calls
      // let the proxy lease silently expire while the daemon session stays alive,
      // so a later reconnect can no longer replay it (issue #4610).
      this.refreshReplayLeaseAfterAdmittedFailure(name, forwardedArgs, error, callReleaseEpoch);
      // Do NOT clear the binding on a rejected executePlan. A plan can reject
      // *before* the handler runs — capability enforcement or schema parsing in
      // src/server/index.ts — in which case DefaultPlanLifecycleManager
      // .afterExecution() never runs and the daemon session stays LIVE. Forgetting
      // it here would strand a still-live session after a reconnect. The binding is
      // now cleared authoritatively by the daemon's session-released signal
      // (handleDaemonNotification) whenever the session is *actually* released —
      // whether the plan succeeded or failed inside the handler (issue #4610).
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

  private withBoundSessionUuid(args: Record<string, unknown>): Record<string, unknown> {
    // A daemon session released by ordinary heartbeat/idle expiry leaves this
    // remembered binding dangling; replaying its UUID on a later sessionless call
    // would silently recreate the session and reacquire a device without the
    // caller asking for it (issue #4610). Once the replay window has elapsed with
    // no forwarded call (explicit or implicit) refreshing the binding, treat it
    // as retired.
    if (this.isBoundSessionReplayExpired()) {
      this.clearBoundSessionUuid();
    }
    const explicitSessionUuid = typeof args.sessionUuid === "string" && args.sessionUuid.trim().length > 0
      ? args.sessionUuid
      : undefined;
    if (!this.boundSessionUuid || explicitSessionUuid === this.boundSessionUuid) {
      return args;
    }
    if (explicitSessionUuid && this.initialSessionBindingConfigured) {
      throw new Error(
        `MCP connection is bound to device session ${this.boundSessionUuid}; ` +
        `cannot route this call to ${explicitSessionUuid} until the binding is released.`
      );
    }
    if (explicitSessionUuid) {
      return args;
    }
    return {
      ...args,
      sessionUuid: this.boundSessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: this.boundSessionUuid,
    };
  }

  private withCapabilityProfile(args: Record<string, unknown>): Record<string, unknown> {
    if (!this.capabilityProfileUuid) {
      return args;
    }
    return { ...args, [DAEMON_CAPABILITY_PROFILE_PARAM]: this.capabilityProfileUuid };
  }

  private rememberCapabilityProfile(
    name: string,
    requestedArgs: Record<string, unknown>,
    result: unknown,
  ): void {
    if (
      name !== SET_TOOL_CAPABILITY_TOOL_NAME ||
      (typeof requestedArgs.sessionUuid === "string" && requestedArgs.sessionUuid.trim().length > 0)
    ) {
      return;
    }
    const sessionUuid = capabilityProfileUuidFromToolResponse(result);
    if (sessionUuid) {
      this.capabilityProfileUuid = sessionUuid;
      this.discoveryEpoch += 1;
      this.cachedTools = null;
    }
  }

  private isBoundSessionReplayExpired(): boolean {
    if (
      this.initialSessionBindingConfigured ||
      this.boundSessionUuid === undefined ||
      this.boundSessionUuidAt === undefined
    ) {
      return false;
    }
    return this.timer.now() - this.boundSessionUuidAt >= DAEMON_BOUND_SESSION_REPLAY_TTL_MS;
  }

  private clearBoundSessionUuid(): void {
    this.boundSessionUuid = undefined;
    this.boundSessionUuidAt = undefined;
    this.initialSessionBindingConfigured = false;
  }

  // Record that the daemon released a specific session UUID, advancing the global
  // release epoch. An in-flight call that forwarded this exact UUID compares its
  // captured epoch against this entry and declines to resurrect the released
  // session on completion (issue #4655). Scoping the record to the UUID — not a
  // global counter — is what lets an unrelated session's release NOT block
  // remembering the session another in-flight call forwarded.
  private recordSessionReleased(sessionUuid: string): void {
    this.releaseEpoch += 1;
    this.releasedSessionEpochs.set(sessionUuid, this.releaseEpoch);
  }

  // True when the session THIS call forwarded was released at a later epoch than
  // the one captured at forward time — i.e. a release for the forwarded UUID
  // landed WHILE the call was in flight. A release of any OTHER session advances
  // the global epoch but leaves the forwarded UUID's entry untouched, so this
  // stays false for it (issue #4655).
  private wasForwardedSessionReleasedSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): boolean {
    const forwardedUuid = typeof forwardedArgs.sessionUuid === "string"
      ? forwardedArgs.sessionUuid
      : undefined;
    if (forwardedUuid === undefined || forwardedUuid.trim().length === 0) {
      return false;
    }
    return (this.releasedSessionEpochs.get(forwardedUuid) ?? 0) > forwardEpoch;
  }

  // Called with the FORWARDED args (post-withBoundSessionUuid), so an implicit
  // sessionless call that had the bound UUID injected refreshes the replay lease
  // just like an explicit-sessionUuid call, matching the daemon session it just
  // extended (issue #4610).
  private rememberSessionUuid(
    name: string,
    forwardedArgs: Record<string, unknown>,
    callReleaseEpoch: number,
  ): void {
    if (name === "executePlan") {
      this.clearBoundSessionUuid();
      return;
    }
    if (name === SET_TOOL_CAPABILITY_TOOL_NAME) {
      return;
    }
    // A release for the FORWARDED UUID observed WHILE this call was in flight
    // already recorded that UUID's release (handleDaemonNotification).
    // Re-remembering it now would resurrect the freed session and let the next
    // sessionless call recreate it (issue #4611). Scoped to the forwarded UUID so
    // an unrelated session's mid-call release does NOT block this remember (issue
    // #4655); a later explicit call re-binds normally.
    if (this.wasForwardedSessionReleasedSince(forwardedArgs, callReleaseEpoch)) {
      return;
    }
    if (typeof forwardedArgs.sessionUuid === "string" && forwardedArgs.sessionUuid.trim().length > 0) {
      this.boundSessionUuid = forwardedArgs.sessionUuid;
      this.boundSessionUuidAt = this.timer.now();
    }
  }

  // Refresh the replay lease for a call that was ADMITTED and forwarded to the
  // daemon handler but then REJECTED. getOrCreateSession() already refreshed the
  // live daemon session before the handler ran, so the proxy lease must track
  // that liveness even on failure — otherwise repeated admitted-but-failed calls
  // retire a still-live session and a reconnect seeds an unbound transport
  // (issue #4610). Excluded, because none of them refreshed a live session:
  //   - executePlan owns its own binding lifecycle via the release signal; leave
  //     it untouched so a pre-handler plan rejection does not strand the binding.
  //   - a recoverable error (DaemonUnavailableError transport/connect failure,
  //     "Session not found", or an unknown-tool build-skew) never reached the
  //     handler with a live session, so the lease must be allowed to expire.
  private refreshReplayLeaseAfterAdmittedFailure(
    name: string,
    forwardedArgs: Record<string, unknown>,
    error: unknown,
    callReleaseEpoch: number,
  ): void {
    if (name === "executePlan" || name === SET_TOOL_CAPABILITY_TOOL_NAME || this.isRecoverableDaemonSessionError(error)) {
      return;
    }
    // As in rememberSessionUuid: a release of the forwarded UUID observed
    // mid-flight already recorded it, so an admitted-then-rejected call must not
    // re-refresh the released UUID's lease (issue #4611/#4655). The session is
    // gone; resurrecting the lease would replay it on the next sessionless call.
    if (this.wasForwardedSessionReleasedSince(forwardedArgs, callReleaseEpoch)) {
      return;
    }
    if (typeof forwardedArgs.sessionUuid === "string" && forwardedArgs.sessionUuid.trim().length > 0) {
      this.boundSessionUuid = forwardedArgs.sessionUuid;
      this.boundSessionUuidAt = this.timer.now();
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
      const discoveryEpoch = this.discoveryEpoch;
      const result = await this.withRecoverableReconnect(() =>
        this.client!.callDaemonMethod("resources/list", this.withBoundSessionUuid({}))
      );
      const resources = result?.resources ?? [];
      // Discard a response invalidated mid-flight rather than caching the stale
      // scope (issue #4655); the next listResources() refetches.
      if (this.discoveryEpoch === discoveryEpoch) {
        this.cachedResources = resources;
      }
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
      const discoveryEpoch = this.discoveryEpoch;
      const result = await this.withRecoverableReconnect(() =>
        this.client!.callDaemonMethod("resources/list-templates", this.withBoundSessionUuid({}))
      );
      const templates = result?.resourceTemplates ?? [];
      // Discard a response invalidated mid-flight rather than caching the stale
      // scope (issue #4655); the next listResourceTemplates() refetches.
      if (this.discoveryEpoch === discoveryEpoch) {
        this.cachedResourceTemplates = templates;
      }
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
    return await this.withRecoverableReconnect(() =>
      this.client!.readResource(uri, this.withBoundSessionUuid({}))
    );
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
    this.clearBoundSessionUuid();
    this.invalidateCache();
    logger.debug("[DaemonMcpProxy] Disconnected from daemon");
  }
}
