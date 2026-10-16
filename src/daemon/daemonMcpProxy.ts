import {
  SessionBinding,
  type SessionBindingDependencies,
  type SessionBindingPort,
  sessionUuidFromArgs,
  rememberSessionDeviceId,
} from "./proxy/SessionBinding";
import { HeartbeatKeeper, type HeartbeatKeeperPort } from "./proxy/HeartbeatKeeper";
import {
  DaemonLifecycleReconciler,
  type DaemonLifecycleReconcilerDeps,
  runPreflightTransport,
} from "./proxy/DaemonLifecycleReconciler";
import {
  DaemonToolOutcomeUnknownError,
  LifecycleConnectionInFlightError,
  DaemonVersionMismatchError,
  DaemonBuildMismatchError,
  DaemonAssetVersionMismatchError,
  DaemonBoundSessionExpiredError,
  DaemonSessionStalledError,
  DaemonConnectionSessionReleasedError,
  DaemonAmbiguousSessionSelectorError,
  DaemonToolUnavailableError,
  daemonInternalErrors,
  type VersionMismatchReason,
  type BuildMismatchReason,
} from "./proxy/daemonErrors";
export {
  DaemonToolOutcomeUnknownError,
  LifecycleConnectionInFlightError,
  DaemonVersionMismatchError,
  DaemonBuildMismatchError,
  DaemonAssetVersionMismatchError,
  DaemonBoundSessionExpiredError,
  DaemonSessionStalledError,
  DaemonConnectionSessionReleasedError,
  DaemonAmbiguousSessionSelectorError,
  DaemonToolUnavailableError,
  type VersionMismatchReason,
  type BuildMismatchReason,
} from "./proxy/daemonErrors";
import {
  BoundSessionHeartbeat,
  type BoundSessionHeartbeatPort,
} from "./proxy/BoundSessionHeartbeat";
import {
  HeldSessionHeartbeatOutcomes,
  type HeldSessionHeartbeatOutcomesPort,
} from "./proxy/HeldSessionHeartbeatOutcomes";
import {
  HeldSessionLosses,
  type HeldSessionLossesPort,
  type PendingHeldSessionLoss,
} from "./proxy/HeldSessionLosses";
import { ReleaseEpochLedger } from "./proxy/ReleaseEpochLedger";
import { StallProbe, daemonRestartEvidence, type StallProbePort } from "./proxy/StallProbe";
import { ResourceSubscriptions } from "./proxy/ResourceSubscriptions";
import {
  ProxySessionState,
  type DaemonIdleReport,
  type LatestHeartbeatAsk,
  type OtherHeldSession,
  type StallHandoverRecord,
  type TerminalBoundSession,
} from "./proxy/ProxySessionState";
import {
  isRecoverableHandoffOfOwnedSession,
  type NotFoundAnswerOutcome,
} from "./proxy/notFoundDecision";
export {
  RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
  UNREHYDRATED_HANDOFF,
  decideNotFoundAnswer,
  type NotFoundAnswerOutcome,
  type NotFoundAnswerFacts,
} from "./proxy/notFoundDecision";
import {
  isLivenessOwnerConflictError,
  isLivenessOwnershipLostError,
  ackDaemonInstance,
} from "./proxy/livenessErrorPredicates";
import {
  heartbeatIntervalMs,
  heartbeatRequestTimeoutMs,
  resolveLivenessOwnerToken,
  stableLivenessOwnerToken,
  heartbeatLeashMs,
} from "./proxy/heartbeatCadence";
export {
  REUSE_CRITICAL_OPTION_KEYS,
  STARTUP_OPTION_DEFICIT_KEYS,
  startupOptionDeficits,
  mergeDaemonOptions,
} from "./proxy/startupOptions";
import { anyDeviceReadOnlyArgShapeMatches } from "../server/deviceReadOnlyArgShapes";
import { SessionOutsideBoundSessionError } from "../server/deviceOutsideBoundSessionRefusal";
import { isMcpQueueTimeoutError } from "./McpTimeoutError";
import { errorMessage } from "../utils/describeUnknownError";
import { getRemovedToolHint } from "../models/removedTools";
import {
  DaemonBoundSessionLostError,
  DaemonClient,
  DaemonHandshakeMismatchError,
  DaemonRequestNotDeliveredError,
  DaemonShuttingDownError,
  DaemonUnavailableError,
  type DaemonClientLike,
  type DaemonClientFactory,
} from "./client";
import { DaemonManager, type DaemonManagerLike, type DaemonRestartResult } from "./manager";
import { logger } from "../utils/logger";
import { carryToolFailureMark } from "../utils/toolFailureSignal";
import { z } from "zod";
import {
  SOCKET_PATH,
  DAEMON_STARTUP_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  DAEMON_VERSION,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
  DAEMON_ONE_SHOT_CLI_PARAM,
  INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM,
  INTERNAL_ACTIONS_COMPACT_METADATA_PARAM,
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_RELEASED_SESSION_PARAM,
  INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM,
  INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
  DAEMON_RESTART_HANDOFF_TIMEOUT_MS,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_RELEASE_SESSION_METHOD,
  DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
  DAEMON_REGISTER_SESSION_METHOD,
  CLI_SESSION_LIVENESS_POLICY,
  HEARTBEAT_SESSION_LIVENESS_POLICY,
  getCliSessionIdleTimeoutMs,
} from "./constants";
import { getSessionIdleTimeoutMs } from "./sessionLivenessWindows";
import {
  DAEMON_SESSION_NOT_FOUND_CODE,
  releaseReasonFromError,
  daemonInstanceFromError,
  DAEMON_TOOL_UNAVAILABLE_CODE,
  isGatedToolErrorCode,
  DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE,
  PROGRESS_NOTIFICATION_METHOD,
  type DaemonNotification,
  type DaemonOptions,
  type DaemonStatus,
} from "./types";
import {
  listChangedKindForMethod,
  RESOURCE_UPDATED_NOTIFICATION_METHOD,
  type ListChangedKind,
} from "../server/listChangedBroadcast";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../server/sessionReleaseBroadcast";
import { SESSION_OWNERSHIP_LOST_CODE } from "./sessionReleasedDuringCall";
import {
  declaresDeviceSessionSuspect,
  readDeviceSessionSuspectRefusal,
  type DeviceSessionSuspectRefusal,
  getActiveDeviceSelectionFromResult,
  DEVICE_SESSION_ACQUISITION_TOOLS,
  isDeviceSessionAcquisitionTool,
  isDeviceBindingTool,
  readDeviceCleanupInProgressRefusal,
  readTerminalSessionRefusal,
} from "../server/deviceSessionResult";
import { routedSessionUuidFromResult } from "../server/routedSessionMeta";
import {
  toolSelectionProfileUuidFromResponse,
  SET_TOOL_ENABLED_TOOL_NAME,
} from "../features/toolSelection/toolSelectionControl";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import type { IdGenerator } from "../utils/IdGenerator";
import { isExplicitPin, resolveAssetVersion, resolvePinnedVersion } from "../constants/release";
import { SingleFlightInterval } from "./SingleFlightInterval";
import { type SessionReleaseSnapshot } from "./sessionManager";

const { DaemonPreflightConnectionError, HeldSessionNotFoundError } = daemonInternalErrors;

import { raceWithDeadline } from "../utils/raceWithDeadline";
import { exponentialBackoff, normalizeBackoff, type BackoffInput } from "../utils/Backoff";
import { DEVICE_CLEANUP_IN_PROGRESS_CODE } from "./deviceAcquisitionRefusals";
import { readToolEnvelopePayload } from "../server/toolEnvelopePayload";
import {
  type BuildIdentity,
  buildIdentitiesMatch,
  buildIdentityFromStatus,
  getCurrentBuildIdentity,
} from "./buildIdentity";
import { ActionableError, toActionableError } from "../models";
import { BROKER_EXECUTION_RELEASE_TIMEOUT_MS } from "./sessionBroker/provisioning/executionLiveness";
import {
  acquireSessionThroughDaemon,
  DAEMON_RELEASE_BROKER_SESSION_METHOD,
} from "./sessionBrokerProxyAcquisition";
import type { SessionConfig } from "../devices/sessionConfig";
import type {
  SessionBrokerReleaseResult,
  SessionBrokerResult,
} from "../devices/sessionBrokerResult";
import { DeviceControlTransportError, isReplaySafeToolName } from "./deviceControlTransportFailure";
import { McpOverloadError } from "./McpTimeoutError";
import {
  getConnectedStaticToolDefinitions,
  getStaticToolDefinitions,
} from "./staticToolDefinitions";
import {
  isRecoverableDaemonHandoffReason,
  isRecoverableDaemonReleaseReason,
  sessionReleaseReasonFamily,
  SESSION_NOT_FOUND_REASON,
  IDLE_WINDOW_RELEASE_REASON,
  REPLAY_LEASE_EXPIRED_REASON,
} from "./releaseReasons";
import {
  DAEMON_STALLED_CODE,
  LivenessRecovery,
  PROXY_STALLED_CODE,
  TickLatenessClock,
  daemonLifecycleAllowed,
  runWithoutDaemonLifecycle,
  livenessHandoverMessage,
  livenessRecoveryCallWaitMs,
  livenessResumedNotice,
  type DaemonRestartEvidence,
  ownershipConflictLeashMs,
  type OwnerConflictLeash,
  type LivenessHandover,
  type RecoveryAttemptOutcome,
} from "./proxyLivenessRecovery";

export { DaemonRestartDeferredError } from "./daemonRestartAdmission";
const CLI_SESSION_FINALIZATION_TIMEOUT_MS = 2_000;

const SESSION_BROKER_PROXY_CLIENT_NAME = "auto-mobile-session-broker-proxy";
const COLD_RESOURCE_CONNECT_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;
// These inventory tools never operate a device or mint a device session. They
// normally retain a live binding's policy, but after that binding is terminally
// released they must be able to discover the stable target for an explicit
// getAndroid/getApple reacquisition (#7144).
const SESSIONLESS_DEVICE_DISCOVERY_TOOLS = ["listDevices", "listDeviceImages"] as const;
/** Finalized recordings a proxy remembers the starting session of (oldest dropped first). */
const MAX_FINALIZED_RECORDING_OWNERS = 64;

/**
 * A tool definition's read classification, generated from the tool's `deviceReadOnly`
 * registration (#10971): the tool only watches a device, which never requires a session.
 */
const DEVICE_READ_ONLY_META_KEY = "automobile/deviceReadOnly";
const DEVICE_READ_ONLY_ARGS_META_KEY = "automobile/deviceReadOnlyArgs";

export function isDeviceInventoryTool(name: unknown): boolean {
  return (
    typeof name === "string" &&
    (SESSIONLESS_DEVICE_DISCOVERY_TOOLS as readonly string[]).includes(name)
  );
}

/**
 * Whether a call the daemon refused as suspect may be forwarded once more after recovery.
 *
 * Every tool call reaches a suspect check at session admission, before its handler runs:
 * `admitIssuedSessionForAutomation` in `src/server/index.ts` (plain tools) or
 * `src/server/toolRegistry.ts` (device tools, whose earlier enforcement returns at once when a
 * sessionUuid is given). Plan and critical-section steps wrap a nested refusal in their own error,
 * so the suspect code at the top of a result always means "nothing ran". The exceptions are tools
 * whose handler binds or reuses a device session through `DevicePool.bindOrReuseDeviceSession`,
 * which can reach the same check after starting or binding a device: device acquisition and
 * `setActiveDevice`. Those are never retried, nor is a refusal for a session other than the one
 * forwarded (a label-derived session).
 */
function isSuspectRefusalRetryable(
  name: string,
  forwardedSessionUuid: string,
  refusal: DeviceSessionSuspectRefusal,
): boolean {
  return (
    refusal.sessionUuid === forwardedSessionUuid &&
    !isDeviceSessionAcquisitionTool(name) &&
    name !== "setActiveDevice"
  );
}

/** A forwarded tool call's result, with the suspect refusal the proxy may retry it after. */
interface ForwardedToolCall {
  result: any;
  forwardedSessionUuid?: string;
  retryableSuspectRefusal?: DeviceSessionSuspectRefusal;
}

/** The tool name when replaying it could repeat a device action, else undefined. */
function nonIdempotentToolName(name: string): string | undefined {
  return isReplaySafeToolName(name) || isDeviceInventoryTool(name) ? undefined : name;
}

/** Failures that give no evidence the forwarded session is still live and admitted. */
function isUnprovenSessionAdmissionError(error: unknown): boolean {
  return (
    error instanceof DaemonBoundSessionExpiredError ||
    error instanceof DaemonBoundSessionLostError ||
    error instanceof DaemonToolOutcomeUnknownError
  );
}

function isFreshSessionScreenshotUri(uri: string, sessionUuid: string): boolean {
  return uri === `automobile:device-session/${sessionUuid}/screenshot`;
}

// A tool-output artifact read (`automobile:tool-output/<id>`) is a plain host
// file read routed through the session-independent resource registry — no device
// access and no session data. So unlike the fresh-screenshot exemption it is not
// scoped to any session, and it must stay retrievable after a terminal release
// (e.g. executePlan auto-releases its bound session, then emits an artifact
// resourceUri that would otherwise be fenced). Kept in lockstep with the
// `automobile:tool-output/` prefix in src/server/toolOutputResources.ts.
function isToolOutputResourceUri(uri: string): boolean {
  return uri.startsWith("automobile:tool-output/");
}

// The session UUID embedded in a session-scoped observation resource URI, or
// undefined for any other URI. Kept in lockstep with RESOURCE_URIS in
// src/server/observationResources.ts.
function sessionScopedObservationUriSessionUuid(uri: string): string | undefined {
  const match = uri.match(
    /^automobile:(?:observation\/session\/([^/]+)\/latest(?:\/screenshot)?|device-session\/([^/]+)\/screenshot)$/,
  );
  return match?.[1] ?? match?.[2];
}

/**
 * Whether a resource URI names a device session at all: every `automobile:device-session/<id>/...`
 * and `automobile:observation/session/<id>/...` form, whatever follows the session segment. These
 * two prefixes are where the server registers its session-scoped templates
 * (test/daemon/proxySessionNamingResourceFence.test.ts checks every registered template against
 * this), so a new session-scoped resource is covered without listing it here.
 */
export function resourceUriNamesSession(uri: string): boolean {
  return /^automobile:(?:device-session|observation\/session)\/[^/?#]+/.test(uri);
}

function isSessionOwnershipLostError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === SESSION_OWNERSHIP_LOST_CODE
  );
}

/** Append the resumed-session warning as one more text block of a tool result (#10989). */
function withResumedNotice(
  result: unknown,
  notice: ReturnType<typeof livenessResumedNotice>,
): unknown {
  if (
    result === null ||
    typeof result !== "object" ||
    !("content" in result) ||
    !Array.isArray(result.content)
  ) {
    return result;
  }
  return carryToolFailureMark(result, {
    ...result,
    content: [...result.content, { type: "text", text: JSON.stringify(notice) }],
  });
}

/** A live session the daemon reports this proxy's stable token owns (#10990). */
const tokenOwnedSessionSchema = z.object({
  sessionId: z.string().min(1),
  deviceId: z.string().optional().catch(undefined),
  platform: z.enum(["android", "ios"]).optional().catch(undefined),
  /**
   * The daemon's record of the session's last tool use. Unknown means no use this proxy can vouch
   * for: the held session then stays only while the daemon reports it in use.
   */
  lastUsedAt: z.number().catch(Number.NEGATIVE_INFINITY),
});
type TokenOwnedSession = z.infer<typeof tokenOwnedSessionSchema>;

/** The daemon's `daemon/tokenOwnedSessions` answer; malformed entries are skipped. */
function parseTokenOwnedSessions(result: unknown): TokenOwnedSession[] {
  const parsed = z.object({ sessions: z.array(z.unknown()) }).safeParse(result);
  if (!parsed.success) {
    return [];
  }
  return parsed.data.sessions.flatMap((entry) => {
    const session = tokenOwnedSessionSchema.safeParse(entry);
    return session.success ? [session.data] : [];
  });
}

/**
 * Callback for a relayed `notifications/progress` tick (issue #6205), mirroring
 * `ProgressCallback` in `src/server/toolRegistry.ts` without importing the
 * server's tool-registry module from the daemon layer.
 */
export type DaemonProxyProgressCallback = (
  progress: number,
  total?: number,
  message?: string,
) => void;

/**
 * Configuration for the DaemonMcpProxy
 */
export interface DaemonMcpProxyConfig {
  /** Whether to automatically start the daemon if not running */
  autoStartDaemon?: boolean;
  /**
   * Environment the shared-namespace guard reads before an automatic restart (#11252). Production
   * entry points pass `process.env`; unset skips the guard, so injected-manager tests are unaffected.
   */
  lifecycleNamespaceEnv?: NodeJS.ProcessEnv;
  /** Socket path for daemon communication */
  socketPath?: string;
  /** Connection timeout in milliseconds */
  connectionTimeoutMs?: number;
  /** Factory for creating daemon clients (for testing) */
  clientFactory?: DaemonClientFactory;
  /** Socket-owner identity probe; custom client factories inject this separately. */
  daemonStatusProbe?: () => Promise<DaemonStatus>;
  /** Observation-only socket availability probe; injectable for deterministic tests. */
  daemonAvailabilityProbe?: (socketPath: string) => Promise<boolean>;
  /** Custom daemon manager (for testing) */
  daemonManager?: DaemonManagerLike;
  /** Requested daemon-global options plus connection presentation options. */
  daemonOptions?: DaemonOptions;
  /** Timer for restart cooldown checks and bound-session heartbeats. */
  timer?: Timer;
  /** Total wait for a bind refused as `device_cleanup_in_progress` (#10960); 0 disables it. */
  cleanupWaitBudgetMs?: number;
  /** Poll cadence while a refused bind waits for cleanup; defaults to 250ms x2, capped at 5s. */
  cleanupWaitBackoff?: BackoffInput;
  /** Daemon session heartbeat timeout used to derive a safe cadence when unset. */
  heartbeatTimeoutMs?: number;
  /** Explicit bound-session heartbeat cadence; defaults to half the timeout or 2s. */
  heartbeatIntervalMs?: number;
  /** This client's build identity (for testing; defaults to the current process build) */
  buildIdentity?: BuildIdentity;
  /** This client's version for the daemon version gate (defaults to DAEMON_VERSION; injectable for testing) */
  clientVersion?: string;
  /** Existing device-pool session bound before the first discovery request. */
  initialSessionUuid?: string;
  /**
   * Harness-supplied stable liveness-owner token (`--liveness-owner-token`). A
   * proxy restarted with the same token resumes the sessions it owned instead of
   * being locked out by the daemon's live-owner rule (#10050). When absent the
   * proxy mints a per-process token from `idGenerator`.
   */
  livenessOwnerToken?: string;
  /** Mints the per-process liveness-owner token when none is supplied (injectable for tests). */
  idGenerator?: IdGenerator;
  /**
   * Supplies the static tool surface served by `listAdvertisedTools()` before a
   * daemon connection exists (issue #5879). Defaults to the committed
   * `schemas/tool-definitions.json`; injectable for testing.
   */
  staticToolDefinitionsProvider?: () => ProxiedToolDefinition[];
  /**
   * Supplies static schemas eligible to supplement a connected daemon's live
   * list. Defaults to the static catalog without plan-only definitions.
   */
  connectedStaticToolDefinitionsProvider?: (
    daemonOptions?: DaemonOptions,
  ) => ProxiedToolDefinition[];
  /**
   * Private live-acceptance configuration. It is set only while constructing
   * the dedicated harness proxy; MCP tool callers cannot set it.
   *
   * Its signed internal arguments control discovery presentation where needed
   * and retain structured tool payloads for the acceptance contract.
   */
  acceptanceDiscovery?: {
    order: "forward" | "reverse";
    capability: string;
  };
  /**
   * Set only by the one-shot `--cli` runner (#11096): every tool call carries
   * {@link DAEMON_ONE_SHOT_CLI_PARAM}, so the daemon treats this connection's acquisitions as
   * anonymous and repeated `--cli` acquisitions of one device stay idempotent (#2421).
   * Long-lived MCP proxies leave it unset and stay identified by their connection.
   */
  oneShotCli?: boolean;
}

/**
 * Tool definition from daemon
 */
export interface ProxiedToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  // Passed through verbatim from the daemon (live path) or the committed static
  // surface (cold path) — e.g. the MCP Apps UI pointer `_meta.ui.resourceUri`
  // (issue #4669). Non-Apps hosts ignore it.
  _meta?: Record<string, unknown>;
}

function connectedStaticToolDefinitionsProvider(
  config: DaemonMcpProxyConfig,
): (daemonOptions?: DaemonOptions) => ProxiedToolDefinition[] {
  return (
    config.connectedStaticToolDefinitionsProvider ??
    config.staticToolDefinitionsProvider ??
    getConnectedStaticToolDefinitions
  );
}

function daemonAvailabilityProbe(
  config: DaemonMcpProxyConfig,
): (socketPath: string) => Promise<boolean> {
  return config.daemonAvailabilityProbe ?? ((socketPath) => DaemonClient.isAvailable(socketPath));
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
/**
 * Longest a bind waits out a `device_cleanup_in_progress` refusal: the recording-finalize cap
 * (about 120 s, #10957) plus slack for the restores around it. Shared with the JUnit runner and
 * XCTestRunner through `finalizeWait.waitBudgetMs` in `test/fixtures/refusal-wire-hints/hints.json`
 * (#11360): change them together.
 */
export const DEVICE_CLEANUP_WAIT_BUDGET_MS = 150_000;

/** Short growing polls notice early cleanup; its remaining-cap hint is an upper bound (#11900). */
const DEVICE_CLEANUP_BACKOFF = exponentialBackoff({
  initialDelayMs: 250,
  multiplier: 2,
  maxDelayMs: 5_000,
});

/** A hint or backoff near zero must not busy-poll the daemon (#11900). */
const DEVICE_CLEANUP_POLL_FLOOR_MS = 50;

export class DaemonMcpProxy {
  private readonly sessionState = new ProxySessionState();
  private readonly lifecycleReconciler: DaemonLifecycleReconciler;
  private readonly resourceSubscriptionManager: ResourceSubscriptions;
  private client: DaemonClientLike | null = null;
  private closePromise: Promise<void> | undefined;
  private config: DaemonMcpProxyConfig;
  private daemonManager: DaemonManagerLike;
  private clientFactory: DaemonClientFactory;
  private readonly daemonStatusProbe?: () => Promise<DaemonStatus>;
  private readonly daemonAvailabilityProbe: (socketPath: string) => Promise<boolean>;
  private reconciliationSnapshot?: Promise<DaemonStatus>;
  // Connection-scoped: tools/list_changed invalidates status, but does not replace its daemon.
  private structuredSessionNotFound = false;
  private readonly timer: Timer;
  private readonly heartbeatKeeper: SingleFlightInterval;
  private readonly proxyHeartbeatKeeper: HeartbeatKeeper;
  private readonly sessionBinding: SessionBinding;
  private readonly heartbeatLeashMs: number;
  private readonly heartbeatIntervalMs: number;
  /**
   * Whether the recurring bound-session heartbeat keeper has been started for the
   * current binding. Gates the awaited establishment heartbeat (issue #5637) to
   * the FIRST connection only: once the keeper is running it owns every
   * subsequent tick, so a later reconnect must not send an extra, un-coalesced
   * heartbeat.
   */
  private heartbeatKeeperStarted = false;
  private get recoveryNotFoundOutcomes(): Map<
    string,
    { outcome: NotFoundAnswerOutcome; releaseReason: string | undefined }
  > {
    return this.sessionState.recoveryNotFoundOutcomes;
  }
  private get notFoundWindows(): Map<string, { since: number; handoffs: Set<string> }> {
    return this.sessionState.notFoundWindows;
  }
  private get notFoundStopped(): Set<string> {
    return this.sessionState.notFoundStopped;
  }
  private get sessionDaemonInstances(): Map<string, string> {
    return this.sessionState.sessionDaemonInstances;
  }
  /**
   * The connection that was established with sessions already held, and the sessions the daemon
   * has not yet answered a heartbeat for on it: the latest binding (#11529) and every session held
   * besides it (#11557). That first answer comes from the daemon this proxy just connected to, on
   * a socket that has carried nothing else for the session: a not-found there is about the
   * session, never a stale connection.
   */
  private ownershipReestablishment:
    | { client: DaemonClientLike; sessionUuids: Set<string> }
    | undefined;
  private get latestHeartbeatAsked(): LatestHeartbeatAsk | undefined {
    return this.sessionState.latestHeartbeatAsked;
  }
  private set latestHeartbeatAsked(value: LatestHeartbeatAsk | undefined) {
    this.sessionState.latestHeartbeatAsked = value;
  }
  /**
   * Whether this connection already declared its bound session CLI-owned
   * (issue #6870 review). Once declared, this proxy's remaining heartbeats must
   * keep carrying the CLI marker: an ordinary heartbeat now restores the strict
   * contract on the daemon, and a keeper tick racing process exit would undo the
   * declaration the invocation just made.
   */
  private cliSessionLivenessDeclared = false;
  private get livenessOwnershipClaimSent(): boolean {
    return this.sessionState.livenessOwnershipClaimSent;
  }
  private set livenessOwnershipClaimSent(value: boolean) {
    this.sessionState.livenessOwnershipClaimSent = value;
  }
  private get otherHeldSessions(): Map<string, OtherHeldSession> {
    return this.sessionState.otherHeldSessions;
  }
  private get livenessSupersessionLogged(): boolean {
    return this.sessionState.livenessSupersessionLogged;
  }
  private set livenessSupersessionLogged(value: boolean) {
    this.sessionState.livenessSupersessionLogged = value;
  }
  private get livenessConflictLogged(): Set<string> {
    return this.sessionState.livenessConflictLogged;
  }
  /** How long a refused claim keeps retrying: the other owner's lease plus its grace (#10053). */
  private readonly ownershipConflictLeashMs: number;
  /**
   * The daemon's idle window, which retires the remembered binding and evicts abandoned held
   * sessions. Read from the same `AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS` override the daemon reads.
   */
  private readonly boundSessionReplayTtlMs = getSessionIdleTimeoutMs();
  private get latestBindingConflict(): ({ sessionUuid: string } & OwnerConflictLeash) | undefined {
    return this.sessionState.latestBindingConflict;
  }
  private set latestBindingConflict(
    value: ({ sessionUuid: string } & OwnerConflictLeash) | undefined,
  ) {
    this.sessionState.latestBindingConflict = value;
  }
  private get initialSessionAwaitingFirstCall(): boolean {
    return this.sessionState.initialSessionAwaitingFirstCall;
  }
  private set initialSessionAwaitingFirstCall(value: boolean) {
    this.sessionState.initialSessionAwaitingFirstCall = value;
  }
  private get releaseSurfacedFor(): string | undefined {
    return this.sessionState.releaseSurfacedFor;
  }
  private set releaseSurfacedFor(value: string | undefined) {
    this.sessionState.releaseSurfacedFor = value;
  }
  /** Held terminal losses awaiting one platform-only control answer, in loss order (#12090). */
  private readonly heldSessionLosses: HeldSessionLosses;
  private readonly heartbeatOutcomes: HeldSessionHeartbeatOutcomes;
  private readonly boundHeartbeat: BoundSessionHeartbeat;
  private get pendingHeldSessionPlatformLosses(): Map<string, PendingHeldSessionLoss> {
    return this.heldSessionLosses.pending;
  }
  private get plainRestartSessionLosses(): Map<string, string> {
    return this.sessionState.plainRestartSessionLosses;
  }
  /** Bounded per-session recovery when heartbeat acknowledgements stop (#10053). */
  private readonly livenessRecovery: LivenessRecovery;
  /** The call-wait bound of the current stretch of liveness recovery (#10508). */
  private livenessRecoveryCallWait: { episode: number; deadline: number } | undefined;
  /** Detects this proxy's own tick firing later than the lease allows. */
  private readonly tickLateness: TickLatenessClock;
  private get livenessAcks(): Map<string, number> {
    return this.sessionState.livenessAcks;
  }
  private get daemonIdleReports(): Map<string, DaemonIdleReport> {
    return this.sessionState.daemonIdleReports;
  }
  /** Device each held session runs on, learned from acquisition results and explicit calls. */
  private readonly sessionDeviceIds = new Map<string, string>();
  /** Platform each acquired session runs on; absent when its result did not describe one. */
  private readonly sessionPlatforms = new Map<string, "android" | "ios">();
  private get stallHandovers(): Map<string, StallHandoverRecord> {
    return this.sessionState.stallHandovers;
  }
  private get resumedStallNotices(): Map<
    string,
    { handover: LivenessHandover; restart?: DaemonRestartEvidence }
  > {
    return this.sessionState.resumedStallNotices;
  }
  private get ackedDaemonInstance(): string | undefined {
    return this.sessionState.ackedDaemonInstance;
  }
  private set ackedDaemonInstance(value: string | undefined) {
    this.sessionState.ackedDaemonInstance = value;
  }
  /** Keeps probing a daemon that stalled past recovery, so one that resumes is heard (#10989). */
  private readonly stallResumeProbe: SingleFlightInterval;
  private readonly stallProbe: StallProbe;
  private get pendingSessionLosses(): Map<string, LivenessHandover> {
    return this.sessionState.pendingSessionLosses;
  }
  private readonly livenessHandoverListeners = new Set<(handover: LivenessHandover) => void>();
  /** Tool calls currently awaiting an answer on each daemon connection. */
  private readonly toolCallsInFlight = new WeakMap<DaemonClientLike, number>();
  /** Resolved when the last tool call in flight on a draining connection settles. */
  private readonly toolCallsSettled = new WeakMap<DaemonClientLike, PromiseWithResolvers<void>>();
  /**
   * Tool calls forwarded under each session UUID that have not finished yet. A session with a call
   * in flight is in use, so neither the replay lease of the latest binding nor a held session's
   * idle eviction may retire it; the idle clock restarts when its last call ends.
   */
  private readonly sessionCallsInFlight = new Map<string, number>();
  /** Connections a liveness attempt saw fail at the transport level: dead, with nothing to lose. */
  private readonly deadSocketClients = new WeakSet<DaemonClientLike>();
  /** Stable for this proxy instance, including all transport reconnects. */
  private readonly livenessOwnerToken: string;
  private readonly buildIdentity: BuildIdentity;
  private readonly clientVersion: string;
  private readonly clientAssetVersion: string | null;
  private connecting: Promise<void> | null = null;
  /** Underlying connection work retained even when close rejects the public single-flight waiter. */
  private connectionAttemptWork: Promise<void> | null = null;
  private connectingAllowsLifecycle = false;
  private connectionCloseReject: ((reason?: unknown) => void) | null = null;
  /**
   * A `daemon-shutdown` release arrives before the old daemon closes its socket.
   * Calls admitted for replacement acquisition wait on this peer-close barrier
   * instead of reconnecting to the still-reachable but quiesced incarnation.
   */
  private daemonShutdownDisconnect: Promise<void> | null = null;
  /**
   * When the daemon last announced a clean `daemon-shutdown` release (proxy clock). A
   * `daemon_stalled` handover with no acknowledgement since is the expected outcome of that
   * shutdown, not a daemon fault, so it is logged below error level (#11189).
   */
  private daemonShutdownAnnouncedAt: number | undefined;
  private resolveDaemonShutdownDisconnect: (() => void) | null = null;
  private connected: boolean = false;
  private closing: boolean = false;
  private get boundSessionUuid(): string | undefined {
    return this.sessionState.boundSessionUuid;
  }
  private set boundSessionUuid(value: string | undefined) {
    this.sessionState.boundSessionUuid = value;
  }
  private get boundSessionUuidAt(): number | undefined {
    return this.sessionState.boundSessionUuidAt;
  }
  private set boundSessionUuidAt(value: number | undefined) {
    this.sessionState.boundSessionUuidAt = value;
  }
  private get boundSessionFromResultMint(): boolean {
    return this.sessionState.boundSessionFromResultMint;
  }
  private set boundSessionFromResultMint(value: boolean) {
    this.sessionState.boundSessionFromResultMint = value;
  }
  // Every device session this connection has bound over its lifetime and not yet
  // seen released. `boundSessionUuid` only tracks the LATEST binding, so acquiring
  // a second device (e.g. getApple after getAndroid) moves it off the first
  // session. A fresh-screenshot resource read names its session in the URI, and it
  // must route to that owning session — not the latest binding — or the daemon
  // seeds the loopback with the wrong session and denies the just-established
  // owner with SCREENSHOT_ACCESS_DENIED (issue #5663). Membership here is what
  // authorizes owner-routing; a session this connection never bound is absent, so
  // a foreign read still forwards this connection's own binding and stays denied.
  /**
   * Recordings a session this proxy held finalized when it was released, by id, to the session
   * that started them (#11362). The release notification names them; only this connection learns
   * them, so only it can retrieve them later.
   */
  private readonly finalizedRecordingOwners = new Map<string, string>();
  private readonly ownedDeviceSessions = new Set<string>();
  private get claimableSessions(): Set<string> {
    return this.sessionState.claimableSessions;
  }
  /** The durable session broker result exposed by this proxy. */
  private sessionBrokerResult: SessionBrokerResult | undefined;
  /** A ready broker receipt currently held by the heartbeat keeper. */
  private sessionBrokerBinding: { requestId: string; sessionUuid: string } | undefined;
  /** Broker sessions are excluded from generic release until their broker release settles. */
  private readonly sessionBrokerSessions = new Map<string, string>();
  /** Aborts preparation and same-request status polling when the proxy closes. */
  private sessionBrokerAcquisitionAbort: AbortController | undefined;
  /**
   * Aborts every tool call and resource read this proxy has in flight when it closes (#11642).
   * Each one's daemon request is cancelled on its own socket (`daemon/cancelRequest`), so nothing
   * of this proxy's is left ahead of the managed execution release in the socket's queue.
   */
  private readonly closeAbort = new AbortController();
  private get terminalBoundSession(): TerminalBoundSession | undefined {
    return this.sessionState.terminalBoundSession;
  }
  private set terminalBoundSession(value: TerminalBoundSession | undefined) {
    this.sessionState.terminalBoundSession = value;
  }
  /** A recoverable daemon release needs a replacement transport, not a UUID fence. */
  private recoverableBoundSessionHandoff: string | undefined;
  /** Only a device-restart handoff presents the binding on a fresh acquisition. */
  private recoverableBoundSessionHandoffIsDeviceRestart = false;
  private get initialSessionBindingConfigured(): boolean {
    return this.sessionState.initialSessionBindingConfigured;
  }
  private set initialSessionBindingConfigured(value: boolean) {
    this.sessionState.initialSessionBindingConfigured = value;
  }
  // A connection-level tool-selection profile is not a daemon device session. It
  // survives executePlan's device-session release and is forwarded through the
  // socket only when no explicit/remembered routing session is in use.
  private toolSelectionProfileUuid: string | undefined;
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
  private readonly releaseLedger = new ReleaseEpochLedger();
  private get releasedSessionEpochs(): Map<string, number> {
    return this.releaseLedger.releasedSessionEpochs;
  }
  private get releasedSessionReasons(): Map<string, string> {
    return this.releaseLedger.releasedSessionReasons;
  }
  private get activeReleaseEpochReferences(): Map<string, number> {
    return this.releaseLedger.activeReleaseEpochReferences;
  }
  // Monotonic counter bumped whenever a daemon push invalidates a discovery cache
  // or the session binding mid-flight (list_changed nulls a cache; a bound-session
  // release changes the session scope). A `tools/list` / `resources/list` captures
  // this at forward time and, if it has advanced by completion, declines to store
  // the now-stale response into the cache the invalidation just cleared — the next
  // discovery refetches under the current scope (issue #4655).
  private discoveryEpoch: number = 0;

  // Supplies the static tool surface for listAdvertisedTools() before a daemon
  // connection exists (issue #5879).
  private readonly staticToolDefinitionsProvider: () => ProxiedToolDefinition[];
  private readonly connectedStaticToolDefinitionsProvider: (
    daemonOptions?: DaemonOptions,
  ) => ProxiedToolDefinition[];
  // Set when listAdvertisedTools() served the static surface without a live
  // connection. On the next successful connect the proxy emits a tools
  // list_changed so the client re-fetches the accurate (session-scoped) list.
  private servedStaticToolList = false;
  // Set when listAdvertisedResources()/listAdvertisedResourceTemplates() served
  // a cold (empty/cached) roster without a live connection. On the next connect
  // the proxy emits a resources list_changed so the client re-fetches the real
  // resources (issue #5879 review — a host that enumerates resources on init
  // must not block on a wedged daemon before the first tool call).
  private servedStaticResourceList = false;
  private backgroundConnectRetry: NodeJS.Timeout | null = null;
  private backgroundConnectRetryAttempt = 0;
  private connectedFallbackReconcile: NodeJS.Timeout | null = null;
  private connectedFallbackReconcileAttempt = 0;

  // Cached definitions from daemon
  private cachedTools: ProxiedToolDefinition[] | null = null;
  private cachedResources: ProxiedResourceDefinition[] | null = null;
  private cachedResourceTemplates: ProxiedResourceTemplate[] | null = null;
  private get resourceSubscriptions(): Set<string> {
    return this.resourceSubscriptionManager.resourceSubscriptions;
  }

  private get resourceUpdatedListeners(): Set<(uri: string) => void> {
    return this.resourceSubscriptionManager.resourceUpdatedListeners;
  }

  private get resourceSubscriptionSync(): Promise<void> {
    return this.resourceSubscriptionManager.resourceSubscriptionSync;
  }
  private set resourceSubscriptionSync(value: Promise<void>) {
    this.resourceSubscriptionManager.resourceSubscriptionSync = value;
  }

  // Listeners for daemon-forwarded list-changed notifications (issue #3223),
  // fired after the matching cache is invalidated so a re-fetch is never stale.
  private readonly listChangedListeners = new Set<(kind: ListChangedKind) => void>();
  // A token can be reused by concurrent callers, and a new connection can
  // reuse a request id. Scope listeners to the client connection, then match
  // both the daemon request id and echoed caller token.
  private readonly progressListeners = new Map<
    DaemonClientLike,
    Map<string, { progressToken: string | number; listener: DaemonProxyProgressCallback }>
  >();
  // Releases this proxy's handler on the current client. Needed because a
  // clientFactory may return a shared/reused client (test fakes do); without it
  // every reconnect would stack another handler on that client.
  private notificationUnsubscribe: (() => void) | null = null;
  // A daemon can close an idle socket without any request failing. Keep the
  // proxy's connection state synchronized with that passive transport loss.
  private connectionClosedUnsubscribe: (() => void) | null = null;

  constructor(config: DaemonMcpProxyConfig = {}) {
    this.config = {
      autoStartDaemon: true,
      socketPath: SOCKET_PATH,
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
      ...config,
    };
    this.daemonManager = config.daemonManager ?? new DaemonManager();
    this.clientFactory =
      config.clientFactory ??
      (() => new DaemonClient(this.config.socketPath, this.config.connectionTimeoutMs));
    const proxy = this;
    this.resourceSubscriptionManager = new ResourceSubscriptions({
      get client() {
        return proxy.client;
      },
      get connected() {
        return proxy.connected;
      },
      get closing() {
        return proxy.closing;
      },
      throwIfClosing: () => this.throwIfClosing(),
      connectResourceSubscriptionsInBackground: () =>
        this.connectResourceSubscriptionsInBackground(),
      assertConnectedClient: (client) => this.assertConnectedClient(client),
    });
    this.lifecycleReconciler = new DaemonLifecycleReconciler(this.createLifecycleReconcilerDeps());
    this.daemonStatusProbe = this.createStatusProbe(config);
    this.daemonAvailabilityProbe = daemonAvailabilityProbe(config);
    this.timer = config.timer ?? defaultTimer;
    this.heartbeatLeashMs = heartbeatLeashMs(config);
    this.heartbeatIntervalMs = heartbeatIntervalMs(config);
    this.ownershipConflictLeashMs = ownershipConflictLeashMs(
      this.heartbeatLeashMs,
      this.heartbeatIntervalMs,
    );
    this.tickLateness = new TickLatenessClock(this.heartbeatIntervalMs);
    this.livenessRecovery = this.createLivenessRecovery();
    this.livenessOwnerToken = resolveLivenessOwnerToken(config);
    this.heartbeatOutcomes = new HeldSessionHeartbeatOutcomes({
      timer: this.timer,
      otherHeldSessions: this.sessionState.otherHeldSessions,
      notFoundWindows: this.sessionState.notFoundWindows,
      livenessAcks: this.livenessAcks,
      livenessConflictLogged: this.livenessConflictLogged,
      livenessRecovery: this.livenessRecovery,
      ownershipConflictLeashMs: this.ownershipConflictLeashMs,
      port: this.createHeldSessionHeartbeatOutcomesPort(),
    });
    this.heldSessionLosses = new HeldSessionLosses(
      this.sessionPlatforms,
      this.createHeldSessionLossesPort(),
    );
    this.boundHeartbeat = new BoundSessionHeartbeat({
      timer: this.timer,
      state: this.sessionState,
      ownedDeviceSessions: this.ownedDeviceSessions,
      ownershipConflictLeashMs: this.ownershipConflictLeashMs,
      heartbeatOutcomes: this.heartbeatOutcomes,
      heldSessionLosses: this.heldSessionLosses,
      port: this.createBoundSessionHeartbeatPort(),
    });
    this.sessionBinding = new SessionBinding(this.createSessionBindingDependencies());
    this.proxyHeartbeatKeeper = new HeartbeatKeeper({
      timer: this.timer,
      state: this.sessionState,
      tickLateness: this.tickLateness,
      livenessRecovery: this.livenessRecovery,
      heartbeatLeashMs: this.heartbeatLeashMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      boundSessionReplayTtlMs: this.boundSessionReplayTtlMs,
      port: this.createHeartbeatKeeperPort(),
    });
    this.heartbeatKeeper = new SingleFlightInterval(
      this.timer,
      this.heartbeatIntervalMs,
      () => this.runBoundSessionHeartbeatTick(),
      {
        stopTimeoutMs: CLI_SESSION_FINALIZATION_TIMEOUT_MS,
        onError: (error) => {
          logger.warn(`[DaemonMcpProxy] Bound-session heartbeat failed: ${error}`);
        },
      },
    );
    this.stallProbe = new StallProbe({
      timer: this.timer,
      stallHandovers: this.sessionState.stallHandovers,
      port: this.createStallProbePort(),
    });
    this.stallResumeProbe = new SingleFlightInterval(
      this.timer,
      this.heartbeatIntervalMs,
      () => this.stallProbe.probeStalledSessions(),
      {
        stopTimeoutMs: CLI_SESSION_FINALIZATION_TIMEOUT_MS,
        onError: (error) => {
          logger.warn(`[DaemonMcpProxy] Stalled-daemon probe failed: ${error}`);
        },
      },
    );
    if (
      typeof config.initialSessionUuid === "string" &&
      config.initialSessionUuid.trim().length > 0
    ) {
      this.bindStartupSession(config.initialSessionUuid.trim());
    }
    this.staticToolDefinitionsProvider =
      config.staticToolDefinitionsProvider ?? getStaticToolDefinitions;
    this.connectedStaticToolDefinitionsProvider = connectedStaticToolDefinitionsProvider(config);
    this.buildIdentity = config.buildIdentity ?? getCurrentBuildIdentity();
    this.clientVersion = config.clientVersion ?? DAEMON_VERSION;
    this.clientAssetVersion = isExplicitPin() ? resolveAssetVersion(resolvePinnedVersion()) : null;
  }

  /** Test-only seam for checking active progress listener cleanup. */
  getProgressListenerCountForTesting(): number {
    return this.progressListeners.size;
  }

  /** Test-only seam for building a tool-unavailable error. */
  buildToolUnavailableErrorForTesting(
    name: string,
    daemonRejection?: string,
    daemonGated = false,
  ): Promise<Error> {
    return this.toolUnavailableError(name, daemonRejection, daemonGated);
  }

  /**
   * Ensure we have a connection to the daemon
   * Will auto-start daemon if configured and daemon is not running
   */
  async ensureConnected(): Promise<void> {
    if (this.closing) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
    const daemonShutdownDisconnect = this.daemonShutdownDisconnect;
    if (daemonShutdownDisconnect) {
      await daemonShutdownDisconnect;
      if (this.closing) {
        throw new DaemonUnavailableError("MCP proxy is closing");
      }
    }
    if (this.connected && this.client) {
      return;
    }

    try {
      const connecting = this.connectSingleFlight(this.connectionAllowsLifecycle());
      try {
        await connecting;
      } finally {
        this.clearConnectionAttempt(connecting);
      }
    } catch (error) {
      await this.handleConnectionFailure(error);
    }
  }

  /** Bind a client-declared startup session that this proxy claims and heartbeats from now on. */
  private bindStartupSession(sessionUuid: string): void {
    this.boundSessionUuid = sessionUuid;
    this.boundSessionUuidAt = this.timer.now();
    this.initialSessionBindingConfigured = true;
    this.initialSessionAwaitingFirstCall = true;
    this.ownedDeviceSessions.add(sessionUuid);
    this.claimableSessions.add(sessionUuid);
  }

  /**
   * Prepare one durable broker request before serving MCP. The helper owns bounded same-request
   * status recovery; a ready result is bound, claimed and heartbeated here.
   */
  async acquireBrokerSession(config: SessionConfig): Promise<SessionBrokerResult> {
    const abort = new AbortController();
    this.sessionBrokerAcquisitionAbort = abort;
    try {
      const result = await acquireSessionThroughDaemon(
        config,
        {
          ensureConnected: () => this.ensureConnected(),
          callDaemonMethod: (method, params, options) =>
            this.requireClient().callDaemonMethod(method, params, options),
          holdSession: (requestId, sessionUuid) => this.holdBrokerSession(requestId, sessionUuid),
          releaseSession: (sessionUuid) => this.releasePreparedBrokerSession(sessionUuid),
          livenessOwnerToken: this.livenessOwnerToken,
          timer: this.timer,
        },
        abort.signal,
      );
      this.sessionBrokerResult = result;
      return result;
    } finally {
      if (this.sessionBrokerAcquisitionAbort === abort) {
        this.sessionBrokerAcquisitionAbort = undefined;
      }
    }
  }

  /** Bind a ready receipt to the existing keeper without enrolling it in broker binding release. */
  private async holdBrokerSession(requestId: string, sessionUuid: string): Promise<void> {
    const trimmedRequestId = requestId.trim();
    const trimmedSessionUuid = sessionUuid.trim();
    if (trimmedRequestId.length === 0 || trimmedSessionUuid.length === 0) {
      throw new ActionableError("A session broker request ID and session UUID are required.");
    }
    if (this.closing) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
    const existing = this.sessionBrokerBinding;
    if (
      existing &&
      (existing.requestId !== trimmedRequestId || existing.sessionUuid !== trimmedSessionUuid)
    ) {
      throw new ActionableError(
        `Cannot hold broker session ${trimmedSessionUuid}: request ${existing.requestId} already ` +
          `holds session ${existing.sessionUuid}.`,
      );
    }
    if (this.boundSessionUuid !== undefined && this.boundSessionUuid !== trimmedSessionUuid) {
      throw new ActionableError(
        `Cannot hold broker session ${trimmedSessionUuid}: this proxy is already bound to ` +
          `session ${this.boundSessionUuid}.`,
      );
    }
    this.bindStartupSession(trimmedSessionUuid);
    this.sessionBrokerSessions.set(trimmedSessionUuid, trimmedRequestId);
    this.sessionBrokerBinding = {
      requestId: trimmedRequestId,
      sessionUuid: trimmedSessionUuid,
    };
    try {
      await this.ensureConnected();
      await this.establishBoundSessionHeartbeat();
    } catch (error) {
      this.sessionBrokerBinding = undefined;
      throw toActionableError(error, `Failed to hold broker session ${trimmedSessionUuid}`);
    }
  }

  private heldSessionBrokerBinding(): { requestId: string; sessionUuid: string } | undefined {
    const binding = this.sessionBrokerBinding;
    if (
      !binding ||
      this.sessionBrokerSessions.get(binding.sessionUuid) !== binding.requestId ||
      this.boundSessionUuid !== binding.sessionUuid ||
      this.terminalBoundSession?.sessionUuid === binding.sessionUuid
    ) {
      return undefined;
    }
    return binding;
  }

  /** Rebind only the still-current durable receipt; the daemon derives its private scope. */
  private async rebindSessionBrokerConnection(client: DaemonClientLike): Promise<void> {
    const binding = this.heldSessionBrokerBinding();
    if (!binding || this.closing || this.client !== client) {
      return;
    }
    try {
      await client.callDaemonMethod(DAEMON_REGISTER_SESSION_METHOD, {
        sessionId: binding.sessionUuid,
        clientName: SESSION_BROKER_PROXY_CLIENT_NAME,
        sessionBroker: {
          requestId: binding.requestId,
          livenessOwnerToken: this.livenessOwnerToken,
        },
      });
    } catch (error) {
      if (isSessionOwnershipLostError(error) && this.isCurrentBrokerBinding(binding)) {
        this.sessionBrokerBinding = undefined;
        this.fenceBoundSessionUuid(binding.sessionUuid, SESSION_OWNERSHIP_LOST_CODE);
        logger.warn(
          `[DaemonMcpProxy] Broker request ${binding.requestId} no longer grants session ` +
            `${binding.sessionUuid}; the binding is terminal.`,
          error,
        );
        return;
      }
      logger.warn(
        `[DaemonMcpProxy] Re-binding broker request ${binding.requestId} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private isCurrentBrokerBinding(binding: { requestId: string; sessionUuid: string }): boolean {
    return (
      this.sessionBrokerBinding?.requestId === binding.requestId &&
      this.sessionBrokerBinding.sessionUuid === binding.sessionUuid &&
      this.sessionBrokerSessions.get(binding.sessionUuid) === binding.requestId
    );
  }

  getSessionBrokerResult(): SessionBrokerResult | undefined {
    return this.sessionBrokerResult;
  }

  private async callBrokerRelease(sessionUuid: string): Promise<unknown> {
    const client = this.client;
    if (!client) {
      throw new DaemonUnavailableError("Cannot release broker session without a daemon connection");
    }
    return raceWithDeadline(
      () =>
        client.callDaemonMethod(
          DAEMON_RELEASE_BROKER_SESSION_METHOD,
          { sessionId: sessionUuid, livenessOwnerToken: this.livenessOwnerToken },
          { timeoutMs: BROKER_EXECUTION_RELEASE_TIMEOUT_MS },
        ),
      {
        timer: this.timer,
        timeoutMs: BROKER_EXECUTION_RELEASE_TIMEOUT_MS,
        label: `Release broker session ${sessionUuid}`,
      },
    );
  }

  private forgetBrokerSession(sessionUuid: string): void {
    const requestId = this.sessionBrokerSessions.get(sessionUuid);
    this.sessionBrokerSessions.delete(sessionUuid);
    if (
      requestId !== undefined &&
      this.sessionBrokerBinding?.requestId === requestId &&
      this.sessionBrokerBinding.sessionUuid === sessionUuid
    ) {
      this.sessionBrokerBinding = undefined;
    }
    this.ownedDeviceSessions.delete(sessionUuid);
    this.claimableSessions.delete(sessionUuid);
    this.dropHeldSession(sessionUuid);
    if (this.boundSessionUuid === sessionUuid) {
      this.clearBoundSessionUuid();
    }
    this.syncHeartbeatKeeper();
  }

  private async releasePreparedBrokerSession(sessionUuid: string): Promise<unknown> {
    try {
      return await this.callBrokerRelease(sessionUuid);
    } finally {
      this.forgetBrokerSession(sessionUuid);
    }
  }

  /** Broker teardown remains durable in the daemon even when this bounded call cannot confirm it. */
  private async releaseBrokerSessions(): Promise<void> {
    const sessions = [...this.sessionBrokerSessions.keys()];
    this.sessionBrokerBinding = undefined;
    await Promise.all(
      sessions.map(async (sessionUuid) => {
        try {
          const result = await this.callBrokerRelease(sessionUuid);
          const release = result as Partial<SessionBrokerReleaseResult> | undefined;
          if (
            release?.sessionUuid !== sessionUuid ||
            !["released", "cleanup_pending", "unknown_session"].includes(String(release?.outcome))
          ) {
            logger.warn(
              `[DaemonMcpProxy] Broker release for ${sessionUuid} returned a stale or malformed result`,
            );
          } else if (release.outcome === "unknown_session") {
            logger.warn(
              `[DaemonMcpProxy] Broker release for ${sessionUuid} did not find its durable receipt`,
            );
          } else {
            logger.info(
              `[DaemonMcpProxy] Released broker session ${sessionUuid}: ${release.outcome}`,
            );
          }
        } catch (error) {
          logger.warn(
            `[DaemonMcpProxy] Releasing broker session ${sessionUuid} failed; durable daemon ` +
              `cleanup remains pending: ${errorMessage(error)}`,
            error,
          );
        } finally {
          this.forgetBrokerSession(sessionUuid);
        }
      }),
    );
  }

  /** The terminally released binding, excluding a resumable daemon stall, for reporting surfaces (#11712). */
  getTerminalSessionRelease(): { sessionUuid: string; reason: string } | undefined {
    const terminal = this.terminalBoundSession;
    return terminal && terminal.reason !== DAEMON_STALLED_CODE
      ? { sessionUuid: terminal.sessionUuid, reason: terminal.reason }
      : undefined;
  }

  /** Release only this process's ordinary heartbeat holds; harness and CLI holds survive exit. */
  private async releaseOwnedSessions(client: DaemonClientLike | null): Promise<void> {
    if (
      !client ||
      stableLivenessOwnerToken(this.config) ||
      this.config.oneShotCli ||
      this.cliSessionLivenessDeclared
    ) {
      return;
    }
    const sessions = this.heldSessionUuids().filter(
      (sessionId) =>
        sessionId !== this.config.initialSessionUuid?.trim() &&
        !this.sessionBrokerSessions.has(sessionId) &&
        !this.releasedSessionReasons.has(sessionId),
    );
    await Promise.all(
      sessions.map(async (sessionId) => {
        try {
          const result: unknown = await raceWithDeadline(
            () =>
              client.callDaemonMethod(
                DAEMON_RELEASE_SESSION_METHOD,
                { sessionId, livenessOwnerToken: this.livenessOwnerToken },
                { timeoutMs: BROKER_EXECUTION_RELEASE_TIMEOUT_MS },
              ),
            {
              timer: this.timer,
              timeoutMs: BROKER_EXECUTION_RELEASE_TIMEOUT_MS,
              label: `Release owned session ${sessionId}`,
            },
          );
          // DaemonClientLike permits arbitrary results; injected clients can resolve refusal envelopes.
          if (result && typeof result === "object" && Reflect.get(result, "success") === false) {
            throw Object.assign(new ActionableError(String(Reflect.get(result, "error"))), {
              code: Reflect.get(result, "code"),
            });
          }
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            Reflect.get(error, "code") === DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE
          ) {
            // A successor or explicit handoff owns this session now; its lifecycle must continue.
            logger.debug(
              `[DaemonMcpProxy] Session ${sessionId} no longer belongs to this proxy; keeping it`,
              error,
            );
            return;
          }
          logger.warn(
            `[DaemonMcpProxy] Releasing owned session ${sessionId} failed; falling back to owner-disconnect release: ${errorMessage(error)}`,
            error,
          );
        }
      }),
    );
  }

  /**
   * Adopt the `--initial-session-uuid` session at proxy startup instead of on the first tool call.
   * Connection establishment sends the claiming heartbeat and starts the keeper, so a handoff
   * proxy that has only initialized already owns the session and keeps it alive if the previous
   * owner stops first. A no-op without an initial session binding.
   */
  async claimInitialSession(): Promise<void> {
    const sessionUuid = this.boundSessionUuid;
    const claimsInitialSession = this.initialSessionBindingConfigured && sessionUuid !== undefined;
    // A stable owner token also connects at startup: connecting resumes every session the token
    // owned before a restart, inside the daemon's owner-disconnect grace (#10990).
    if ((!claimsInitialSession && !stableLivenessOwnerToken(this.config)) || this.closing) {
      return;
    }
    try {
      await this.ensureConnected();
    } catch (error) {
      // Best-effort: the first tool call retries the connection and its claim.
      logger.warn(
        claimsInitialSession
          ? `[DaemonMcpProxy] Startup claim of initial session ${sessionUuid} failed: ${errorMessage(error)}`
          : `[DaemonMcpProxy] Startup resume of this owner token's sessions failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private connectSingleFlight(allowsLifecycle: boolean): Promise<void> {
    this.assertConnectionPlanCompatible(allowsLifecycle);
    // Serialize socket publication, but never let observation-only work ride a lifecycle attempt.
    if (this.connecting) {
      return this.connecting;
    }
    const attempt = this.doConnect(allowsLifecycle);
    this.connectionAttemptWork = attempt;
    void attempt.then(
      () => this.clearConnectionAttemptWork(attempt),
      () => this.clearConnectionAttemptWork(attempt),
    );
    const connecting = new Promise<void>((resolve, reject) => {
      this.connectionCloseReject = reject;
      void attempt.then(resolve, reject);
    });
    this.connecting = connecting;
    this.connectingAllowsLifecycle = allowsLifecycle;
    return connecting;
  }

  private clearConnectionAttemptWork(attempt: Promise<void>): void {
    if (this.connectionAttemptWork === attempt) {
      this.connectionAttemptWork = null;
    }
  }

  private async joinConnectionAttempt(): Promise<void> {
    await this.connectionAttemptWork?.catch(() => undefined);
  }

  private clearConnectionAttempt(connecting: Promise<void>): void {
    // Unpublish the settled attempt before originators or joiners await shared recovery.
    if (this.connecting === connecting) {
      this.connecting = null;
      this.connectionCloseReject = null;
      this.connectingAllowsLifecycle = false;
    }
  }

  private connectionAllowsLifecycle(): boolean {
    const allowed = daemonLifecycleAllowed();
    if (allowed) {
      this.throwIfLivenessHandedOver();
    }
    return allowed && !this.hasLivenessLifecycleFence();
  }

  private assertConnectionPlanCompatible(allowsLifecycle: boolean): void {
    if (this.connecting && !allowsLifecycle && this.connectingAllowsLifecycle) {
      throw new LifecycleConnectionInFlightError();
    }
  }

  private async handleConnectionFailure(error: unknown): Promise<void> {
    if (!daemonLifecycleAllowed() || !this.hasLivenessLifecycleFence()) {
      throw error;
    }
    await this.waitForLivenessRecovery();
    this.throwIfLivenessHandedOver();
    if (!this.connected || !this.client) {
      throw error;
    }
  }

  private throwIfClosing(): void {
    if (this.closing) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
  }

  private assertDaemonLifecycleUnfenced(): void {
    if (this.hasLivenessLifecycleFence()) {
      throw new DaemonUnavailableError(
        "Liveness recovery or handover forbids daemon lifecycle changes",
      );
    }
  }

  /**
   * Wait for liveness recovery of the sessions this proxy holds, bounded (#10508). Recovery spreads
   * its attempts over the lease, so an unbounded wait wedged every later call on the connection
   * for as long as recovery ran, including the call that would let the daemon resume the session.
   * The bound runs once per stretch of recovery, from the first call that waits on it: once it has
   * passed, later calls go ahead at once instead of each waiting it out again while the same
   * recovery keeps running. A call that goes ahead keeps its connection observation-only while the
   * fence holds, and a handover recorded meanwhile still surfaces from the caller's own checks.
   */
  private async waitForLivenessRecovery(signal?: AbortSignal): Promise<void> {
    if (
      !daemonLifecycleAllowed() ||
      !this.heldSessionUuids().some((uuid) => this.livenessRecovery.isRecovering(uuid))
    ) {
      return;
    }
    const deadline = this.livenessRecoveryCallDeadline();
    const timeoutMs = deadline - this.timer.now();
    if (timeoutMs <= 0) {
      // This stretch of recovery already used up its bound on an earlier call; the same recovery
      // is still running, and waiting it out again would wedge every call on the connection.
      logger.debug("[DaemonMcpProxy] Liveness recovery still running; call goes ahead without it");
      return;
    }
    try {
      await raceWithDeadline(this.livenessRecovery.settled(), {
        timer: this.timer,
        timeoutMs,
        signal,
        label: "Daemon liveness recovery",
      });
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `[DaemonMcpProxy] Liveness recovery still running after ${timeoutMs}ms; going ahead without it`,
        error,
      );
    }
  }

  /** When calls stop waiting for the current stretch of recovery, fixed by its first waiting call. */
  private livenessRecoveryCallDeadline(): number {
    const episode = this.livenessRecovery.busyEpisode();
    if (this.livenessRecoveryCallWait?.episode !== episode) {
      this.livenessRecoveryCallWait = {
        episode,
        deadline:
          this.timer.now() +
          livenessRecoveryCallWaitMs(this.heartbeatLeashMs, this.heartbeatRequestTimeoutMs()),
      };
    }
    return this.livenessRecoveryCallWait.deadline;
  }

  private throwIfLivenessHandedOver(): void {
    const first = this.stallHandovers.entries().next().value;
    if (first) {
      const [sessionUuid, record] = first;
      throw new DaemonSessionStalledError(sessionUuid, this.currentHandover(sessionUuid, record));
    }
  }

  private async listDuringLivenessFence<T>(
    request: () => Promise<T>,
    coldList: () => T,
  ): Promise<T> {
    if (this.shouldServeLivenessDiscoveryCold()) {
      return coldList();
    }
    try {
      return await runWithoutDaemonLifecycle(request);
    } catch (error) {
      // Discovery is session-independent; an unreachable daemon keeps its existing cold surface.
      logger.debug("[DaemonMcpProxy] Fenced discovery unavailable; serving cold list", error);
      return coldList();
    }
  }

  private shouldServeLivenessDiscoveryCold(): boolean {
    return (
      this.hasLivenessLifecycleFence() &&
      (this.connecting !== null ||
        this.daemonShutdownDisconnect !== null ||
        this.heldSessionUuids().some((uuid) => this.livenessRecovery.isRecovering(uuid)))
    );
  }

  private hasLivenessLifecycleFence(): boolean {
    return (
      this.stallHandovers.size > 0 ||
      this.heldSessionUuids().some((uuid) => this.livenessRecovery.isRecovering(uuid))
    );
  }

  /**
   * What connecting must do about the daemon's lifecycle: `start` it (not running, auto-start on),
   * `reconcile` a running one with this client, or only `observe`. Liveness recovery shares the
   * daemon with other harnesses, so a connection it establishes only observes: it fails when the
   * daemon is not reachable and never starts it or reconciles it by restarting it.
   */
  private daemonLifecyclePlan(
    isAvailable: boolean,
    allowsLifecycle: boolean,
  ): "start" | "reconcile" | "observe" {
    if (!allowsLifecycle || this.hasLivenessLifecycleFence()) {
      if (!isAvailable) {
        throw new DaemonUnavailableError(
          "Daemon is not reachable; liveness recovery never starts or restarts the daemon",
        );
      }
      return "observe";
    }
    if (isAvailable) {
      return "reconcile";
    }
    if (!this.config.autoStartDaemon) {
      throw new DaemonUnavailableError("Daemon is not running and auto-start is disabled");
    }
    return "start";
  }

  private async doConnect(allowsLifecycle: boolean): Promise<void> {
    this.throwIfClosing();
    this.reconciliationSnapshot = undefined;
    this.structuredSessionNotFound = false;
    // Check if daemon is available
    const socketPath = this.config.socketPath ?? SOCKET_PATH;
    // This is an observation-only probe (issue #6140: isAvailable never touches
    // the filesystem). A daemon from another checkout may own this namespace's
    // socket without its PID record; cleaning the path before DaemonManager can
    // verify that candidate would sever a live daemon.
    const isAvailable = await this.daemonAvailabilityProbe(socketPath);

    const lifecycle = this.daemonLifecyclePlan(isAvailable, allowsLifecycle);
    if (lifecycle === "start") {
      logger.info("[DaemonMcpProxy] Daemon not available, starting daemon...");
      await this.startDaemon();
    }
    if (lifecycle !== "observe") {
      await this.ensureVersionMatches();
      await this.ensureAssetVersionPinMatches();
      await this.ensureBuildMatches();
      await this.ensureStartupOptionsMatch();
    }

    // Reuse the socket status already read by reconciliation, after any restart.
    // Custom transports without a socket status probe retain legacy compatibility.
    if (this.daemonStatusProbe) {
      const status = await this.reconciliationStatus();
      this.structuredSessionNotFound = status.structuredSessionNotFound === true;
    }

    // Create and connect client
    this.throwIfClosing();
    // A previous attempt may have left a client behind; close it before it is
    // overwritten so the daemon socket is not leaked (#11117).
    const previousClient = this.client;
    this.client = this.clientFactory();
    const client = this.client;
    this.closePreviousClient(previousClient, client);
    try {
      // Wire daemon-pushed list-changed forwarding (issue #3223) when the client
      // supports it. The handler is registered BEFORE connect so no early frame
      // is dropped; the opt-in subscription request goes out after connect.
      const supportsNotifications = [client.onNotification, client.subscribeToNotifications].every(
        (method) => typeof method === "function",
      );
      if (supportsNotifications) {
        this.notificationUnsubscribe?.();
        this.notificationUnsubscribe = client.onNotification!((notification) =>
          this.handleDaemonNotification(notification, client),
        );
      }
      this.subscribeToClientConnectionClosed(client);
      await runPreflightTransport(() => client.connect(undefined, this.closeAbort.signal));
      if (this.closing) {
        await client.close();
        throw new DaemonUnavailableError("MCP proxy is closing");
      }
      logger.info("[DaemonMcpProxy] Connected to daemon");

      // Start notification opt-in BEFORE awaiting the ownership heartbeat so a
      // shutdown that releases the initial binding during that round trip cannot
      // publish to an unsubscribed socket (#6336). Do not await the subscription
      // yet: it is a best-effort daemon RPC that can stall up to the connection
      // timeout, while the time-critical first heartbeat must still be dispatched
      // immediately to beat the pre-first-heartbeat reclaim grace (#5637).
      const notificationSubscription = supportsNotifications
        ? client.subscribeToNotifications!({ signal: this.closeAbort.signal }).catch((error) => {
            logger.warn(`[DaemonMcpProxy] Failed to subscribe to daemon notifications: ${error}`);
          })
        : Promise.resolve();
      const [firstConnectionStep, secondConnectionStep] =
        this.connectionOwnershipAndPresentationSteps(client);
      await firstConnectionStep();
      await secondConnectionStep();
      // Re-check closing before the deferred flip: the establishment heartbeat awaits a
      // real daemon round-trip, and a close() landing during it already set
      // connected=false and nulled the client. Without this guard doConnect would
      // resume and set connected=true again — leaving a stale connected flag over a
      // closed transport (the old pre-await placement flipped before this await, so
      // close() ran last). Mirrors the closing rechecks above.
      this.throwIfClosing();
      // Fence the flip to the transport this attempt established (#6389): a socket
      // close during the establishment heartbeat already ran resetConnection() and
      // nulled the client, and the best-effort heartbeat swallowed the rejection.
      // Publishing connected=true now would pair the flag with a null client. No
      // request was dispatched on the lost transport, so surface it as a preflight
      // failure that withRecoverableReconnect reconnects from.
      this.assertConnectedClient(client);
      this.connected = true;
      this.cancelBackgroundConnectRetry();

      // Connection establishment still waits for the already-running subscription
      // so callers do not race later requests ahead of notification opt-in. Failure
      // was converted to a warning above and preserves the prior best-effort policy.
      await notificationSubscription;
      this.throwIfClosing();
      if (this.resourceSubscriptions.size > 0) {
        await this.replayResourceSubscriptions(client);
      }

      this.notifyStaticListsServedBeforeConnect();
    } catch (error) {
      // A failed partial connect (e.g. presentation profile rejected) must not
      // leave a live socket or subscriptions behind: the next attempt would
      // overwrite this.client and orphan it (#11117).
      await this.abandonFailedClient(client);
      throw error;
    }
  }

  private notifyStaticListsServedBeforeConnect(): void {
    // If a client `tools/list` was served statically before this connection
    // existed (issue #5879), prompt it to re-fetch now that the daemon can
    // return the accurate (session-scoped) list. A no-op in the common case
    // where the static and live lists match; correct when a tool-selection
    // profile filters the live list.
    if (this.servedStaticToolList) {
      this.servedStaticToolList = false;
      this.notifyListChanged("tools");
    }
    if (this.servedStaticResourceList) {
      this.servedStaticResourceList = false;
      this.notifyListChanged("resources");
    }
  }

  /**
   * Not awaited: an extra turn in doConnect reorders reconnect timing that quiescence handling
   * (#6336) depends on; a close failure is only logged.
   */
  private closePreviousClient(previous: DaemonClientLike | null, current: DaemonClientLike): void {
    if (previous && previous !== current) {
      void previous.close().catch((closeError) => {
        logger.warn(`[DaemonMcpProxy] Failed to close previous daemon client: ${closeError}`);
      });
    }
  }

  private async abandonFailedClient(client: DaemonClientLike): Promise<void> {
    if (this.client === client) {
      await this.resetConnection();
      return;
    }
    await client.close().catch((closeError) => {
      logger.warn(`[DaemonMcpProxy] Failed to close abandoned daemon client: ${closeError}`);
    });
  }

  private connectionOwnershipAndPresentationSteps(
    client: DaemonClientLike,
  ): readonly [() => Promise<void>, () => Promise<void>] {
    // Capture this before applying the profile: the first successful write
    // mints and stores the UUID. On first connect the profile must exist before
    // ownership establishment can publish `connected`; on reconnect the UUID is
    // already attached to concurrent calls, so reassert ownership first and
    // reapply the DB-backed presentation writes afterward. Keeping reconnect's
    // heartbeat ahead of those writes preserves the pre-first-heartbeat reclaim
    // grace guarantee (#5637).
    const isFirstPresentationProfileApplication = this.toolSelectionProfileUuid === undefined;
    const applyPresentationProfile = () => this.applyConnectionPresentationProfile(client);

    // On the FIRST establishment mark the proxy `connected` only AFTER the
    // establishment heartbeat lands (issue #5643). ensureConnected()'s fast path
    // returns as soon as `connected && client` is true; setting the flag before the
    // awaited first heartbeat would let a CONCURRENT ensureConnected() (a parallel
    // listTools/callTool during MCP startup) resolve and forward a request in the
    // sub-millisecond window before the daemon has recorded ownership. Deferring the
    // flip holds those concurrent callers on the `connecting` guard until ownership
    // is recorded; the heartbeat guards key off the live transport (`transportLive`),
    // not this flag, so the first heartbeat still fires while it is still false. On a
    // RECONNECT there is no ownership to wait for, so establishBoundSessionHeartbeat
    // flips `connected` itself before dispatching the keeper heartbeat (see there).
    // A stable owner token also resumes the sessions it holds (#10990); without one the
    // establishment step is unchanged.
    const establishBaseOwnership = stableLivenessOwnerToken(this.config)
      ? async () => {
          await this.establishBoundSessionHeartbeat(client);
          await this.resumeTokenOwnedSessions(client);
        }
      : () => this.establishBoundSessionHeartbeat(client);
    // A broker binding connection that reconnects re-binds the new socket to its binding sessions
    // (#11178); the daemon dropped the old socket's binding when it closed. Other proxies keep
    // their establishment exactly as before.
    const establishOwnership = this.heldSessionBrokerBinding()
      ? async () => {
          await establishBaseOwnership();
          await this.rebindSessionBrokerConnection(client);
        }
      : establishBaseOwnership;

    return isFirstPresentationProfileApplication
      ? [applyPresentationProfile, establishOwnership]
      : [establishOwnership, applyPresentationProfile];
  }

  /**
   * Materialize this frontend's presentation options on its daemon-issued
   * connection profile. The profile survives socket reconnects in this proxy,
   * while reapplying the writes makes daemon replacement safe without promoting
   * any of these options back to process-global startup state.
   */
  private async applyConnectionPresentationProfile(client: DaemonClientLike): Promise<void> {
    const {
      enabledTools = [],
      disabledTools = [],
      toolResultsNoStructuredContent,
      actionsCompactMetadata,
    } = this.config.daemonOptions ?? {};
    const updates = this.connectionPresentationUpdates(
      enabledTools,
      disabledTools,
      toolResultsNoStructuredContent,
      actionsCompactMetadata,
    );

    for (const update of updates) {
      const requestedArgs = {
        ...update,
        ...(toolResultsNoStructuredContent !== undefined
          ? {
              [INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM]: toolResultsNoStructuredContent,
            }
          : {}),
        ...(actionsCompactMetadata !== undefined
          ? { [INTERNAL_ACTIONS_COMPACT_METADATA_PARAM]: actionsCompactMetadata }
          : {}),
      };
      const forwardedArgs = this.withToolSelectionProfile(requestedArgs);
      const result = await runPreflightTransport(() =>
        client.callTool(SET_TOOL_ENABLED_TOOL_NAME, forwardedArgs),
      );
      if (result?.isError) {
        throw new DaemonUnavailableError(
          `Failed to apply connection presentation profile: ${JSON.stringify(result)}`,
        );
      }
      this.rememberToolSelectionProfile(SET_TOOL_ENABLED_TOOL_NAME, requestedArgs, result);
      if (!this.toolSelectionProfileUuid) {
        throw new DaemonUnavailableError(
          "Daemon did not return a connection profile while applying presentation options",
        );
      }
    }
  }

  private connectionPresentationUpdates(
    enabledTools: string[],
    disabledTools: string[],
    toolResultsNoStructuredContent: boolean | undefined,
    actionsCompactMetadata: boolean | undefined,
  ): Array<{ toolNames: string[]; enabled: boolean }> {
    if (
      enabledTools.length === 0 &&
      disabledTools.length === 0 &&
      toolResultsNoStructuredContent === undefined &&
      actionsCompactMetadata === undefined
    ) {
      return [];
    }

    const updates: Array<{ toolNames: string[]; enabled: boolean }> = [];
    if (enabledTools.length > 0) {
      updates.push({ toolNames: [...enabledTools], enabled: true });
    }
    if (disabledTools.length > 0) {
      updates.push({ toolNames: [...disabledTools], enabled: false });
    }
    if (updates.length === 0) {
      // setToolEnabled is always-on; reaffirming it is a no-op that mints the
      // connection profile needed to carry a presentation-only policy.
      updates.push({ toolNames: [SET_TOOL_ENABLED_TOOL_NAME], enabled: true });
    }

    return updates;
  }

  // Drop the cached definitions for one list kind. Bumping the discovery epoch
  // makes a discovery request whose response is still in flight decline to
  // repopulate the cache this invalidation just cleared (issue #4655).
  private invalidateListCache(kind: ListChangedKind): void {
    this.discoveryEpoch += 1;
    if (kind === "tools") {
      this.cachedTools = null;
    } else {
      this.cachedResources = null;
      this.cachedResourceTemplates = null;
    }
  }

  // Invalidate the matching cache and re-emit a list_changed to listeners,
  // mirroring the daemon-pushed invalidation path (see handleDaemonNotification)
  // so a re-fetch is never stale.
  private notifyListChanged(kind: ListChangedKind): void {
    this.invalidateListCache(kind);
    for (const listener of this.listChangedListeners) {
      try {
        listener(kind);
      } catch (error) {
        // Best-effort re-emit: a dead/mid-teardown client transport must not
        // break sibling listeners.
        logger.warn(`[DaemonMcpProxy] list_changed listener failed for ${kind}: ${error}`);
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

  /**
   * Register a listener told when automatic liveness recovery was exhausted (#10053), so a harness
   * that is idle between tool calls still learns a session was lost. The same structured error is
   * returned on the next tool call for an affected session.
   */
  onLivenessHandover(listener: (handover: LivenessHandover) => void): () => void {
    this.livenessHandoverListeners.add(listener);
    return () => {
      this.livenessHandoverListeners.delete(listener);
    };
  }

  onResourceUpdated(listener: (uri: string) => void): () => void {
    return this.resourceSubscriptionManager.onResourceUpdated(listener);
  }

  subscribeResource(uri: string): Promise<void> {
    return this.resourceSubscriptionManager.subscribeResource(uri);
  }

  unsubscribeResource(uri: string): Promise<void> {
    return this.resourceSubscriptionManager.unsubscribeResource(uri);
  }

  private assertConnectedClient(client: DaemonClientLike): void {
    if (this.client !== client) {
      throw new DaemonPreflightConnectionError(
        new DaemonUnavailableError("Daemon socket closed during connection establishment"),
      );
    }
  }

  private replayResourceSubscriptions(client: DaemonClientLike): Promise<void> {
    return this.resourceSubscriptionManager.replayResourceSubscriptions(client);
  }

  private syncResourceSubscription(uri: string): Promise<void> {
    return this.resourceSubscriptionManager.syncResourceSubscription(uri);
  }

  private handleResourceUpdated(
    notification: DaemonNotification,
    sourceClient: DaemonClientLike,
  ): void {
    return this.resourceSubscriptionManager.handleResourceUpdated(notification, sourceClient);
  }

  private handleDaemonNotification(
    notification: DaemonNotification,
    sourceClient: DaemonClientLike,
  ): void {
    if (notification.method === RESOURCE_UPDATED_NOTIFICATION_METHOD) {
      this.handleResourceUpdated(notification, sourceClient);
      return;
    }
    if (notification.method === SESSION_RELEASED_NOTIFICATION_METHOD) {
      this.handleSessionReleasedNotification(notification);
      return;
    }

    if (notification.method === PROGRESS_NOTIFICATION_METHOD) {
      this.handleProgressNotification(notification, sourceClient);
      return;
    }

    const kind = listChangedKindForMethod(notification.method);
    if (kind === undefined) {
      // Unknown pushed methods are expected as the daemon grows new
      // notification families; ignoring keeps old proxies forward-compatible.
      logger.debug(`[DaemonMcpProxy] Ignoring unknown daemon notification: ${notification.method}`);
      return;
    }

    this.invalidateListCache(kind);
    if (kind === "tools") {
      this.reconciliationSnapshot = undefined;
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

  // A late or unmatched progress frame is expected around call completion.
  private handleProgressNotification(
    notification: DaemonNotification,
    sourceClient: DaemonClientLike,
  ): void {
    if (
      notification.requestId === undefined ||
      notification.progressToken === undefined ||
      notification.progress === undefined
    ) {
      return;
    }
    const registered = this.progressListeners.get(sourceClient)?.get(notification.requestId);
    if (registered?.progressToken !== notification.progressToken) {
      return;
    }
    try {
      registered.listener(notification.progress, notification.total, notification.message);
    } catch (error) {
      // Best-effort: a throwing progress consumer must never break the
      // notification channel or the in-flight tool call it belongs to.
      logger.warn(
        `[DaemonMcpProxy] progress listener failed for token ${notification.progressToken}: ${error}`,
      );
    }
  }

  private removeProgressListener(
    client: DaemonClientLike | undefined,
    requestId: string | undefined,
  ): void {
    if (!client || requestId === undefined) {
      return;
    }
    const listeners = this.progressListeners.get(client);
    listeners?.delete(requestId);
    if (listeners?.size === 0) {
      this.progressListeners.delete(client);
    }
  }

  private handleSessionReleasedNotification(notification: DaemonNotification): void {
    // Record the release against the specific UUID so an in-flight call that
    // forwarded it cannot re-remember it. Exact matching leaves unrelated and
    // derived sessions untouched; the replay TTL remains a dropped-frame
    // backstop (issues #4610, #4655).
    const releasedSessionUuid =
      typeof notification.sessionId === "string" && notification.sessionId.trim().length > 0
        ? notification.sessionId.trim()
        : undefined;
    if (!releasedSessionUuid) {
      return;
    }
    const handleStallHandoverRelease = (): boolean => {
      const keepsHandover =
        this.sessionBrokerSessions.has(releasedSessionUuid) &&
        this.stallHandovers.get(releasedSessionUuid)?.handover.code === DAEMON_STALLED_CODE &&
        isRecoverableDaemonHandoffReason(notification.reason ?? "");
      if (!keepsHandover) {
        this.endLostSessionHandover(releasedSessionUuid, notification.reason);
      }
      return keepsHandover;
    };
    const preservedStallHandover = handleStallHandoverRelease();
    this.rememberFinalizedRecordings(releasedSessionUuid, notification.recordingIds);
    if (notification.reason === "daemon-shutdown") {
      this.daemonShutdownAnnouncedAt = this.timer.now();
      // Daemon shutdown is connection-wide. Arm the successor barrier even when
      // this UUID belongs to an unresolved acquisition result that has not become
      // the current binding yet.
      this.waitForDaemonShutdownDisconnect();
    }
    if (preservedStallHandover) {
      // The stall fence already removed the binding. Keep its restore snapshot and claims,
      // rather than recording a loss or setting up a handoff for a binding that is absent.
      return;
    }
    if (this.releaseKeepsBinding(releasedSessionUuid, notification.reason)) {
      // The replacement daemon rehydrates this UUID as awaiting-owner. Preserve
      // the binding so the next call/heartbeat can reclaim it after reconnecting.
      this.recoverableBoundSessionHandoff = releasedSessionUuid;
      this.recoverableBoundSessionHandoffIsDeviceRestart =
        sessionReleaseReasonFamily(notification.reason ?? "") === "device-restart:";
      this.livenessOwnershipClaimSent = false;
      const heldHandoff = this.otherHeldSessions.get(releasedSessionUuid);
      if (heldHandoff) {
        heldHandoff.claimSent = false;
      }
      this.discoveryEpoch += 1;
      this.invalidateCache();
      return;
    }
    this.releaseLedger.recordSessionReleased(releasedSessionUuid, notification.reason);
    // A released session is no longer owned: drop it so a later fresh-screenshot
    // read stops owner-routing to it and falls back to the live binding (which the
    // daemon denies), matching the "released session remains denied" guarantee
    // (issue #5663).
    this.ownedDeviceSessions.delete(releasedSessionUuid);
    this.claimableSessions.delete(releasedSessionUuid);
    this.clearNotFoundHistory(releasedSessionUuid);
    this.recordHeldSessionTerminalLoss(
      releasedSessionUuid,
      notification.reason,
      notification.release,
    );
    this.dropHeldSession(releasedSessionUuid);
    if (
      releasedSessionUuid === this.boundSessionUuid ||
      releasedSessionUuid === this.terminalBoundSession?.sessionUuid
    ) {
      this.fenceBoundSessionUuid(
        releasedSessionUuid,
        this.reasonForReleaseNotification(releasedSessionUuid, notification.reason),
        notification.release,
      );
    }
  }

  private reasonForReleaseNotification(sessionUuid: string, reason?: string): string {
    const terminal = this.terminalBoundSession;
    const reported =
      terminal?.sessionUuid === sessionUuid ? terminal.reportedStallLossReason : undefined;
    return reported ?? reason ?? "released";
  }

  /**
   * The one classification of a release the daemon reports for `sessionUuid`, whether in a
   * session-released notification or with a not-found heartbeat (keeper tick, first heartbeat,
   * liveness recovery): the binding survives only a recoverable handoff (`device-restart:<id>`,
   * a daemon shutdown or restart) of a session this proxy owns, because the daemon hands that
   * session back to the next call. Every other reason, terminal, merely reusable by name
   * (`plan-auto-release`) or unknown to this build, ends the binding: the proxy stops heartbeating
   * it and never attaches the UUID to a sessionless call again.
   */
  private releaseKeepsBinding(sessionUuid: string, releaseReason: string | undefined): boolean {
    return isRecoverableHandoffOfOwnedSession(
      releaseReason,
      this.ownedDeviceSessions.has(sessionUuid),
    );
  }

  private hasRecoverableBoundSessionHandoff(): boolean {
    return (
      this.recoverableBoundSessionHandoff !== undefined &&
      this.recoverableBoundSessionHandoff === this.boundSessionUuid
    );
  }

  private waitForDaemonShutdownDisconnect(): void {
    if (this.daemonShutdownDisconnect || !this.client) {
      return;
    }
    const disconnect = Promise.withResolvers<void>();
    let peerDisconnected = false;
    const completeDisconnect = (): void => {
      peerDisconnected = true;
      disconnect.resolve();
    };
    const timeoutHandle = this.timer.setTimeout(disconnect.resolve, DAEMON_SHUTDOWN_TIMEOUT_MS);
    const barrier = disconnect.promise
      .then(async () => {
        this.timer.clearTimeout(timeoutHandle);
        if (!peerDisconnected) {
          if (this.resolveDaemonShutdownDisconnect === completeDisconnect) {
            this.resolveDaemonShutdownDisconnect = null;
          }
          // A stalled transport must not remain attached after the bounded EOF
          // wait. resetConnection detaches it synchronously before closing it.
          void this.resetConnection();
        }
        await this.waitForDaemonShutdownRestartWindow();
      })
      .catch((error) => {
        // Readiness is re-checked by doConnect; this barrier only prevents the
        // deterministic stale-PID/no-startup-lock gap from racing that path.
        logger.warn(`[DaemonMcpProxy] Failed while awaiting daemon restart transition: ${error}`);
      });
    this.daemonShutdownDisconnect = barrier;
    this.resolveDaemonShutdownDisconnect = completeDisconnect;
    void barrier.then(() => {
      if (this.daemonShutdownDisconnect === barrier) {
        this.daemonShutdownDisconnect = null;
      }
    });
    // Keep the old client attached long enough to observe peer EOF, but prevent
    // ensureConnected() from treating this quiesced incarnation as reusable.
    this.connected = false;
    if (typeof this.client.onConnectionClosed !== "function") {
      // This client cannot report peer EOF. Begin detaching now; the timeout
      // still bounds a custom close() implementation that never settles.
      void this.resetConnection();
    }
  }

  private completeDaemonShutdownDisconnect(
    expectedResolve: (() => void) | null = this.resolveDaemonShutdownDisconnect,
  ): void {
    if (this.resolveDaemonShutdownDisconnect !== expectedResolve) {
      return;
    }
    this.resolveDaemonShutdownDisconnect = null;
    expectedResolve?.();
  }

  private async waitForDaemonShutdownRestartWindow(): Promise<void> {
    const socketPath = this.config.socketPath ?? SOCKET_PATH;
    let deadline =
      this.timer.now() + Math.max(DAEMON_STARTUP_TIMEOUT_MS, DAEMON_RESTART_HANDOFF_TIMEOUT_MS);
    let emptyHandoffDeadline: number | undefined;
    while (!this.closing && this.timer.now() < deadline) {
      if (await this.daemonAvailabilityProbe(socketPath)) {
        return;
      }
      const status = await this.daemonManager.status();
      const startupLockHeld = this.daemonManager.isStartupLockHeldByLiveProcess();
      if (startupLockHeld && this.config.autoStartDaemon) {
        // doConnect() may now join the lock holder through DaemonManager.start().
        return;
      }
      if (startupLockHeld || status.running) {
        // A successor has begun publishing ownership. Clients with auto-start
        // disabled cannot join its lock, so keep their barrier active until its
        // socket becomes reachable under the overall startup deadline.
        emptyHandoffDeadline = undefined;
      } else {
        // Explicit restart deliberately leaves no PID and no startup lock while
        // it pauses between stop and start. Preserve that handoff instead of
        // racing to start a daemon with this proxy's potentially different
        // options.
        emptyHandoffDeadline ??= this.timer.now() + DAEMON_RESTART_HANDOFF_TIMEOUT_MS;
        // A short startup-timeout override must not truncate the complete
        // bounded restart preflight after the empty handoff is first observed.
        deadline = Math.max(deadline, emptyHandoffDeadline);
        if (this.timer.now() >= emptyHandoffDeadline) {
          return;
        }
      }
      const waitDeadline = emptyHandoffDeadline ?? deadline;
      await this.timer.sleep(Math.min(100, waitDeadline - this.timer.now()));
    }
  }

  private createLifecycleReconcilerDeps(): DaemonLifecycleReconcilerDeps {
    const proxy = this;
    return {
      get config() {
        return proxy.config;
      },
      get daemonManager() {
        return proxy.daemonManager;
      },
      get daemonStatusProbe() {
        return proxy.daemonStatusProbe;
      },
      get timer() {
        return proxy.timer;
      },
      get clientVersion() {
        return proxy.clientVersion;
      },
      get clientAssetVersion() {
        return proxy.clientAssetVersion;
      },
      get buildIdentity() {
        return proxy.buildIdentity;
      },
      get reconciliationSnapshot() {
        return proxy.reconciliationSnapshot;
      },
      set reconciliationSnapshot(value) {
        proxy.reconciliationSnapshot = value;
      },
      invalidateCache: () => this.invalidateCache(),
      assertDaemonLifecycleUnfenced: () => this.assertDaemonLifecycleUnfenced(),

      reconciliationStatus: () => this.reconciliationStatus(),
      isSameDaemonGeneration: (current, expected) => this.isSameDaemonGeneration(current, expected),
      waitForJoinedRestartSuccessor: (expected, deadline) =>
        this.waitForJoinedRestartSuccessor(expected, deadline),
      waitForRunningReconciliationStatus: (deadline) =>
        this.waitForRunningReconciliationStatus(deadline),
      readSocketReconciliationStatus: () => this.readSocketReconciliationStatus(),
      assertAutomaticRestartAllowed: (status, reason) =>
        this.assertAutomaticRestartAllowed(status, reason),
      ensureVersionMatches: (reconciliationDeadline, observedStatus) =>
        this.ensureVersionMatches(reconciliationDeadline, observedStatus),
      verifyRestartedVersion: () => this.verifyRestartedVersion(),
      requiresVersionRestart: (status, runningVersion) =>
        this.requiresVersionRestart(status, runningVersion),
      assertNewerClientVersion: (status, runningVersion, runningBase, clientBase, sameRelease) =>
        this.assertNewerClientVersion(status, runningVersion, runningBase, clientBase, sameRelease),
      assertVersionRestartCooldownExpired: (status, runningVersion) =>
        this.assertVersionRestartCooldownExpired(status, runningVersion),
      versionMismatchError: (runningVersion, reason, detail, retryAfterMs, daemonBuild) =>
        this.versionMismatchError(runningVersion, reason, detail, retryAfterMs, daemonBuild),

      ensureBuildMatches: (reconciliationDeadline, observedStatus) =>
        this.ensureBuildMatches(reconciliationDeadline, observedStatus),
      finishBuildRestart: (restartResult, status, reconciliationDeadline) =>
        this.finishBuildRestart(restartResult, status, reconciliationDeadline),
      buildMismatchError: (daemon, reason, detail, retryAfterMs) =>
        this.buildMismatchError(daemon, reason, detail, retryAfterMs),
    };
  }

  private createStatusProbe(
    config: DaemonMcpProxyConfig,
  ): (() => Promise<DaemonStatus>) | undefined {
    return this.lifecycleReconciler.createStatusProbe(config);
  }

  private reconciliationStatus(): Promise<DaemonStatus> {
    return this.lifecycleReconciler.reconciliationStatus();
  }

  private isSameDaemonGeneration(current: DaemonStatus, expected: DaemonStatus): boolean {
    return this.lifecycleReconciler.isSameDaemonGeneration(current, expected);
  }

  /**
   * A competing client can observe the incumbent during an admitted restart's
   * intentional handoff gap. Wait for a different, running generation instead
   * of treating that gap as a completed reconciliation.
   */
  private waitForJoinedRestartSuccessor(
    expected: DaemonStatus,
    deadline: number,
  ): Promise<DaemonStatus> {
    return this.lifecycleReconciler.waitForJoinedRestartSuccessor(expected, deadline);
  }

  private waitForRunningReconciliationStatus(deadline: number): Promise<DaemonStatus> {
    return this.lifecycleReconciler.waitForRunningReconciliationStatus(deadline);
  }

  private readSocketReconciliationStatus(): Promise<DaemonStatus> {
    return this.lifecycleReconciler.readSocketReconciliationStatus();
  }

  private assertAutomaticRestartAllowed(status: DaemonStatus, reason: string): void {
    return this.lifecycleReconciler.assertAutomaticRestartAllowed(status, reason);
  }

  /** Newer clients may replace older daemons; mismatches remain a pre-dispatch gate. */
  private ensureVersionMatches(
    reconciliationDeadline = this.timer.now() + DAEMON_STARTUP_TIMEOUT_MS,
    observedStatus?: DaemonStatus,
  ): Promise<void> {
    return this.lifecycleReconciler.ensureVersionMatches(reconciliationDeadline, observedStatus);
  }

  private verifyRestartedVersion(): Promise<void> {
    return this.lifecycleReconciler.verifyRestartedVersion();
  }

  private requiresVersionRestart(status: DaemonStatus, runningVersion: string): boolean {
    return this.lifecycleReconciler.requiresVersionRestart(status, runningVersion);
  }

  private assertNewerClientVersion(
    status: DaemonStatus,
    runningVersion: string,
    runningBase: string,
    clientBase: string,
    sameRelease: boolean,
  ): void {
    return this.lifecycleReconciler.assertNewerClientVersion(
      status,
      runningVersion,
      runningBase,
      clientBase,
      sameRelease,
    );
  }

  private assertVersionRestartCooldownExpired(status: DaemonStatus, runningVersion: string): void {
    return this.lifecycleReconciler.assertVersionRestartCooldownExpired(status, runningVersion);
  }

  private versionMismatchError(
    runningVersion: string,
    reason: VersionMismatchReason,
    detail: string,
    retryAfterMs?: number,
    daemonBuild?: BuildIdentity,
  ): DaemonVersionMismatchError {
    return this.lifecycleReconciler.versionMismatchError(
      runningVersion,
      reason,
      detail,
      retryAfterMs,
      daemonBuild,
    );
  }

  private ensureAssetVersionPinMatches(): Promise<void> {
    return this.lifecycleReconciler.ensureAssetVersionPinMatches();
  }

  /**
   * Ensure the client never attaches to a daemon built from a *different* checkout.
   * The version string alone cannot detect this (two checkouts can both report the
   * same pre-release version), so we compare a content hash of the entry script.
   * On mismatch, restart the daemon from this client's own entrypoint so the live
   * frontend and backend run the same code. Independent of, and complementary to,
   * {@link ensureVersionMatches}.
   */
  private ensureBuildMatches(
    reconciliationDeadline = this.timer.now() + DAEMON_STARTUP_TIMEOUT_MS,
    observedStatus?: DaemonStatus,
  ): Promise<void> {
    return this.lifecycleReconciler.ensureBuildMatches(reconciliationDeadline, observedStatus);
  }

  private finishBuildRestart(
    restartResult: DaemonRestartResult,
    status: DaemonStatus,
    reconciliationDeadline: number,
  ): Promise<void> {
    return this.lifecycleReconciler.finishBuildRestart(
      restartResult,
      status,
      reconciliationDeadline,
    );
  }

  private buildMismatchError(
    daemon: BuildIdentity,
    reason: BuildMismatchReason,
    detail: string,
    retryAfterMs?: number,
  ): DaemonBuildMismatchError {
    return this.lifecycleReconciler.buildMismatchError(daemon, reason, detail, retryAfterMs);
  }

  private ensureStartupOptionsMatch(): Promise<void> {
    return this.lifecycleReconciler.ensureStartupOptionsMatch();
  }

  /**
   * Start the daemon process
   */
  private startDaemon(): Promise<void> {
    return this.lifecycleReconciler.startDaemon();
  }

  private async withRecoverableReconnect<T>(
    operation: () => Promise<T>,
    attemptedSessionUuid?: string,
    allowReleasedSession?: boolean,
    fenceSessionNotFoundOnRetry = true,
    nonIdempotentToolName?: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.closing) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
    this.throwIfBoundSessionFenced(allowReleasedSession, attemptedSessionUuid);
    if (this.hasRecoverableBoundSessionHandoff()) {
      await this.resetConnectionForRecoverableHandoff();
      // doConnect restarts the heartbeat keeper. Clear the marker before that
      // asynchronous tick can enter withRecoverableReconnect and reset the new
      // transport beneath the operation that is reclaiming this UUID.
      this.recoverableBoundSessionHandoff = undefined;
      this.recoverableBoundSessionHandoffIsDeviceRestart = false;
    }
    let established = false;

    try {
      // Socket identity discovery can race a daemon handoff before any tool
      // has been dispatched. Give establishment the same single reconnect
      // attempt as a recoverable transport failure, preserving the fences.
      await this.ensureConnected();
      signal.throwIfAborted();
      this.throwIfBoundSessionFenced(allowReleasedSession, attemptedSessionUuid);
      established = true;
      return await operation();
    } catch (error) {
      signal.throwIfAborted();
      if (this.closing) {
        throw error;
      }
      this.throwIfBoundSessionFenced(allowReleasedSession, attemptedSessionUuid);
      this.throwIfBoundSessionLost(error);
      this.throwIfSessionEndedAnswer(error, attemptedSessionUuid, fenceSessionNotFoundOnRetry);
      if (!this.isRecoverableDaemonSessionError(error, established)) {
        throw error;
      }
      if (error instanceof DaemonShuttingDownError) {
        this.waitForDaemonShutdownDisconnect();
      }
      const refusedToolName = this.ambiguousReplayToolName(
        error,
        established,
        nonIdempotentToolName,
      );
      if (refusedToolName !== undefined) {
        // The tool may have reached the daemon and run: never re-run it (issue #6382).
        await this.throwOutcomeWithoutReplay(refusedToolName, error);
      }

      await this.resetConnectionForRetry(error);
      signal.throwIfAborted();
      this.throwIfBoundSessionFenced(allowReleasedSession, attemptedSessionUuid);
      await this.ensureConnected();
      signal.throwIfAborted();
      this.throwIfBoundSessionFenced(allowReleasedSession, attemptedSessionUuid);
      try {
        return await operation();
      } catch (retryError) {
        signal.throwIfAborted();
        this.throwIfBoundSessionFenced(allowReleasedSession, attemptedSessionUuid);
        const sessionNotFoundFenceTarget = this.sessionNotFoundFenceTarget(
          retryError,
          attemptedSessionUuid,
          fenceSessionNotFoundOnRetry,
        );
        this.throwIfSessionEndedAnswer(
          retryError,
          attemptedSessionUuid,
          fenceSessionNotFoundOnRetry,
        );
        if (sessionNotFoundFenceTarget) {
          this.fenceBoundSessionUuid(sessionNotFoundFenceTarget, "session-not-found");
          throw this.boundSessionExpiredError();
        }
        await this.throwIfRetryOutcomeUnknown(retryError, nonIdempotentToolName);
        throw retryError;
      }
    }
  }

  /**
   * The latest binding was handed off recoverably (a daemon shutdown or restart, its device's
   * restart): the next request reclaims it on a fresh connection. With tool calls in flight on
   * the connection it is reclaimed on that connection instead
   * ({@link connectionCarriesCallsInFlight}).
   */
  private resetConnectionForRecoverableHandoff(): Promise<void> {
    return this.connectionCarriesCallsInFlight()
      ? Promise.resolve()
      : this.resetConnectionOnceDrained();
  }

  /**
   * Before the one retry of a request that failed recoverably: replace the connection, unless the
   * failure is the daemon's answer about one session on a connection with tool calls in flight
   * ({@link isSessionAnswerOnSharedConnection}), which is asked again where it is. Not `async`:
   * the reset is awaited as directly as before, since callers' scheduling depends on its turns.
   */
  private resetConnectionForRetry(error: unknown): Promise<void> {
    if (this.isSessionAnswerOnSharedConnection(error)) {
      logger.info(
        `[DaemonMcpProxy] Asking once more on the same daemon connection, which has tool calls in flight: ${errorMessage(error)}`,
      );
      return Promise.resolve();
    }
    logger.warn(
      `[DaemonMcpProxy] Daemon session is stale, reconnecting and retrying once: ${errorMessage(error)}`,
    );
    return this.resetConnectionOnceDrained();
  }

  /**
   * The single retry of a non-idempotent tool reached a written frame before the
   * transport failed again: the retried call may have run, so surface the same
   * outcome-unknown error as a first attempt instead of the raw transport error
   * (an agent that sees only "Socket connection closed" would retry the action).
   * A retry that provably never reached the daemon stays a plain not-delivered
   * failure; nothing is retried again either way.
   */
  private async throwIfRetryOutcomeUnknown(
    retryError: unknown,
    nonIdempotentToolName: string | undefined,
  ): Promise<void> {
    if (!this.isRecoverableDaemonSessionError(retryError, true)) {
      return;
    }
    const refusedToolName = this.ambiguousReplayToolName(retryError, true, nonIdempotentToolName);
    if (refusedToolName === undefined) {
      return;
    }
    await this.throwOutcomeWithoutReplay(refusedToolName, retryError);
  }

  /**
   * End a non-idempotent tool call that may have run, without sending it again (issue #6382).
   * The daemon's own typed `daemon_shutting_down` answer reaches the caller as it was given:
   * typed and retryable, with `requestMayHaveDispatched`, so the caller decides whether to repeat
   * the step. Any other failure says only that the transport died, so the outcome is unknown and
   * the dead connection is replaced for the next call.
   */
  private async throwOutcomeWithoutReplay(toolName: string, error: unknown): Promise<never> {
    if (!(error instanceof DaemonShuttingDownError)) {
      // A not-found answer came over a working connection: there is no dead transport to replace
      // beneath the calls still in flight on it ({@link isSessionAnswerOnSharedConnection}).
      if (!this.isSessionAnswerOnSharedConnection(error)) {
        await this.resetConnection();
      }
      throw new DaemonToolOutcomeUnknownError(toolName, error);
    }
    this.waitForDaemonShutdownDisconnect();
    if (this.drainingToolCalls() === undefined) {
      await this.resetConnection();
    }
    throw error;
  }

  /**
   * The wait a connection-wide reset owes the tool calls still in flight on a connection whose
   * daemon is shutting down; undefined when there is nothing to wait for. A shutdown refusal or a
   * `daemon-shutdown` handoff seen by one request (a keeper heartbeat, a sibling call) says
   * nothing about the others: the daemon answers each of them, with its result or with its own
   * `daemon_shutting_down`, before it closes the socket. Closing the one shared socket first
   * would fail them here, as outcome-unknown, for steps the daemon was about to answer.
   *
   * The wait ends when the last of those calls settles, when the daemon closes the connection, or
   * when the shutdown barrier gives up on a daemon that never closes ({@link
   * waitForDaemonShutdownDisconnect}, which then detaches the connection itself). While it lasts
   * the connection is not reusable, so nothing new is sent on it: every new request waits for
   * the successor connection in {@link ensureConnected}.
   */
  private drainingToolCalls(): Promise<void> | undefined {
    const client = this.client;
    const barrier = this.daemonShutdownDisconnect;
    if (!client || !barrier || (this.toolCallsInFlight.get(client) ?? 0) === 0) {
      return undefined;
    }
    let settled = this.toolCallsSettled.get(client);
    if (!settled) {
      settled = Promise.withResolvers<void>();
      this.toolCallsSettled.set(client, settled);
    }
    // Whichever comes first: the barrier never rejects, and resolving twice is a no-op.
    const drained = Promise.withResolvers<void>();
    void barrier.then(drained.resolve);
    void settled.promise.then(drained.resolve);
    return drained.promise;
  }

  /**
   * {@link resetConnection}, after the tool calls in flight on a draining connection have their
   * answers ({@link drainingToolCalls}). A connection that was replaced while this waited is
   * someone else's: it is left alone.
   */
  private async resetConnectionOnceDrained(): Promise<void> {
    const draining = this.drainingToolCalls();
    if (draining === undefined) {
      await this.resetConnection();
      return;
    }
    const drainedClient = this.client;
    await draining;
    if (this.client === drainedClient && !this.closing) {
      await this.resetConnection();
    }
  }

  /**
   * Whether tool calls are awaiting their answers on the current, working daemon connection. It
   * is the one socket for every session this proxy holds, so closing it cancels each of those
   * calls in the daemon mid-run and answers it outcome-unknown, whichever session it drives
   * (#11656). What happens to ONE session (the daemon answers not-found for it, or hands it off
   * for its device's restart) is therefore never a reason to close it under them: the daemon that
   * answered is the one running those calls, so the session is asked again, or reclaimed, on the
   * connection it shares with them. Nothing waits for those calls, so no heartbeat is held up
   * behind one, and with none in flight the fresh connection costs nobody anything and is still
   * made (it is what reaches a successor daemon).
   *
   * False for a connection that is not in use as it stands: one draining at daemon shutdown, whose
   * reset waits for its calls ({@link drainingToolCalls}), and one a transport failure proved dead,
   * where there is nothing left to lose. What ends a connection as a whole (a transport failure,
   * the daemon's shutdown or close) is not decided here.
   */
  private connectionCarriesCallsInFlight(): boolean {
    const client = this.client;
    return (
      client !== null &&
      this.connected &&
      !this.deadSocketClients.has(client) &&
      (this.toolCallsInFlight.get(client) ?? 0) > 0
    );
  }

  /**
   * The daemon answered a request not-found for its session while other tool calls are in flight
   * on the connection: an answer about that session, which leaves the connection as it is
   * ({@link connectionCarriesCallsInFlight}). The request that was answered has settled, so the
   * calls counted are never its own.
   */
  private isSessionAnswerOnSharedConnection(error: unknown): boolean {
    return this.isDaemonSessionNotFoundError(error) && this.connectionCarriesCallsInFlight();
  }

  /**
   * A not-found answer that names a release which ends the session (#11520): every reason but a
   * recoverable handoff of a session this proxy owns, classified by {@link releaseKeepsBinding}
   * like the release notification. The daemon answered about that session on a working
   * connection, so nothing is stale: resetting the one shared socket would cut the connection
   * attempt this request may be part of, and every sibling call in flight, to ask a question
   * already answered. An answer with no reason, or with a recoverable one, says nothing final and
   * keeps the reconnect-and-retry, unless it is a heartbeat's first answer on a connection that
   * was just established ({@link askSessionHeartbeat}).
   */
  private sessionEndedAnswerReason(
    error: unknown,
    attemptedSessionUuid: string | undefined,
  ): string | undefined {
    if (!this.isDaemonSessionNotFoundError(error)) {
      return undefined;
    }
    const releaseReason = releaseReasonFromError(error);
    if (releaseReason === undefined) {
      return undefined;
    }
    const keepsBinding =
      attemptedSessionUuid === undefined
        ? isRecoverableDaemonReleaseReason(releaseReason)
        : this.releaseKeepsBinding(attemptedSessionUuid, releaseReason);
    return keepsBinding ? undefined : releaseReason;
  }

  /**
   * Rethrow a not-found answer that ends the session ({@link sessionEndedAnswerReason}) without
   * touching the connection. A caller that fences on not-found gets the binding fenced under the
   * daemon's reason and the terminal refusal; a heartbeat decides its own not-found answers before
   * they get here ({@link noteNotFoundAnswer}).
   */
  private throwIfSessionEndedAnswer(
    error: unknown,
    attemptedSessionUuid: string | undefined,
    fenceSessionNotFound: boolean,
  ): void {
    const releaseReason = this.sessionEndedAnswerReason(error, attemptedSessionUuid);
    if (releaseReason === undefined) {
      return;
    }
    const fenceTarget = this.sessionNotFoundFenceTarget(
      error,
      attemptedSessionUuid,
      fenceSessionNotFound,
    );
    if (fenceTarget) {
      this.fenceBoundSessionUuid(fenceTarget, releaseReason);
      throw this.boundSessionExpiredError();
    }
    throw error;
  }

  private sessionNotFoundFenceTarget(
    error: unknown,
    attemptedSessionUuid: string | undefined,
    fenceSessionNotFoundOnRetry: boolean,
  ): string | undefined {
    if (
      !fenceSessionNotFoundOnRetry ||
      !attemptedSessionUuid ||
      this.boundSessionUuid !== attemptedSessionUuid ||
      !this.isDaemonSessionNotFoundError(error)
    ) {
      return undefined;
    }
    return attemptedSessionUuid;
  }

  private isRecoverableDaemonSessionError(error: unknown, established = true): boolean {
    if (!established) {
      return error instanceof DaemonPreflightConnectionError;
    }
    // Compatibility policy failures cannot be healed by another connection
    // attempt (and repeating a failed reconciliation could restart twice).
    if (
      error instanceof DaemonVersionMismatchError ||
      error instanceof DaemonBuildMismatchError ||
      error instanceof DaemonAssetVersionMismatchError
    ) {
      return false;
    }
    // Structured server evidence proves rejection happened before dispatch.
    // Legacy message-only errors remain non-retryable rather than guessing.
    if (error instanceof DaemonHandshakeMismatchError) {
      return true;
    }
    if (error instanceof DaemonUnavailableError) {
      return true;
    }

    // "Unknown tool" is recoverable only when the frontend advertises that tool.
    // A reconnect cannot make a frontend-unregistered name exist in the daemon.
    return this.isDaemonSessionNotFoundError(error) || this.isRecoverableUnknownToolError(error);
  }

  private throwIfBoundSessionLost(error: unknown): void {
    if (!(error instanceof DaemonBoundSessionLostError)) {
      return;
    }
    if (error.failure.sessionUuid !== this.boundSessionUuid) {
      throw new DaemonBoundSessionExpiredError(
        error.failure.sessionUuid,
        error.failure.reason,
        error.failure.release,
      );
    }
    this.fenceBoundSessionUuid(
      error.failure.sessionUuid,
      error.failure.reason,
      error.failure.release,
    );
    throw this.boundSessionExpiredError();
  }

  /**
   * The non-idempotent tool whose replay must be refused because nothing proves
   * the failed attempt never dispatched it; undefined when a replay is safe.
   * Before establishment the operation never ran, so a replay is always safe.
   */
  private ambiguousReplayToolName(
    error: unknown,
    established: boolean,
    nonIdempotentToolName: string | undefined,
  ): string | undefined {
    if (!established || this.isProvablyUndispatchedError(error)) {
      return undefined;
    }
    return nonIdempotentToolName;
  }

  /**
   * Structured evidence that the daemon never dispatched the request: the frame
   * was never written, or the daemon rejected it before admission. Message
   * substrings (e.g. "Session not found") are deliberately not evidence here.
   */
  private isProvablyUndispatchedError(error: unknown): boolean {
    return (
      error instanceof DaemonRequestNotDeliveredError ||
      (error instanceof DaemonShuttingDownError && !error.requestMayHaveDispatched) ||
      error instanceof DaemonHandshakeMismatchError ||
      isMcpQueueTimeoutError(error) ||
      this.isRecoverableUnknownToolError(error)
    );
  }

  private isDaemonSessionNotFoundError(error: unknown): boolean {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code !== undefined
    ) {
      return error.code === DAEMON_SESSION_NOT_FOUND_CODE;
    }
    if (this.structuredSessionNotFound) {
      return false;
    }
    // Older daemons return only the bare message, without a structured error code.
    return errorMessage(error).includes("Session not found");
  }

  private isPreDispatchDaemonSessionError(error: unknown): boolean {
    return (
      this.isUnknownToolError(error) ||
      errorMessage(error).includes("is not an active daemon session")
    );
  }

  private isUnknownToolError(error: unknown): boolean {
    const message = errorMessage(error);
    return this.isGatedToolError(error) || message.includes("Unknown tool:");
  }

  /**
   * The daemon registers the tool but its availability gate (debug-only,
   * embedded-SDK-only, plan-only) rejected the call (issue #10177). Structured
   * code only: the gate-reason prose is never parsed. A daemon that predates the
   * code sends none, so it falls through to the stale-daemon recovery below —
   * that daemon is necessarily a different build than this proxy, so the
   * reconnect re-runs the build-identity reconciliation and replaces it.
   */
  private isGatedToolError(error: unknown): boolean {
    return isGatedToolErrorCode(error);
  }

  private isRecoverableUnknownToolError(error: unknown): boolean {
    // A gate is daemon configuration, not skew: a reconnect cannot lift it, and
    // resetting would abort every sibling call in flight on the shared client.
    if (this.isGatedToolError(error)) {
      return false;
    }
    const match = errorMessage(error).match(/Unknown tool:\s*(\S+)/);
    if (!match) {
      return this.isUnknownToolError(error);
    }
    const name = match[1].replace(/[.,;:!?]+$/, "");
    return name.length === 0 || this.frontendRegistersTool(name);
  }

  private shouldSkipLeaseRefreshForDeviceControlTransportError(error: unknown): boolean {
    return (
      error instanceof DeviceControlTransportError &&
      (error.failure.phase === "connect" || !error.failure.sessionValid)
    );
  }

  private async resetConnection(): Promise<void> {
    const shutdownDisconnectResolve = this.resolveDaemonShutdownDisconnect;
    const staleClient = this.client;
    this.resourceSubscriptionSync = Promise.resolve();
    this.connected = false;
    this.client = null;
    this.ownershipReestablishment = undefined;
    this.structuredSessionNotFound = false;
    this.notificationUnsubscribe?.();
    this.notificationUnsubscribe = null;
    this.connectionClosedUnsubscribe?.();
    this.connectionClosedUnsubscribe = null;
    this.invalidateCache();

    if (!staleClient) {
      this.completeDaemonShutdownDisconnect(shutdownDisconnectResolve);
      return;
    }

    try {
      await staleClient.close();
    } catch (error) {
      logger.warn(`[DaemonMcpProxy] Failed to close stale daemon client: ${error}`);
    }
    // resetConnection deliberately unregisters the peer-close callback before
    // closing the stale client. Resolve an armed shutdown barrier explicitly so
    // the retry cannot wait forever for a callback that can no longer fire.
    this.completeDaemonShutdownDisconnect(shutdownDisconnectResolve);
  }

  private subscribeToClientConnectionClosed(client: DaemonClientLike): void {
    if (typeof client.onConnectionClosed !== "function") {
      return;
    }
    this.connectionClosedUnsubscribe?.();
    this.connectionClosedUnsubscribe = client.onConnectionClosed(() => {
      if (this.client === client) {
        // EOF is the only connection-wide shutdown signal an idle proxy receives,
        // and a subscribed release notification can be lost while the old socket
        // drains. Arm the same successor barrier before reset detaches this client.
        this.waitForDaemonShutdownDisconnect();
        this.completeDaemonShutdownDisconnect();
        void this.resetConnection().then(() => this.connectResourceSubscriptionsInBackground());
      }
    });
  }

  /**
   * Serve the tool surface for a client `tools/list` request.
   *
   * When no daemon connection exists yet, this returns the static tool surface
   * (`schemas/tool-definitions.json`) WITHOUT connecting or starting the daemon,
   * and defers the daemon connect/start to the first actual tool call (issue
   * #5879). A wedged or absent daemon therefore never hides the tool surface at
   * `tools/list` time; the client still gets one clear error on first use.
   *
   * Once a connection is established, this returns the daemon's live,
   * session-scoped list for this connection. The static superset is used only
   * for the cold bootstrap above and if the live list fails below. Connection-
   * profile updates and session binding can transiently narrow the live
   * `tools/list` response; the explicit tools `list_changed` notifications and
   * cache invalidation for those updates prompt clients to re-fetch under the
   * current scope, so a stale-superset merge is not needed for completeness.
   *
   * The static path deliberately does NOT call `throwIfBoundSessionUnavailable()`
   * (unlike {@link listTools}): re-coupling `tools/list` to daemon/session state
   * is exactly what issue #5879 removes. A fenced/expired bound session still
   * surfaces its ownership-lost error on the next actual tool call, which routes
   * through {@link callTool}'s gate.
   */
  async listAdvertisedTools(): Promise<ProxiedToolDefinition[]> {
    if (this.hasLivenessLifecycleFence()) {
      return this.cachedTools ?? this.staticToolDefinitionsProvider();
    }
    if (!this.connected || !this.client) {
      this.servedStaticToolList = true;
      return this.staticToolDefinitionsProvider();
    }
    // The live per-connection list is the post-connect contract (#5879); the
    // static fallback is only built when the live call fails, so its cost — a
    // reconciliationStatus() + connectedFallbackDaemonOptions() ide/status RPC —
    // stays off the success path (and can't fail a list whose live call would
    // have succeeded, e.g. daemonManager.status() throwing during a restart).
    try {
      const tools = await this.listTools();
      this.connectedFallbackReconcileAttempt = 0;
      return tools;
    } catch (error) {
      if (
        error instanceof DaemonBoundSessionExpiredError ||
        error instanceof DaemonConnectionSessionReleasedError ||
        error instanceof DeviceControlTransportError ||
        error instanceof McpOverloadError
      ) {
        throw error;
      }
      logger.warn(
        `[DaemonMcpProxy] Live tools/list failed; serving connected static fallback: ${errorMessage(error)}`,
        error,
      );
      this.scheduleConnectedFallbackReconcile();
      const daemonStatus = await this.reconciliationStatus();
      const fallbackOptions = await this.connectedFallbackDaemonOptions(daemonStatus);
      return this.connectedStaticToolDefinitionsProvider(fallbackOptions);
    }
  }

  private async connectedFallbackDaemonOptions(daemonStatus: DaemonStatus): Promise<DaemonOptions> {
    return {
      ...daemonStatus.options,
      debug: daemonStatus.effectiveDebug ?? daemonStatus.options?.debug,
    };
  }

  /**
   * Serve a client `resources/list` request without connecting when no daemon
   * connection exists yet (issue #5879 review). AutoMobile resources are dynamic
   * and daemon-owned (device-session screenshots, per-app navigation graphs), so
   * there is no static cold surface — the cold roster is whatever a prior
   * connection cached, else empty. Deferring the connect keeps a host that
   * enumerates resources during initialization from blocking on a wedged daemon
   * before the first tool call. The first successful connect after a cold serve
   * emits a resources `list_changed` (see {@link doConnect}) so the client
   * re-fetches the real resources.
   */
  async listAdvertisedResources(): Promise<ProxiedResourceDefinition[]> {
    if (this.hasLivenessLifecycleFence()) {
      return this.cachedResources ?? [];
    }
    if (this.connected && this.client) {
      return this.listResources();
    }
    this.serveResourcesColdAndConnectInBackground();
    return this.cachedResources ?? [];
  }

  /**
   * Serve a client `resources/templates/list` request without connecting when no
   * daemon connection exists yet. See {@link listAdvertisedResources}.
   */
  async listAdvertisedResourceTemplates(): Promise<ProxiedResourceTemplate[]> {
    if (this.hasLivenessLifecycleFence()) {
      return this.cachedResourceTemplates ?? [];
    }
    if (this.connected && this.client) {
      return this.listResourceTemplates();
    }
    this.serveResourcesColdAndConnectInBackground();
    return this.cachedResourceTemplates ?? [];
  }

  // Resource discovery has no "first use that connects" equivalent — a
  // resource-only client may list resources and never call a tool, so nothing
  // would ever establish the connection that populates its daemon-owned
  // resources (e.g. `automobile:devices/booted`). Kick off a NON-BLOCKING
  // background connect so the daemon connects and the reconciliation
  // `resources/list_changed` fires, WITHOUT blocking this cold discovery
  // response (issue #5879 review). The `connecting` guard in ensureConnected()
  // dedupes concurrent/polled calls, so at most one attempt is in flight.
  private serveResourcesColdAndConnectInBackground(): void {
    this.servedStaticResourceList = true;
    this.connectResourcesInBackground();
  }

  private connectResourceSubscriptionsInBackground(): void {
    if (this.resourceSubscriptions.size > 0 && !this.connected) {
      this.connectResourcesInBackground();
    }
  }

  private connectResourcesInBackground(): void {
    if (this.connecting || this.backgroundConnectRetry || this.closing) {
      return;
    }
    void this.ensureBackgroundResourceConnection();
  }

  private async ensureBackgroundResourceConnection(): Promise<void> {
    if (!this.servedStaticResourceList && this.resourceSubscriptions.size === 0) {
      return;
    }
    try {
      await this.ensureConnected();
    } catch (error) {
      // Best-effort: the cold roster already returned, and the tool surface is
      // visible via tools/list. A wedged/absent daemon must not surface here; the
      // the next actual request still reports the failure to the client. Retry
      // transient failures a bounded number of times for resource-only clients.
      logger.warn("[DaemonMcpProxy] background resource connect failed", error);
      this.scheduleBackgroundConnectRetry();
    }
  }

  private scheduleBackgroundConnectRetry(): void {
    if (this.closing || this.connected || this.backgroundConnectRetry) {
      return;
    }
    const delay = COLD_RESOURCE_CONNECT_RETRY_DELAYS_MS[this.backgroundConnectRetryAttempt];
    if (delay === undefined) {
      return;
    }
    this.backgroundConnectRetryAttempt += 1;
    this.backgroundConnectRetry = this.timer.setTimeout(() => {
      this.backgroundConnectRetry = null;
      void this.ensureBackgroundResourceConnection();
    }, delay);
  }

  private cancelBackgroundConnectRetry(): void {
    if (this.backgroundConnectRetry) {
      this.timer.clearTimeout(this.backgroundConnectRetry);
      this.backgroundConnectRetry = null;
    }
    this.backgroundConnectRetryAttempt = 0;
  }

  private scheduleConnectedFallbackReconcile(replacingAttempt = false): void {
    const delay = COLD_RESOURCE_CONNECT_RETRY_DELAYS_MS[this.connectedFallbackReconcileAttempt];
    if (this.closing || !this.connected || delay === undefined) {
      if (replacingAttempt) {
        this.connectedFallbackReconcile = null;
        if (!this.closing && !this.connected) {
          this.servedStaticToolList = true;
        }
      }
      return;
    }
    if (this.connectedFallbackReconcile && !replacingAttempt) {
      return;
    }
    this.connectedFallbackReconcileAttempt += 1;
    this.connectedFallbackReconcile = this.timer.setTimeout(() => {
      void this.attemptConnectedFallbackReconcile();
    }, delay);
  }

  private async attemptConnectedFallbackReconcile(): Promise<void> {
    if (this.closing || !this.connected) {
      this.connectedFallbackReconcile = null;
      if (!this.closing) {
        this.servedStaticToolList = true;
      }
      return;
    }
    this.invalidateListCache("tools");
    try {
      await this.listTools();
      this.connectedFallbackReconcileAttempt = 0;
      this.connectedFallbackReconcile = null;
      this.notifyListChanged("tools");
    } catch (error) {
      // Best-effort: callable static schemas were already returned, and the
      // bounded retry can safely wait for the daemon's live list to recover.
      logger.debug(
        `[DaemonMcpProxy] connected static fallback reconciliation failed: ${errorMessage(error)}`,
      );
      this.scheduleConnectedFallbackReconcile(true);
    }
  }

  private cancelConnectedFallbackReconcile(): void {
    if (this.connectedFallbackReconcile) {
      this.timer.clearTimeout(this.connectedFallbackReconcile);
      this.connectedFallbackReconcile = null;
    }
    this.connectedFallbackReconcileAttempt = 0;
  }

  /**
   * Get list of available tools from daemon
   */
  async listTools(): Promise<ProxiedToolDefinition[]> {
    if (this.hasLivenessLifecycleFence()) {
      return this.listDuringLivenessFence(
        () => this.fetchTools(true),
        () => this.cachedTools ?? this.staticToolDefinitionsProvider(),
      );
    }
    return this.fetchTools(this.discoveryAfterResultMintRelease());
  }

  private async fetchTools(releasedResultMint: boolean): Promise<ProxiedToolDefinition[]> {
    // Return cached tools if available
    if (this.cachedTools) {
      return this.cachedTools;
    }

    try {
      // Bind discovery to the session like callTool does. Without this, a
      // recoverable reconnect INSIDE withRecoverableReconnect retries tools/list
      // with empty params against the fresh UNSEEDED transport, which returns the
      // full unfiltered tool list instead of the session-scoped one. Reusing the
      // session-scoped params re-seeds the retry after a reconnect (issue #4610).
      // After a result-minted session is released there is no session to bind:
      // the connection is unbound and lists the surface that contains the
      // getAndroid/getApple recovery tools (#9997).
      const discoveryEpoch = this.discoveryEpoch;
      const forwardedParams = this.withToolSelectionProfile(
        releasedResultMint ? {} : this.withBoundSessionUuid({}),
      );
      const result = await this.withRecoverableReconnect(
        () =>
          this.requireClient().callDaemonMethod(
            "tools/list",
            this.withToolSelectionProfile(forwardedParams),
          ),
        this.sessionUuidFromArgs(forwardedParams),
        releasedResultMint,
      );
      const tools = result?.tools ?? [];
      // If a list_changed or bound-session release invalidated this cache WHILE the
      // response was in flight, the response is scoped to the now-stale binding.
      // Return it to THIS caller but leave the cache empty so the next listTools()
      // refetches under the current scope, instead of resurrecting the list the
      // invalidation just cleared (issue #4655).
      // The unbound list served after a result-minted release is not cached
      // (like resources below): a later explicit-sessionUuid call can re-bind a
      // surviving session without a cache invalidation, which would otherwise
      // keep serving this unbound list under the new binding.
      if (this.discoveryEpoch === discoveryEpoch && !releasedResultMint) {
        this.cachedTools = tools;
      }
      return tools;
    } catch (error) {
      logger.error(`[DaemonMcpProxy] Failed to list tools: ${error}`);
      throw error;
    }
  }

  /**
   * Seed only with the persisted CLI tool-selection profile file's connection-profile UUID.
   * Never pass a device-session UUID: this value is forwarded on every later tool call.
   */
  setToolSelectionProfileUuid(profileUuid: string | undefined): void {
    this.toolSelectionProfileUuid = profileUuid;
  }

  /**
   * Call a tool on the daemon. `progressToken` echoes the external MCP
   * client's own `params._meta.progressToken` (issue #6205); when present it
   * is forwarded to the daemon so `notifications/progress` ticks relayed back
   * over the socket can be routed to `onProgress`, tagged with that SAME
   * token. Omit both to request no progress relay — nothing is fabricated.
   *
   * A call the daemon refuses because a session this proxy holds is suspect is forwarded once
   * more after the liveness recovery the refusal starts has settled, so the client gets that
   * call's result, or the handover/loss error recovery left behind, instead of the refusal.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    progressToken?: string | number,
    onProgress?: DaemonProxyProgressCallback,
    callerSignal?: AbortSignal,
  ): Promise<any> {
    this.refuseBrokerGenericAcquisition(name);
    const signal = this.untilClosed(callerSignal);
    let first = await this.forwardToolCall(name, args, progressToken, onProgress, signal, true);
    if (isDeviceBindingTool(name)) {
      first = await this.waitOutDeviceCleanup(first, name, args, progressToken, onProgress, signal);
    }
    const refusal = first.retryableSuspectRefusal;
    if (!refusal || !(await this.awaitSuspectSessionRecovery(refusal, signal))) {
      return this.withPendingResumedNotice(first.forwardedSessionUuid, first.result);
    }
    // Exactly one retry: the refused call never reached its handler (isSuspectRefusalRetryable).
    // The retry's own pre-forward checks surface a handover or loss recovery recorded.
    logger.info(`[DaemonMcpProxy] Session ${refusal.sessionUuid} restored; retrying ${name} once`);
    const retried = await this.forwardToolCall(
      name,
      args,
      progressToken,
      onProgress,
      signal,
      false,
    );
    return this.withPendingResumedNotice(retried.forwardedSessionUuid, retried.result);
  }

  private refuseBrokerGenericAcquisition(name: string): void {
    if (!this.sessionBrokerResult || !isDeviceSessionAcquisitionTool(name)) {
      return;
    }
    const terminal = this.terminalBoundSession;
    if (terminal && this.sessionBrokerSessions.has(terminal.sessionUuid)) {
      throw this.boundSessionExpiredError();
    }
    throw new ActionableError(
      `Tool ${name} cannot acquire a generic device on a session-broker connection. ` +
        `Use the exact bound session ${this.sessionBrokerResult.sessionUuid ?? "reported by initialize"}.`,
    );
  }

  /**
   * A bind refused as `device_cleanup_in_progress` never reached a device, so it is forwarded
   * again on short growing polls while the previous session's cleanup settles (#11900). The wait is
   * bounded by the cleanup budget; when it runs out the last refusal is returned unchanged.
   */
  private async waitOutDeviceCleanup(
    first: ForwardedToolCall,
    name: string,
    args: Record<string, unknown>,
    progressToken: string | number | undefined,
    onProgress: DaemonProxyProgressCallback | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ForwardedToolCall> {
    const budgetMs = this.config.cleanupWaitBudgetMs ?? DEVICE_CLEANUP_WAIT_BUDGET_MS;
    const deadline = this.timer.now() + budgetMs;
    const backoff = normalizeBackoff(this.config.cleanupWaitBackoff ?? DEVICE_CLEANUP_BACKOFF);
    let current = first;
    for (let attempt = 1; !this.closing; attempt++) {
      const refusal = readDeviceCleanupInProgressRefusal(current.result);
      const remaining = deadline - this.timer.now();
      if (!refusal || remaining <= 0) {
        return current;
      }
      const backoffMs = backoff.delayForAttempt(attempt);
      const hintMs = refusal.retryAfterMs;
      const cleanupCap =
        readToolEnvelopePayload(current.result)?.payload.code === DEVICE_CLEANUP_IN_PROGRESS_CODE;
      const stepMs = Math.max(
        DEVICE_CLEANUP_POLL_FLOOR_MS,
        hintMs !== undefined && hintMs > 0
          ? cleanupCap
            ? Math.min(hintMs, backoffMs)
            : Math.max(hintMs, backoffMs)
          : backoffMs,
      );
      const delayMs = Math.floor(Math.min(remaining, stepMs));
      if (delayMs <= 0) {
        return current;
      }
      logger.info(
        `[DaemonMcpProxy] ${name} refused while the device finishes its previous session's cleanup; re-checking in ${delayMs}ms`,
      );
      await this.waitForCleanupPoll(delayMs, signal);
      current = await this.forwardToolCall(name, args, progressToken, onProgress, signal, false);
    }
    return current;
  }

  /** Keep the poll timeout cancellable; raceWithDeadline owns and removes the abort listener. */
  private async waitForCleanupPoll(
    delayMs: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let handle: NodeJS.Timeout | undefined;
    try {
      await raceWithDeadline(
        () =>
          new Promise<void>((resolve) => {
            handle = this.timer.setTimeout(resolve, delayMs);
          }),
        { timer: this.timer, signal, label: "Device cleanup wait" },
      );
    } finally {
      if (handle !== undefined) {
        this.timer.clearTimeout(handle);
      }
    }
  }

  /**
   * The first call to reach a session resumed after a `daemon_stalled` handover carries the
   * warning that it resumed, so the harness can disregard the handover it was told about (#10989).
   */
  private withPendingResumedNotice(sessionUuid: string | undefined, result: unknown): unknown {
    const pending = sessionUuid ? this.resumedStallNotices.get(sessionUuid) : undefined;
    if (!sessionUuid || !pending) {
      return result;
    }
    this.resumedStallNotices.delete(sessionUuid);
    return withResumedNotice(
      result,
      livenessResumedNotice(pending.handover, sessionUuid, pending.restart),
    );
  }

  /**
   * Wait for the recovery a suspect refusal started, bounded by the time the daemon keeps the
   * session reserved plus one heartbeat request. True when the session is held and no longer
   * recovering, so the refused call may be forwarded once more; an abort rejects.
   */
  private async awaitSuspectSessionRecovery(
    refusal: DeviceSessionSuspectRefusal,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const timeoutMs = Math.max(0, refusal.remainingMs) + this.heartbeatRequestTimeoutMs();
    try {
      await raceWithDeadline(this.livenessRecovery.settled(), {
        timer: this.timer,
        timeoutMs,
        signal,
        label: "Suspect session recovery",
      });
    } catch (error) {
      signal?.throwIfAborted();
      // Another session's recovery can outlast the bound; this session's own state decides below.
      logger.warn(
        `[DaemonMcpProxy] Liveness recovery did not settle within ${timeoutMs}ms after session ${refusal.sessionUuid} was refused as suspect`,
        error,
      );
    }
    return !this.closing && !this.livenessRecovery.isRecovering(refusal.sessionUuid);
  }

  private async forwardToolCall(
    name: string,
    args: Record<string, unknown>,
    progressToken: string | number | undefined,
    onProgress: DaemonProxyProgressCallback | undefined,
    signal: AbortSignal | undefined,
    allowSuspectRetry: boolean,
  ): Promise<ForwardedToolCall> {
    signal?.throwIfAborted();
    // From the first tool call on, a refused claim of the initial binding is leashed as usual.
    this.initialSessionAwaitingFirstCall = false;
    // These are daemon-internal routing markers. Never accept caller-controlled
    // values: only this proxy may add them after selecting its active binding.
    const callerArgs = { ...args };
    delete callerArgs[DAEMON_BOUND_SESSION_PARAM];
    delete callerArgs[DAEMON_OWNED_SESSIONS_PARAM];
    delete callerArgs[DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM];
    delete callerArgs[DAEMON_RELEASED_SESSION_PARAM];
    delete callerArgs[DAEMON_TOOL_SELECTION_PROFILE_PARAM];
    delete callerArgs[DAEMON_ONE_SHOT_CLI_PARAM];
    delete callerArgs[INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM];
    delete callerArgs[INTERNAL_ACTIONS_COMPACT_METADATA_PARAM];
    // The acceptance controls are configuration of the dedicated harness proxy,
    // never client-provided tool arguments. Remove both before routing so a
    // caller cannot forge or override that configuration.
    delete callerArgs[INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM];
    delete callerArgs[INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM];
    const retrievalOwner = this.finalizedRecordingRetrievalOwner(name, callerArgs);
    if (retrievalOwner !== undefined) {
      return this.forwardFinalizedRecordingRetrieval(
        name,
        callerArgs,
        retrievalOwner,
        progressToken,
        signal,
      );
    }
    return this.forwardRoutedToolCall(
      name,
      callerArgs,
      progressToken,
      onProgress,
      signal,
      allowSuspectRetry,
    );
  }

  private async forwardRoutedToolCall(
    name: string,
    callerArgs: Record<string, unknown>,
    progressToken: string | number | undefined,
    onProgress: DaemonProxyProgressCallback | undefined,
    signal: AbortSignal | undefined,
    allowSuspectRetry: boolean,
  ): Promise<ForwardedToolCall> {
    if (this.hasLivenessLifecycleFence()) {
      await this.waitForLivenessRecovery(signal);
    }
    callerArgs = this.withFencedControlDeviceSession(name, callerArgs);
    const platformSelectorArgs = callerArgs;
    const ownSession = this.ownSessionForPlatformSelector(name, callerArgs, true);
    if (ownSession !== undefined) {
      callerArgs = { ...callerArgs, sessionUuid: ownSession };
    }
    this.refuseAmbiguousSessionSelector(name, callerArgs);
    this.heldSessionLosses.reportPlatformLoss(name, platformSelectorArgs);
    this.reportToolSessionLoss(name, callerArgs);
    if (this.stallHandovers.size > 0) {
      await this.resumeStalledSessionNamedBy(callerArgs);
    }
    // Device-session acquisition (including booted provisionDevice) mints a NEW
    // session in its RESULT and is never routed to — or fenced by — the connection's
    // bound session: it must be admitted even on a terminally fenced connection so
    // the client can recover in-band (issue #5689). Forward its raw args and bind
    // the minted session from the result afterwards.
    const isSessionAcquisition = isDeviceSessionAcquisitionTool(name);
    // An omitted `sessionUuid` on the control tool means the connection profile,
    // not the proxy's retained device-routing session. Preserve that distinction
    // after a device has been bound.
    const { forwardedArgs: routedArgs, allowReleasedSession } = this.prepareToolRoutingArgs(
      name,
      callerArgs,
      isSessionAcquisition,
    );
    const forwardedArgs = this.withOneShotCliMarker(this.withAcceptanceConfiguration(routedArgs));
    const forwardedSessionUuid = this.sessionUuidFromArgs(forwardedArgs);
    this.releaseLedger.retainReleaseEpochReference(forwardedSessionUuid);
    // Snapshot the release epoch at forward time. If a session-released signal for
    // the SPECIFIC forwarded UUID lands WHILE this call is in flight, that UUID's
    // recorded epoch advances past this snapshot and the completion path below
    // declines to resurrect the released UUID (issue #4611/#4655). A release of an
    // UNRELATED session bumps the global epoch but not the forwarded UUID's entry,
    // so it does not block remembering the session this call forwarded.
    const callReleaseEpoch = this.releaseLedger.epoch;
    const learnsResultSession = ["setActiveDevice", ...DEVICE_SESSION_ACQUISITION_TOOLS].includes(
      name,
    );
    this.releaseLedger.retainAcquisitionReleaseEpoch(learnsResultSession, callReleaseEpoch);
    let registeredRequestId: string | undefined;
    let registeredClient: DaemonClientLike | undefined;
    const trackedSessionUuids = this.beginSessionCall(
      name,
      this.sessionsUsedByCall(forwardedSessionUuid),
    );
    try {
      const forwarding = this.withRecoverableReconnect(
        () => {
          signal?.throwIfAborted();
          this.throwIfForwardedSessionReleasedSince(forwardedArgs, callReleaseEpoch);
          const client = this.requireClient();
          return this.trackToolCallInFlight(client, () =>
            client.callTool(
              name,
              this.withToolSelectionProfile(forwardedArgs),
              progressToken,
              (requestId) => {
                this.removeProgressListener(registeredClient, registeredRequestId);
                registeredClient = client;
                registeredRequestId = requestId;
                if (progressToken !== undefined && onProgress) {
                  let listeners = this.progressListeners.get(client);
                  if (!listeners) {
                    listeners = new Map();
                    this.progressListeners.set(client, listeners);
                  }
                  listeners.set(requestId, { progressToken, listener: onProgress });
                }
              },
              signal,
            ),
          );
        },
        forwardedSessionUuid,
        // Acquisition is admitted while fenced; the terminal fence is cleared once
        // the result-minted session establishes a fresh binding.
        allowReleasedSession,
        true,
        nonIdempotentToolName(name),
        signal,
      );
      // Connection recovery is shared with siblings; cancel this wait and fence
      // replay without aborting the shared connection attempt.
      const result = await raceWithDeadline(forwarding, {
        timer: this.timer,
        signal,
        label: `Daemon tool ${name}`,
      });
      this.creditRoutedSession(result, forwardedSessionUuid);
      if (result?.isError) {
        // Provisioning retains its usable device session when optional resource
        // configuration fails. Own that result-minted session before returning
        // the evidence-bearing error, so the caller can inspect or retry it.
        if (name === "provisionDevice") {
          await this.sessionBinding.bindResultMintedDeviceSession(name, result, callReleaseEpoch);
        }
        const retryableSuspectRefusal = this.noteSuspectSessionResult(
          name,
          result,
          forwardedArgs,
          allowSuspectRetry,
        );
        this.sessionBinding.bindForwardedSessionOnErrorResult(
          name,
          forwardedArgs,
          result,
          callReleaseEpoch,
        );
        // The daemon's own terminal refusal (a cut call's answer included) told this caller.
        this.noteReleaseSurfacedBy(result);
        return { result, forwardedSessionUuid, retryableSuspectRefusal };
      }
      this.rememberToolSelectionProfile(name, callerArgs, result);
      if (isSessionAcquisition) {
        await this.sessionBinding.bindResultMintedDeviceSession(name, result, callReleaseEpoch);
        return { result, forwardedSessionUuid };
      }
      // Remember what was actually forwarded, not the caller's raw args. An
      // implicit sessionless call injects the bound UUID into forwardedArgs and
      // extends the live daemon session in getOrCreateSession(); refreshing the
      // replay lease off forwardedArgs keeps continuous implicit activity from
      // being mistaken for idleness, so a later reconnect re-seeds the still-live
      // session instead of creating an unseeded transport (issue #4610).
      if (!this.sessionBinding.namesForeignOwnedSession(forwardedArgs, result)) {
        this.sessionBinding.rememberSessionUuid(name, forwardedArgs, callReleaseEpoch, false);
      }
      this.rememberActiveDeviceSession(name, callerArgs, result, callReleaseEpoch);
      return { result, forwardedSessionUuid };
    } catch (error) {
      signal?.throwIfAborted();
      // A fence raised while this call was in flight names the session it lost: the caller is told.
      this.noteReleaseSurfacedBy(error);
      // The success-only rememberSessionUuid above never runs when the handler
      // rejects, but an admitted-then-rejected call still reached
      // getOrCreateSession() and refreshed the LIVE daemon session. Without
      // refreshing the replay lease here too, repeated admitted-but-failed calls
      // let the proxy lease silently expire while the daemon session stays alive,
      // so a later reconnect can no longer replay it (issue #4610).
      this.sessionBinding.refreshReplayLeaseAfterAdmittedFailure(
        name,
        forwardedArgs,
        error,
        callReleaseEpoch,
      );
      // Do NOT clear the binding on a rejected executePlan. A plan can reject
      // *before* the handler runs — tool-selection enforcement or schema parsing in
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
        throw await this.toolUnavailableError(
          name,
          errorMessage(error),
          this.isGatedToolError(error),
        );
      }
      throw error;
    } finally {
      this.endSessionCall(trackedSessionUuids);
      this.releaseLedger.releaseReleaseEpochReference(forwardedSessionUuid);
      this.releaseLedger.releaseAcquisitionReleaseEpoch(learnsResultSession, callReleaseEpoch);
      this.removeProgressListener(registeredClient, registeredRequestId);
    }
  }

  private rememberFinalizedRecordings(
    releasedSessionUuid: string,
    recordingIds: readonly string[] | undefined,
  ): void {
    if (!recordingIds?.length || !this.holdsSessionFamily(releasedSessionUuid)) {
      return;
    }
    for (const recordingId of recordingIds) {
      this.finalizedRecordingOwners.delete(recordingId);
      this.finalizedRecordingOwners.set(recordingId, releasedSessionUuid);
    }
    while (this.finalizedRecordingOwners.size > MAX_FINALIZED_RECORDING_OWNERS) {
      const oldest = this.finalizedRecordingOwners.keys().next();
      if (oldest.done) {
        break;
      }
      this.finalizedRecordingOwners.delete(oldest.value);
    }
  }

  /** Whether this proxy holds, or held until now, the session or its base (`base:label`). */
  private holdsSessionFamily(sessionUuid: string): boolean {
    const colon = sessionUuid.indexOf(":");
    return [sessionUuid, ...(colon > 0 ? [sessionUuid.slice(0, colon)] : [])].some(
      (id) =>
        id === this.boundSessionUuid ||
        id === this.terminalBoundSession?.sessionUuid ||
        this.ownedDeviceSessions.has(id) ||
        this.claimableSessions.has(id) ||
        this.otherHeldSessions.has(id),
    );
  }

  /**
   * The session that started the finalized recording a `videoRecording stop {recordingId}` call
   * retrieves, when this connection learned of that recording from its own session's release
   * (#11362). Retrieval is a read of a stored artifact: it touches no device, so a terminal fence
   * never refuses it, and the daemon scopes the lookup to the starting session, not to whichever
   * session this connection holds now. An id this connection was not told about is not one.
   */
  private finalizedRecordingRetrievalOwner(
    name: string,
    args: Record<string, unknown>,
  ): string | undefined {
    return name === "videoRecording" &&
      args.action === "stop" &&
      typeof args.recordingId === "string"
      ? this.finalizedRecordingOwners.get(args.recordingId)
      : undefined;
  }

  /**
   * Forward a finalized-recording retrieval. It names the starting session only so the daemon can
   * scope the lookup: like every read it never binds, holds, heartbeats or extends that session.
   */
  private async forwardFinalizedRecordingRetrieval(
    name: string,
    callerArgs: Record<string, unknown>,
    ownerSessionUuid: string,
    progressToken: string | number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ForwardedToolCall> {
    // Artifact lookup only reaches a resumed session when its owner is still held.
    const forwardedSessionUuid = this.isHeldSession(ownerSessionUuid)
      ? ownerSessionUuid
      : undefined;
    const forwardedArgs = this.withOneShotCliMarker(
      this.withAcceptanceConfiguration(
        this.withToolSelectionProfile({ ...callerArgs, sessionUuid: ownerSessionUuid }),
      ),
    );
    const result = await raceWithDeadline(
      this.withRecoverableReconnect(
        () => {
          signal?.throwIfAborted();
          const client = this.requireClient();
          return this.trackToolCallInFlight(client, () =>
            client.callTool(name, forwardedArgs, progressToken, undefined, signal),
          );
        },
        undefined,
        true,
        false,
        undefined,
        signal,
      ),
      { timer: this.timer, signal, label: `Daemon tool ${name}` },
    );
    return { result, forwardedSessionUuid };
  }

  private withOneShotCliMarker(args: Record<string, unknown>): Record<string, unknown> {
    return this.config.oneShotCli ? { ...args, [DAEMON_ONE_SHOT_CLI_PARAM]: true } : args;
  }

  private withAcceptanceConfiguration(args: Record<string, unknown>): Record<string, unknown> {
    const acceptanceDiscovery = this.config.acceptanceDiscovery;
    if (!acceptanceDiscovery) {
      return args;
    }
    return {
      ...args,
      [INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM]: acceptanceDiscovery.order,
      [INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM]: acceptanceDiscovery.capability,
    };
  }

  private isSessionlessControlDeviceTool(name: string, args?: Record<string, unknown>): boolean {
    return (
      !this.config.initialSessionUuid &&
      !isDeviceBindingTool(name) &&
      !isDeviceInventoryTool(name) &&
      name !== SET_TOOL_ENABLED_TOOL_NAME &&
      this.toolTargetsDevice(name) &&
      !this.isDeviceReadOnlyTool(name, args)
    );
  }

  /** A fenced control must name a held session or its known, unique device (#11656). */
  private withFencedControlDeviceSession(
    name: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.isSessionlessControlDeviceTool(name, args)) {
      return args;
    }
    // A selector call may itself discover the idle release. Fence before resolving its device,
    // so loss reporting, stall recovery and routing all see the same named survivor.
    if (!this.terminalBoundSession && this.isBoundSessionReplayExpired()) {
      this.retireIdleBinding(this.boundSessionUuid!);
    }
    const terminal = this.terminalBoundSession;
    if (!terminal) {
      return args;
    }
    const holder = this.sessionUuidFromArgs(args) ?? this.survivingSessionHoldingDevice(args);
    // The daemon must preserve its default as well: the fenced UUID marks this as one call
    // on a sibling, even though terminal fencing cleared the proxy's live binding.
    return holder === undefined
      ? args
      : { ...args, sessionUuid: holder, [DAEMON_BOUND_SESSION_PARAM]: terminal.sessionUuid };
  }

  private refuseAmbiguousSessionSelector(name: string, args: Record<string, unknown>): void {
    const platform = args.platform;
    const bound = this.boundSessionUuid;
    if (
      this.initialSessionBindingConfigured ||
      !this.isSessionlessControlDeviceTool(name, args) ||
      (platform !== "android" && platform !== "ios") ||
      typeof args.deviceId === "string" ||
      this.sessionUuidFromArgs(args) !== undefined ||
      args.device ||
      !bound ||
      this.terminalBoundSession
    ) {
      return;
    }
    // Unknown platforms cannot truthfully count as matches (#11714).
    const candidates = [...new Set([bound, ...this.otherHeldSessions.keys()])]
      .filter((id) => this.sessionPlatforms.get(id) === platform)
      .map((sessionUuid) => {
        const deviceId = this.sessionDeviceIds.get(sessionUuid);
        return { sessionUuid, ...(deviceId === undefined ? {} : { deviceId }) };
      });
    if (candidates.length > 1) {
      throw new DaemonAmbiguousSessionSelectorError(platform, candidates);
    }
  }

  private survivingSessionHoldingDevice(args: Record<string, unknown>): string | undefined {
    if (!this.hasImplicitDeviceSelector(args, false) || typeof args.deviceId !== "string") {
      return undefined;
    }
    let holder: string | undefined;
    for (const id of this.ownedDeviceSessions) {
      if (id === this.terminalBoundSession?.sessionUuid) {
        continue;
      }
      const deviceId = this.sessionDeviceIds.get(id);
      // An unknown device might be a second holder: do not guess uniqueness.
      if (deviceId === undefined) {
        return undefined;
      }
      if (deviceId === args.deviceId) {
        if (holder !== undefined) {
          return undefined;
        }
        holder = id;
      }
    }
    return holder;
  }

  private prepareToolRoutingArgs(
    name: string,
    callerArgs: Record<string, unknown>,
    isSessionAcquisition: boolean,
  ): {
    forwardedArgs: Record<string, unknown>;
    allowReleasedSession: boolean;
  } {
    const isTerminalSessionlessDiscovery =
      this.terminalBoundSession !== undefined &&
      this.sessionUuidFromArgs(callerArgs) === undefined &&
      (isDeviceInventoryTool(name) || this.isSessionlessReadAfterRelease(name, callerArgs));
    const usesDeviceSelector =
      this.toolTargetsDevice(name) &&
      this.hasImplicitDeviceSelector(callerArgs, name === "setActiveDevice") &&
      !this.platformSelectorTargetsBoundSession(name, callerArgs);
    const routingArgs =
      name === SET_TOOL_ENABLED_TOOL_NAME
        ? this.withAcquiredDeviceRoute(callerArgs)
        : isSessionAcquisition || isTerminalSessionlessDiscovery
          ? callerArgs
          : this.withBoundSessionUuid(callerArgs, usesDeviceSelector, name);
    const canUseSurvivingSession = this.canUseSurvivingSession(
      callerArgs,
      usesDeviceSelector,
      name,
    );
    const forwardedArgs = this.withToolSelectionProfile(
      this.withOwnedSessionCapabilities(
        routingArgs,
        usesDeviceSelector || isSessionAcquisition,
        this.namesOwnedSession(callerArgs),
        isSessionAcquisition,
      ),
    );
    return {
      forwardedArgs,
      allowReleasedSession:
        isSessionAcquisition || isTerminalSessionlessDiscovery || canUseSurvivingSession,
    };
  }

  /**
   * Read-only access never requires a session (owner decision 2026-10-09, #10971). After the
   * binding is released, a managed read-only tool naming a deviceId and no session is forwarded
   * without a session immediately, without marking the release as reported. Non-managed reads
   * require one call to report the release first. The daemon serves these on its read-only device
   * path. Control tools and managed reads without a deviceId keep the fence, as does a liveness
   * handover, which every call reports until the harness acts on it.
   */
  private isSessionlessReadAfterRelease(name: string, args: Record<string, unknown>): boolean {
    const terminal = this.terminalBoundSession;
    return (
      terminal !== undefined &&
      !this.stallHandovers.has(terminal.sessionUuid) &&
      this.releaseSurfacedFor === terminal.sessionUuid &&
      this.isDeviceReadOnlyTool(name, args)
    );
  }

  /**
   * Record that a tool call's answer named the fenced binding as released (#11483), as the entry
   * gate does: `answer` is a terminal refusal the daemon answered and this proxy relayed, or the
   * fence error raised while the call was in flight. A held session's terminal answer also
   * cancels its pending platform report: the caller has already been told about that loss.
   */
  private noteReleaseSurfacedBy(answer: unknown): void {
    const sessionUuid =
      answer instanceof DaemonBoundSessionExpiredError
        ? answer.sessionUuid
        : readTerminalSessionRefusal(answer)?.sessionUuid;
    if (sessionUuid !== undefined) {
      this.pendingHeldSessionPlatformLosses.delete(sessionUuid);
    }
    if (sessionUuid !== undefined && sessionUuid === this.terminalBoundSession?.sessionUuid) {
      this.releaseSurfacedFor = sessionUuid;
    }
  }

  // Kept as a named method: the liveness-clock guard follows the keeper's port to it.
  private recordHeldSessionTerminalLoss(
    ...args: Parameters<HeldSessionLosses["recordTerminalLoss"]>
  ): void {
    this.heldSessionLosses.recordTerminalLoss(...args);
  }

  private isDeviceReadOnlyTool(name: string, args?: Record<string, unknown>): boolean {
    const definition =
      this.cachedTools?.find((tool) => tool.name === name) ??
      this.staticToolDefinitionsProvider().find((tool) => tool.name === name);
    return (
      definition?._meta?.[DEVICE_READ_ONLY_META_KEY] === true ||
      (args !== undefined &&
        anyDeviceReadOnlyArgShapeMatches(definition?._meta?.[DEVICE_READ_ONLY_ARGS_META_KEY], args))
    );
  }

  private toolTargetsDevice(name: string): boolean {
    if (name === "setActiveDevice") {
      return true;
    }
    const schema =
      this.cachedTools?.find((definition) => definition.name === name)?.inputSchema ??
      this.staticToolDefinitionsProvider().find((definition) => definition.name === name)
        ?.inputSchema;
    // Device-targeting schemas expose the device-label contract. Plain
    // platform filters do not have it and must retain their session policy.
    return (
      typeof schema?.properties === "object" &&
      schema.properties !== null &&
      "device" in schema.properties
    );
  }

  /**
   * The caller explicitly named a session this proxy owns. After a reconnect the daemon may still
   * record a stale connection of this proxy as the session's owner, and it refuses a control call
   * naming a session another connection owns (#11344): such a call carries the owned sessions and
   * the owner token, so the daemon restores ownership to this connection first.
   */
  private namesOwnedSession(callerArgs: Record<string, unknown>): boolean {
    const named = this.sessionUuidFromArgs(callerArgs);
    return (
      named !== undefined &&
      named !== this.terminalBoundSession?.sessionUuid &&
      this.ownedDeviceSessions.has(named)
    );
  }

  private withOwnedSessionCapabilities(
    args: Record<string, unknown>,
    restore: boolean,
    namesOwnedSession = false,
    isSessionAcquisition: boolean,
  ): Record<string, unknown> {
    // Acquisition identity is independent of retained-session restoration. CLI callers keep
    // their existing wire, including the owner token when restoration itself requires it.
    const acquisitionIdentity = (): Record<string, unknown> =>
      this.config.oneShotCli || this.cliSessionLivenessDeclared
        ? args
        : { ...args, [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: this.livenessOwnerToken };
    args = acquisitionIdentity();
    if (!namesOwnedSession && (!restore || this.sessionUuidFromArgs(args))) {
      return args;
    }
    const retained = [...this.ownedDeviceSessions].filter(
      (id) => id !== this.terminalBoundSession?.sessionUuid && id !== this.boundSessionUuid,
    );
    if (
      this.boundSessionUuid &&
      this.boundSessionUuid !== this.terminalBoundSession?.sessionUuid &&
      ((isSessionAcquisition && this.recoverableBoundSessionHandoffIsDeviceRestart) ||
        this.boundSessionUuid !== this.recoverableBoundSessionHandoff)
    ) {
      // Restoration uses the first "if-absent" attachment as the fresh socket's
      // default, so the current binding must precede older owned sessions.
      retained.unshift(this.boundSessionUuid);
    }
    // The owner token lets the daemon move ownership to this connection even while a stale
    // connection of this proxy still holds it; a bare UUID only restores an unowned session (#11107).
    return retained.length
      ? {
          ...args,
          [DAEMON_OWNED_SESSIONS_PARAM]: retained,
          [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: this.livenessOwnerToken,
        }
      : args;
  }

  private rememberActiveDeviceSession(
    name: string,
    args: Record<string, unknown>,
    result: unknown,
    releaseEpoch: number,
  ): void {
    if (name !== "setActiveDevice") {
      return;
    }
    const selection = getActiveDeviceSelectionFromResult(result);
    if (selection) {
      this.throwIfSessionReleasedSince(selection.sessionUuid, releaseEpoch);
      this.sessionBinding.rememberSessionUuid(name, selection, releaseEpoch, true);
      this.heldSessionLosses.clearForSelection(selection.sessionUuid, args.platform);
    }
  }

  private hasImplicitDeviceSelector(
    args: Record<string, unknown>,
    selectingActiveDevice: boolean,
  ): boolean {
    if (this.initialSessionBindingConfigured || args.device) {
      return false;
    }
    if (selectingActiveDevice) {
      return true;
    }
    return (
      typeof args.deviceId === "string" || args.platform === "android" || args.platform === "ios"
    );
  }

  /** A platform-only call uses the default only when it is the unique known held match. */
  private platformSelectorTargetsBoundSession(
    name: string,
    args: Record<string, unknown>,
  ): boolean {
    const ownSession = this.ownSessionForPlatformSelector(name, args);
    return ownSession !== undefined && ownSession === this.boundSessionUuid;
  }

  /**
   * Route platform-only device calls to their unique held session when every held platform is
   * known. Sibling-only selection preserves startup binding and expired-default routing;
   * default selection leaves injection and release reporting to the existing bound-session path.
   */
  private ownSessionForPlatformSelector(
    name: string,
    args: Record<string, unknown>,
    siblingOnly = false,
  ): string | undefined {
    const bound = this.boundSessionUuid;
    if (
      isDeviceBindingTool(name) ||
      !this.toolTargetsDevice(name) ||
      !this.hasImplicitDeviceSelector(args, false) ||
      typeof args.deviceId === "string" ||
      this.sessionUuidFromArgs(args) !== undefined ||
      (siblingOnly && this.shouldPreserveSiblingSelectorRouting()) ||
      !bound ||
      this.terminalBoundSession
    ) {
      return undefined;
    }
    const held = [...new Set([bound, ...this.otherHeldSessions.keys()])];
    if (held.some((id) => this.sessionPlatforms.get(id) === undefined)) {
      return undefined;
    }
    const candidates = held.filter((id) => this.sessionPlatforms.get(id) === args.platform);
    return candidates.find((id) => candidates.length === 1 && (!siblingOnly || id !== bound));
  }

  private shouldPreserveSiblingSelectorRouting(): boolean {
    return !!this.config.initialSessionUuid || this.isBoundSessionReplayExpired();
  }

  /**
   * A session this proxy holds under its own token (#10990) is routable beside the startup
   * binding. So is a `${bound}:${label}` name (#11602): whether it is a live label of the bound
   * session's plan is the daemon's to judge, which alone knows the label map.
   */
  private routableBesideStartupBinding(sessionUuid: string): boolean {
    return (
      this.otherHeldSessions.has(sessionUuid) || sessionUuid.startsWith(`${this.boundSessionUuid}:`)
    );
  }

  private withBoundSessionUuid(
    args: Record<string, unknown>,
    usesDeviceSelector = false,
    toolName?: string,
  ): Record<string, unknown> {
    // A daemon session released by ordinary heartbeat/idle expiry leaves this
    // remembered binding dangling; replaying its UUID on a later sessionless call
    // would silently recreate the session and reacquire a device without the
    // caller asking for it (issue #4610). Once the replay window has elapsed with
    // no forwarded call (explicit or implicit) refreshing the binding, treat it
    // as retired.
    const explicitSessionUuid = this.sessionUuidFromArgs(args);
    if (!this.canUseSurvivingSession(args, usesDeviceSelector, toolName)) {
      this.throwIfBoundSessionUnavailable(explicitSessionUuid, () =>
        this.canUseSurvivingSession(args, usesDeviceSelector, toolName),
      );
    }
    const normalizedArgs =
      explicitSessionUuid && explicitSessionUuid !== args.sessionUuid
        ? { ...args, sessionUuid: explicitSessionUuid }
        : args;
    if (!this.boundSessionUuid || explicitSessionUuid === this.boundSessionUuid) {
      return normalizedArgs;
    }
    const enforcesStartupBinding = () =>
      this.initialSessionBindingConfigured &&
      (toolName === undefined || !this.isDeviceReadOnlyTool(toolName, args));
    if (
      explicitSessionUuid &&
      enforcesStartupBinding() &&
      !this.routableBesideStartupBinding(explicitSessionUuid)
    ) {
      throw new SessionOutsideBoundSessionError(this.boundSessionUuid, explicitSessionUuid);
    }
    if (explicitSessionUuid) {
      // The call targets the named session only. Carrying the binding beside it tells the daemon
      // socket that this connection's default is unchanged, so its route stays put (#11347).
      return { ...normalizedArgs, [DAEMON_BOUND_SESSION_PARAM]: this.boundSessionUuid };
    }
    // A caller's device selector must reach daemon autolock resolution without
    // being disguised as an explicitly supplied session UUID (#6807).
    if (usesDeviceSelector) {
      return normalizedArgs;
    }
    return {
      ...args,
      sessionUuid: this.boundSessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: this.boundSessionUuid,
    };
  }

  private canUseSurvivingSession(
    args: Record<string, unknown>,
    usesDeviceSelector: boolean,
    toolName?: string,
  ): boolean {
    if (!this.terminalBoundSession || this.config.initialSessionUuid) {
      return false;
    }
    const explicit = this.sessionUuidFromArgs(args);
    const liveOwned = [...this.ownedDeviceSessions].filter(
      (id) => id !== this.terminalBoundSession?.sessionUuid,
    );
    return explicit
      ? liveOwned.includes(explicit)
      : liveOwned.length > 0 &&
          usesDeviceSelector &&
          (toolName === undefined ||
            toolName === "setActiveDevice" ||
            this.isDeviceReadOnlyTool(toolName, args));
  }

  private throwIfBoundSessionUnavailable(
    explicitSessionUuid?: string,
    survivingSessionUsable?: () => boolean,
  ): void {
    this.throwIfFencedForCaller(explicitSessionUuid);
    if (!this.isBoundSessionReplayExpired()) {
      return;
    }
    this.retireIdleBinding(this.boundSessionUuid!);
    // The latest binding idled out, but a selector call may still reach another live session
    // this proxy holds (#10692): only the idle binding is retired, not the caller's device.
    if (survivingSessionUsable?.()) {
      return;
    }
    this.throwIfFencedForCaller(explicitSessionUuid);
  }

  private throwIfPlainRestartSessionLost(sessionUuid?: string): void {
    if (sessionUuid === undefined) {
      return;
    }
    const reason = this.plainRestartSessionLosses.get(sessionUuid);
    if (reason === undefined) {
      return;
    }
    const terminal = this.terminalBoundSession;
    const release =
      this.pendingHeldSessionPlatformLosses.get(sessionUuid)?.release ??
      (terminal?.sessionUuid === sessionUuid ? terminal.release : undefined);
    const answer = new DaemonBoundSessionExpiredError(sessionUuid, reason, release);
    this.noteReleaseSurfacedBy(answer);
    throw answer;
  }

  // Surface a terminal fence to a caller, distinguishing whether the caller
  // referenced the fenced session. A client-declared binding (explicit
  // `sessionUuid`, or the same UUID named again) — or any explicit reference to
  // the fenced UUID — yields the ownership-lost-for-UUID error. A call that never
  // named the session and whose binding was minted by a device-acquisition RESULT
  // instead gets the current connection state, not a stale UUID (issue #5689).
  //
  // This is the entry-gate check for calls arriving at an ALREADY-fenced
  // connection. A session released WHILE a call is actively holding it (the
  // narrow mid-flight-release race) still surfaces the generic ownership-lost
  // error for that UUID via the in-flight fence checks in
  // withRecoverableReconnect — consistent with the established mid-flight-release
  // semantics for every binding — and self-heals: the next call reaches this gate
  // and gets the provenance-aware error.
  private throwIfFencedForCaller(explicitSessionUuid?: string): void {
    this.throwIfPlainRestartSessionLost(explicitSessionUuid);
    const terminal = this.terminalBoundSession;
    if (!terminal) {
      return;
    }
    // A liveness handover (#10053) is always reported: the harness must be told which sessions
    // and devices it lost and what to do, whichever call reaches the fenced binding first.
    const callerReferencedTerminal =
      !terminal.fromResultMint ||
      this.stallHandovers.has(terminal.sessionUuid) ||
      (explicitSessionUuid !== undefined && explicitSessionUuid === terminal.sessionUuid);
    // The agent has now been told about this release; later reads go through without a session.
    this.releaseSurfacedFor = terminal.sessionUuid;
    if (callerReferencedTerminal) {
      const answer = this.boundSessionExpiredError(explicitSessionUuid);
      this.noteReleaseSurfacedBy(answer);
      throw answer;
    }
    throw new DaemonConnectionSessionReleasedError(terminal.reason);
  }

  private sessionUuidFromArgs(args: Record<string, unknown>): string | undefined {
    return sessionUuidFromArgs(args);
  }

  /**
   * A `setToolEnabled` that reaffirms THIS connection's profile keeps that
   * profile as its routing session, but the daemon would otherwise seed the
   * loopback it lands on with the profile as a DEVICE binding, so the update's
   * readback enumerated labels from the profile (none) instead of from the
   * device session this connection acquired. Carry the acquired device route
   * separately so the daemon seeds the loopback with it (#7005). A profile
   * update on a connection with no live device carries nothing extra.
   */
  private withAcquiredDeviceRoute(args: Record<string, unknown>): Record<string, unknown> {
    const explicitSessionUuid = this.sessionUuidFromArgs(args);
    if (
      !explicitSessionUuid ||
      explicitSessionUuid !== this.toolSelectionProfileUuid ||
      !this.boundSessionUuid ||
      this.boundSessionUuid === explicitSessionUuid ||
      this.terminalBoundSession ||
      this.isBoundSessionReplayExpired()
    ) {
      return args;
    }
    return { ...args, [DAEMON_BOUND_SESSION_PARAM]: this.boundSessionUuid };
  }

  private withToolSelectionProfile(args: Record<string, unknown>): Record<string, unknown> {
    if (!this.toolSelectionProfileUuid) {
      return args;
    }
    return {
      ...args,
      [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: this.toolSelectionProfileUuid,
    };
  }

  private rememberToolSelectionProfile(
    name: string,
    requestedArgs: Record<string, unknown>,
    result: unknown,
  ): void {
    if (name !== SET_TOOL_ENABLED_TOOL_NAME) {
      return;
    }
    const explicitSessionUuid =
      typeof requestedArgs.sessionUuid === "string" && requestedArgs.sessionUuid.trim().length > 0
        ? requestedArgs.sessionUuid
        : undefined;
    const responseProfileUuid = toolSelectionProfileUuidFromResponse(result);
    if (!explicitSessionUuid) {
      if (responseProfileUuid) {
        this.toolSelectionProfileUuid = responseProfileUuid;
      }
    } else if (responseProfileUuid === explicitSessionUuid) {
      // toolSelectionProfileUuidFromResponse only returns server-confirmed
      // connection-profile responses. Retain a successful self-reaffirm so
      // withToolSelectionProfile() can attach it to later acquisitions.
      this.toolSelectionProfileUuid = responseProfileUuid;
    }
    // Do not depend solely on the daemon's best-effort list_changed delivery.
    // The successful update has already changed the authoritative tool surface.
    this.notifyListChanged("tools");
  }

  private isBoundSessionReplayExpired(): boolean {
    if (
      this.initialSessionBindingConfigured ||
      this.boundSessionUuid === undefined ||
      this.boundSessionUuidAt === undefined ||
      // A call still running on the binding is use: the idle window counts from when it ends.
      this.hasSessionCallInFlight(this.boundSessionUuid)
    ) {
      return false;
    }
    return (
      this.timer.now() - this.boundSessionUuidAt >= this.boundSessionReplayTtlMs &&
      !this.daemonKeepsSessionInUse(this.boundSessionUuid)
    );
  }

  /** Record reported heartbeat evidence only while tracking the session; absence proves nothing. */
  private noteHeartbeatDaemonInstance(
    sessionUuid: string,
    daemonInstance: string | undefined,
  ): boolean {
    if (daemonInstance === undefined || !this.isHeldSession(sessionUuid)) {
      return false;
    }
    const previousInstance = this.sessionDaemonInstances.get(sessionUuid);
    this.sessionDaemonInstances.set(sessionUuid, daemonInstance);
    return previousInstance !== undefined && previousInstance !== daemonInstance;
  }

  /** Keep the daemon's idle deadline or explicit exemption; absence alone permits fallback. */
  private noteDaemonIdleEvidence(sessionUuid: string, ack: unknown): void {
    // An ack can arrive after a held session was dropped. End its retained history without
    // creating process evidence for a session that is no longer heartbeated.
    if (!this.isHeldSession(sessionUuid)) {
      this.notFoundWindows.delete(sessionUuid);
      this.sessionDaemonInstances.delete(sessionUuid);
    }
    const daemonInstance = ackDaemonInstance(ack);
    if (daemonInstance !== undefined) {
      this.ackedDaemonInstance = daemonInstance;
      this.noteHeartbeatDaemonInstance(sessionUuid, daemonInstance);
    }
    const releaseAt = (ack as { idleReleaseAt?: unknown } | null | undefined)?.idleReleaseAt;
    if (releaseAt === null || (typeof releaseAt === "number" && Number.isFinite(releaseAt))) {
      this.daemonIdleReports.set(sessionUuid, { releaseAt, reportedAt: this.timer.now() });
    } else {
      this.daemonIdleReports.delete(sessionUuid);
    }
  }

  /**
   * The daemon is authoritative for idle release (#10823, #10972): the proxy's own idle clock (its
   * environment, its call bookkeeping) only stands in for a daemon that reports nothing. Once the
   * daemon has reported null, idleness never retires it locally. Once it reports an instant,
   * the local window never retires the session on its
   * own. It is kept:
   * - while liveness recovery runs for it: a missed ack is not evidence of idleness;
   * - while the reported instant is in the future, however long ago the last ack arrived;
   * - while the report predates its instant: a tool call since then (inside the daemon's grace)
   *   may have moved it, so only a heartbeat answered at or after the instant proves it passed.
   * A not-found answer or a release notification ends the session through their own paths.
   */
  private daemonKeepsSessionInUse(sessionUuid: string): boolean {
    if (this.livenessRecovery.isRecovering(sessionUuid)) {
      return true;
    }
    const report = this.daemonIdleReports.get(sessionUuid);
    if (report === undefined) {
      return false;
    }
    return (
      report.releaseAt === null ||
      this.timer.now() < report.releaseAt ||
      report.reportedAt < report.releaseAt
    );
  }

  private hasSessionCallInFlight(sessionUuid: string): boolean {
    return (this.sessionCallsInFlight.get(sessionUuid) ?? 0) > 0;
  }

  /**
   * Count a forwarded call against the sessions it uses; returns the UUIDs to pass to
   * {@link endSessionCall}. Inventory observation and every other plain (non-device) read never
   * use the session they name, so they neither hold nor refresh it (#11107).
   */
  private beginSessionCall(name: string, sessionUuids: readonly string[]): readonly string[] {
    if (
      isDeviceInventoryTool(name) ||
      (this.isDeviceReadOnlyTool(name) && !this.toolTargetsDevice(name))
    ) {
      return [];
    }
    for (const sessionUuid of sessionUuids) {
      this.sessionCallsInFlight.set(
        sessionUuid,
        (this.sessionCallsInFlight.get(sessionUuid) ?? 0) + 1,
      );
    }
    return sessionUuids;
  }

  /**
   * The session a forwarded call names, when it names one. Naming a session is not use (#10964).
   */
  private sessionsUsedByCall(forwardedSessionUuid: string | undefined): string[] {
    return forwardedSessionUuid !== undefined ? [forwardedSessionUuid] : [];
  }

  /**
   * Credit the session the daemon says it admitted a call under and used (#10974): exactly that
   * session, when it is the latest binding or one this proxy holds. The daemon omits the echo for
   * reads, refused calls and sessionless calls, so those credit nothing. The echo is the only
   * credit from the first call on: the proxy and daemon versions match exactly, so there is no
   * daemon that cannot echo, and crediting what a call named would let a read move the idle clock
   * (#11348). A binding declared in a call's args is credited too: it is not heartbeated, but its
   * replay lease follows its use (#4610).
   */
  private creditRoutedSession(result: unknown, forwardedSessionUuid: string | undefined): void {
    const routed = routedSessionUuidFromResult(result);
    // A non-terminal answer clears only that session's proxy-judged idle eviction;
    // daemon-confirmed losses survive. Reads have no routed-use echo, so use their
    // forwarded UUID without restarting protection.
    const answeredSessionUuid = routed ?? forwardedSessionUuid;
    if (
      answeredSessionUuid !== undefined &&
      this.pendingHeldSessionPlatformLosses.get(answeredSessionUuid)?.proxyJudged === true &&
      readTerminalSessionRefusal(result)?.sessionUuid !== answeredSessionUuid
    ) {
      this.pendingHeldSessionPlatformLosses.delete(answeredSessionUuid);
    }
    if (routed !== undefined) {
      this.noteSessionRestoredByCall(routed);
      this.creditSessionUse(routed);
    }
  }

  /**
   * A call forwarded under `sessionUuid` ended: it no longer holds the session in flight. Ending
   * credits nothing. A read naming a session is watching, not use (#10964), so the idle window
   * restarts only from the daemon's echo of admitted use ({@link creditRoutedSession}).
   */
  private endSessionCall(sessionUuids: readonly string[]): void {
    for (const sessionUuid of sessionUuids) {
      const remaining = (this.sessionCallsInFlight.get(sessionUuid) ?? 1) - 1;
      if (remaining > 0) {
        this.sessionCallsInFlight.set(sessionUuid, remaining);
      } else {
        this.sessionCallsInFlight.delete(sessionUuid);
      }
    }
  }

  /** Restart a session's idle window now: a tool call used it. */
  private creditSessionUse(sessionUuid: string): void {
    const now = this.timer.now();
    if (sessionUuid === this.boundSessionUuid && !this.terminalBoundSession) {
      this.boundSessionUuidAt = now;
    }
    const held = this.otherHeldSessions.get(sessionUuid);
    if (held) {
      held.lastUsedAt = now;
    }
  }

  private clearBoundSessionUuid(): void {
    if (this.boundSessionUuid !== undefined) {
      this.clearNotFoundHistory(this.boundSessionUuid);
    }
    this.boundSessionUuid = undefined;
    this.boundSessionUuidAt = undefined;
    this.initialSessionBindingConfigured = false;
    this.initialSessionAwaitingFirstCall = false;
    this.boundSessionFromResultMint = false;
    this.livenessOwnershipClaimSent = false;
    this.latestBindingConflict = undefined;
    this.recoverableBoundSessionHandoff = undefined;
    this.recoverableBoundSessionHandoffIsDeviceRestart = false;
  }

  /**
   * The one place this proxy retires its own idle binding, called by
   * withFencedControlDeviceSession, throwIfBoundSessionUnavailable,
   * discoveryAfterResultMintRelease and retireIdleLatestBinding.
   *
   * A daemon idle report still held here means isBoundSessionReplayExpired saw a heartbeat
   * answered at or after the daemon's reported idle instant. This is the session's idle end,
   * named with the reason the daemon records for it. Without a report, the proxy's own clock
   * judged the binding idle, so its reason is proxy-local. Read the reason before fencing:
   * fenceBoundSessionUuid forgets the report through forgetSessionLivenessState.
   *
   * A one-shot CLI's cli-idle-timeout report cannot reach here: adoptCliSessionLiveness stops
   * and drains the keeper, sends the CLI declaration without recording its acknowledgement
   * through noteDaemonIdleEvidence, then the CLI closes without another tool call.
   */
  private retireIdleBinding(sessionUuid: string): void {
    this.fenceBoundSessionUuid(sessionUuid, this.idleSessionReleaseReason(sessionUuid));
  }

  private idleSessionReleaseReason(sessionUuid: string): string {
    return this.daemonIdleReports.has(sessionUuid)
      ? IDLE_WINDOW_RELEASE_REASON
      : REPLAY_LEASE_EXPIRED_REASON;
  }

  private fenceBoundSessionUuid(
    sessionUuid: string,
    reason: string,
    release?: SessionReleaseSnapshot,
  ): void {
    const handedOver = reason === DAEMON_STALLED_CODE || reason === PROXY_STALLED_CODE;
    this.dropHeldSession(sessionUuid, handedOver);
    this.forgetSessionLivenessState(sessionUuid, handedOver);
    if (this.terminalBoundSession) {
      if (this.terminalBoundSession.sessionUuid === sessionUuid) {
        if (reason !== "released") {
          this.terminalBoundSession.reason = reason;
        }
        this.terminalBoundSession.release = release ?? this.terminalBoundSession.release;
      }
      return;
    }
    // A surfaced release belongs to this fence alone, even when a later fence reuses its UUID.
    this.releaseSurfacedFor = undefined;
    this.terminalBoundSession = {
      sessionUuid,
      reason,
      fromResultMint: this.boundSessionFromResultMint,
      ...(release ? { release } : {}),
    };
    // A terminal release changes the scope of in-flight discovery and prevents
    // its stale response from repopulating a cleared cache.
    this.discoveryEpoch += 1;
    this.invalidateCache();
    this.clearBoundSessionUuid();
    // Other held sessions keep depending on this keeper after the latest binding
    // is fenced, so it only stops once nothing is left to heartbeat (#9335).
    this.syncHeartbeatKeeper();
    // A result-minted binding scoped the tool list the client last fetched; the
    // connection is now unbound, so prompt a re-list (binding does the same).
    // A declared binding's discovery keeps failing, so there is nothing to refresh.
    if (this.terminalBoundSession.fromResultMint) {
      this.notifyListChanged("tools");
    }
  }

  /**
   * Entry gate for tools/list, resources/list and resources/templates/list.
   * Returns true when the only fence is a RESULT-MINTED session that was
   * released: the connection is then unbound and recovers in-band through
   * getAndroid/getApple, so discovery must keep working and list the surface that
   * contains those tools (#9997). A client-declared binding cannot recover on its
   * transport, so its fence still raises the ownership-lost error (#5689).
   */
  private discoveryAfterResultMintRelease(): boolean {
    if (!this.terminalBoundSession && this.isBoundSessionReplayExpired()) {
      this.retireIdleBinding(this.boundSessionUuid!);
    }
    const terminal = this.terminalBoundSession;
    if (!terminal) {
      return false;
    }
    if (!terminal.fromResultMint) {
      throw this.boundSessionExpiredError();
    }
    return true;
  }

  /**
   * Refuse an operation because the latest binding is fenced. A fence is that session's alone
   * (#11570): an operation naming another session this proxy still owns goes on, as it would
   * had the fence been there when the operation started ({@link canUseSurvivingSession}), instead
   * of being refused under the fenced session's reason because the fence landed while it waited
   * for the connection.
   */
  private throwIfBoundSessionFenced(allowReleasedSession = false, namedSessionUuid?: string): void {
    if (!allowReleasedSession) {
      this.throwIfPlainRestartSessionLost(namedSessionUuid);
    }
    if (
      this.terminalBoundSession &&
      !allowReleasedSession &&
      !(
        namedSessionUuid !== undefined &&
        this.canUseSurvivingSession({ sessionUuid: namedSessionUuid }, false)
      )
    ) {
      throw this.boundSessionExpiredError(namedSessionUuid);
    }
  }

  /**
   * The ownership-lost error for the fenced binding. `namedSessionUuid` is the session the failing
   * call referenced: when it is not the fenced binding (this proxy fences only its latest one) the
   * error reports the named session, never the unrelated latest binding (#10991).
   */
  private boundSessionExpiredError(namedSessionUuid?: string): DaemonBoundSessionExpiredError {
    const terminal = this.terminalBoundSession;
    if (!terminal) {
      throw new Error("Bound session is not terminal");
    }
    if (namedSessionUuid !== undefined && namedSessionUuid !== terminal.sessionUuid) {
      const namedStall = this.stallHandovers.get(namedSessionUuid);
      if (namedStall) {
        namedStall.delivered = true;
        return new DaemonSessionStalledError(
          namedSessionUuid,
          this.currentHandover(namedSessionUuid, namedStall),
        );
      }
      if (!this.stallHandovers.has(terminal.sessionUuid)) {
        return new DaemonBoundSessionExpiredError(
          namedSessionUuid,
          this.releasedSessionReasons.get(namedSessionUuid) ?? terminal.reason,
        );
      }
    }
    const stall = this.stallHandovers.get(terminal.sessionUuid);
    if (stall) {
      stall.delivered = true;
      return new DaemonSessionStalledError(
        terminal.sessionUuid,
        this.currentHandover(terminal.sessionUuid, stall),
      );
    }
    return new DaemonBoundSessionExpiredError(
      terminal.sessionUuid,
      terminal.reason,
      terminal.release,
    );
  }

  /**
   * The daemon transport is live and usable for a heartbeat. Distinct from the
   * public `connected` flag, which is deferred until AFTER the establishment
   * heartbeat lands so concurrent ensureConnected() callers block on ownership
   * (issue #5643). During that window the client has connected but `connected` is
   * still false; the first-heartbeat / keeper guards must treat the transport as
   * usable. Everywhere else `this.client !== null` tracks `connected` (both are
   * set on connect and cleared together on reset/close), so this only widens the
   * guard across the deliberate establishment window.
   */
  private get transportLive(): boolean {
    return this.client !== null;
  }

  /**
   * The live client for an operation closure. A socket close can land between
   * ensureConnected() resolving and the closure running (#6389); report that as
   * a recoverable DaemonUnavailableError rather than a TypeError on null. No
   * client means no request frame was written, so the failure is typed as not
   * delivered: a non-idempotent tool may then be retried on the reconnected
   * client instead of being reported as outcome-unknown (#9996).
   */
  private requireClient(): DaemonClientLike {
    if (!this.client) {
      throw new DaemonRequestNotDeliveredError("Daemon socket connection is not established");
    }
    return this.client;
  }

  /**
   * Heartbeat state machine (#11411, #11400). The proxy tracks the LATEST binding
   * (`boundSessionUuid`), the sessions it HOLDS besides it (`otherHeldSessions`) and one terminal
   * FENCE (`terminalBoundSession`); the keeper is one interval for all of them.
   *
   * | state of a session                                   | keeper     | heartbeated | its next call             |
   * | ---------------------------------------------------- | ---------- | ----------- | ------------------------- |
   * | latest, claimable (minted here or startup-declared)  | runs       | every tick  | forwarded                 |
   * | latest, only named in a call's args (#10664)         | for others | never       | forwarded                 |
   * | held                                                 | runs       | every tick  | forwarded                 |
   * | latest or held, inside its not-found window: a       | runs       | once a tick,| forwarded: the daemon     |
   * |   heartbeat was answered not-found with a recoverable|            | claiming, no| restores it or refuses    |
   * |   reason (a daemon restart or shutdown,              |            | socket reset|                           |
   * |   `device-restart:<id>`, #11461), or with any answer |            |             |                           |
   * |   that does not end it as its first on a connection  |            |             |                           |
   * |   that was just established (a restarted daemon that |            |             |                           |
   * |   has not rehydrated it; #11529, #11557, #11570)     |            |             |                           |
   * | latest, stopped: answered not-found past its window, | for others | not until a | forwarded: the daemon     |
   * |   or with no reason on a connection that had answered|            | call reaches| restores it or refuses,   |
   * |   before (asked once more on a fresh one)            |            | it again    | and success re-arms it    |
   * | held, stopped the same way: dropped                  | for others | not until a | forwarded; the daemon's   |
   * |                                                      |            | call uses it| echo of use holds it again|
   * | held, answered not-found with a reason that ends it  | for others | never       | forwarded, daemon refuses |
   * | fenced (the latest, for any release reason that is   | for others | never       | refused locally           |
   * |   not recoverable, an expired replay lease or        |            |             |                           |
   * |   exhausted liveness recovery)                       |            |             |                           |
   *
   * "for others" means the session itself asks for no keeper: the keeper runs exactly when some
   * session in a "runs" row exists ({@link hasHeartbeatTargets}), whatever became of its siblings.
   * A fence never coexists with a latest binding. A release reason is classified in one place,
   * {@link releaseKeepsBinding}, for the release notification and every not-found heartbeat alike,
   * and what a not-found heartbeat answer means is decided in one place,
   * {@link decideNotFoundAnswer}, from that session's own state, whichever heartbeat heard it: a
   * keeper tick, the first heartbeat of a connection or liveness recovery. The whole machine is
   * written out as states and events in test/daemon/proxyHeartbeatStateMachine.property.test.ts.
   * {@link syncHeartbeatKeeper} is the one place that starts the keeper, and the one that stops it
   * because nothing is left to heartbeat. The only other stops are awaited pauses with sessions
   * still held: binding a result-minted session (which syncs again on every way out), a one-shot
   * CLI handing its session to the daemon's idle timeout, and close().
   */
  private hasHeartbeatTargets(): boolean {
    return this.otherHeldSessions.size > 0 || this.latestBindingHeartbeatable();
  }

  /** The latest binding is claimable and the daemon has not answered not-found for it. */
  private latestBindingHeartbeatable(): boolean {
    return this.latestBindingClaimable() && !this.notFoundStopped.has(this.boundSessionUuid!);
  }

  /**
   * Make the keeper match the table above: stopped once nothing is left to heartbeat, running
   * while anything is. Called wherever the latest binding, the held set or the fence changes. A
   * keeper that lost its transport keeps running: its tick drives the reconnect.
   */
  private syncHeartbeatKeeper(): void {
    if (!this.hasHeartbeatTargets()) {
      if (this.heartbeatKeeperStarted) {
        // Cleared now, not once the tick in flight settles: a session held again meanwhile
        // must find the keeper stopped and restart it.
        this.heartbeatKeeperStarted = false;
        this.tickLateness.reset();
        void this.heartbeatKeeper.stop();
      }
      return;
    }
    if (this.heartbeatKeeperStarted || this.closing || !this.transportLive) {
      return;
    }
    // A fresh cadence, seeded so even its first tick can be recognised as late (#10053).
    this.tickLateness.note(this.timer.now());
    this.heartbeatKeeper.start();
    this.heartbeatKeeperStarted = true;
  }

  private startBoundSessionHeartbeat(): void {
    if (
      this.boundSessionUuid &&
      !this.terminalBoundSession &&
      // An args-named latest binding is never heartbeated (#10664); the keeper still runs
      // for the sessions this proxy holds besides it.
      (this.latestBindingClaimable() || this.otherHeldSessions.size > 0) &&
      this.transportLive &&
      !this.closing
    ) {
      void this.heartbeatKeeper.run();
      this.syncHeartbeatKeeper();
    }
  }

  /**
   * Deliver the first ownership heartbeat as part of connection establishment for
   * a bound session (issue #5637), then start the recurring keeper.
   *
   * A newly connected client whose session was allocated shortly before startup
   * must reach the daemon with its first heartbeat before the pre-first-heartbeat
   * fast-reclaim (issue #2443) can release it. Awaiting the send here makes the
   * guarantee contractual: once ensureConnected() resolves for a bound session,
   * the daemon has recorded ownership — instead of racing a fire-and-forget
   * dispatch against the reclaim sweep.
   *
   * Only the FIRST establishment sends here: once the keeper is running it owns
   * every subsequent tick, so a later reconnect (which may itself be driven by a
   * keeper tick) defers to the keeper's own coalesced heartbeat rather than
   * emitting a duplicate.
   */
  private async establishBoundSessionHeartbeat(established?: DaemonClientLike): Promise<void> {
    if (established !== undefined && this.client === established && this.heartbeatKeeperStarted) {
      // With or without a latest binding: the sessions held besides it are re-established on
      // this connection by the keeper's next tick too (#11557).
      this.noteOwnershipReestablishment(established);
    }
    if (
      !(this.boundSessionUuid && !this.terminalBoundSession && this.transportLive && !this.closing)
    ) {
      this.syncHeartbeatKeeper();
      return;
    }
    if (this.heartbeatKeeperStarted) {
      // Reconnect/rebind: fall back to the keeper's own coalescing run(). If this
      // reconnect is itself driven by a keeper tick, run() shares that in-flight
      // tick instead of emitting a duplicate; otherwise it sends a fresh heartbeat
      // on the new transport, exactly as before this change.
      //
      // Ownership was already recorded by the first establishment, so — unlike the
      // first-heartbeat path (issue #5643) — there is nothing to hold concurrent
      // callers behind. Mark the transport connected BEFORE dispatching the keeper
      // heartbeat: startBoundSessionHeartbeat void-dispatches run(), which re-enters
      // ensureConnected() and must short-circuit on the fast path so the heartbeat
      // lands on the fresh transport before the retried operation (#2737/#4610
      // ordering). doConnect defers this flip only on the first establishment.
      this.connected = true;
      this.startBoundSessionHeartbeat();
      return;
    }
    if (!this.latestBindingHeartbeatable()) {
      // Only named in a tool call's args: never claimed or heartbeated (#10664). Or the daemon
      // answered not-found for it: a tool call restores it, not another heartbeat (#10702).
      this.syncHeartbeatKeeper();
      return;
    }
    await this.sendFirstBoundSessionHeartbeat();
    // Re-validate after the awaited round-trip: a session-released notification or close()
    // landing mid-send may have fenced this binding. The keeper then runs only for the sessions
    // still held besides it (#11411), never as a no-op interval for a fenced binding. Otherwise it
    // owns every subsequent tick, its reconnect, and terminal fencing. No immediate run(): the
    // direct send above already delivered the first heartbeat, and a second would duplicate it.
    this.syncHeartbeatKeeper();
  }

  /**
   * Resume every live session this proxy's stable owner token owns (#10990). A proxy restarted
   * with the same `--liveness-owner-token` asks the daemon which sessions the token owns, holds
   * each one it does not already track, and re-claims them on this connection before the
   * owner-disconnect grace releases them; the keeper heartbeats them from then on. Only the
   * owning token learns its sessions, so another token's sessions stay isolated (#10664).
   * Runs on every connection: after a transport reconnect it finds nothing new.
   */
  private async resumeTokenOwnedSessions(client: DaemonClientLike): Promise<void> {
    if (!stableLivenessOwnerToken(this.config) || this.closing || this.client !== client) {
      return;
    }
    let owned: TokenOwnedSession[];
    try {
      owned = parseTokenOwnedSessions(
        await client.callDaemonMethod(DAEMON_TOKEN_OWNED_SESSIONS_METHOD, {
          livenessOwnerToken: this.livenessOwnerToken,
        }),
      );
    } catch (error) {
      // Best-effort: an older daemon does not know the method. Sessions named in tool calls still
      // route, and the connection must not fail over a resume it cannot perform.
      logger.warn(
        `[DaemonMcpProxy] Could not list the sessions this owner token holds: ${errorMessage(error)}`,
        error,
      );
      return;
    }
    const resumed = owned.filter((session) => this.holdTokenOwnedSession(session));
    if (resumed.length === 0) {
      return;
    }
    logger.info(
      `[DaemonMcpProxy] Resuming ${resumed.length} session(s) this owner token holds: ${resumed
        .map((session) => session.sessionId)
        .join(", ")}`,
    );
    await Promise.all(resumed.map((session) => this.sendResumeClaim(client, session.sessionId)));
    this.syncHeartbeatKeeper();
  }

  /**
   * Hold a token-owned session this proxy does not track yet; false when there is nothing to do.
   * A session with a pending stall handover is not this resume's to adopt (#11018): only the stall
   * probe, pinned to the daemon process that stalled, or a tool call naming the session resumes
   * it. Otherwise a reconnect to a restarted daemon would re-claim and heartbeat it behind the
   * harness before the probe learns the daemon changed.
   */
  private holdTokenOwnedSession(session: TokenOwnedSession): boolean {
    const { sessionId } = session;
    if (sessionId === this.boundSessionUuid) {
      // The startup-bound session (--initial-session-uuid) is bound without a device, and calls
      // naming it carry none: the daemon's answer is the only place the proxy learns it, and
      // loss reports need it (#11028).
      this.rememberSessionDevice(sessionId, session.deviceId);
      if (session.platform !== undefined) {
        this.sessionPlatforms.set(sessionId, session.platform);
      }
      return false;
    }
    if (
      sessionId === this.terminalBoundSession?.sessionUuid ||
      this.otherHeldSessions.has(sessionId) ||
      this.stallHandovers.has(sessionId)
    ) {
      return false;
    }
    this.claimableSessions.add(sessionId);
    this.pendingHeldSessionPlatformLosses.delete(sessionId);
    this.plainRestartSessionLosses.delete(sessionId);
    this.ownedDeviceSessions.add(sessionId);
    this.rememberSessionDevice(sessionId, session.deviceId);
    if (session.platform !== undefined) {
      this.sessionPlatforms.set(sessionId, session.platform);
    }
    // Resuming is not use: the held session's idle clock is the daemon's last tool use (#10656).
    this.otherHeldSessions.set(sessionId, { claimSent: false, lastUsedAt: session.lastUsedAt });
    return true;
  }

  /**
   * Re-claim one resumed session directly on the connection being established, like the
   * establishment heartbeat: routing it through the reconnect machinery would re-enter the
   * connection attempt still in flight. A failure leaves the claim unsent for the keeper to retry.
   */
  private async sendResumeClaim(client: DaemonClientLike, sessionUuid: string): Promise<void> {
    const stopRenewing = this.renewLeaseWhileClaimReplyOutstanding(client, sessionUuid);
    try {
      try {
        this.noteDaemonIdleEvidence(
          sessionUuid,
          await client
            .callDaemonMethod(
              DAEMON_HEARTBEAT_METHOD,
              this.boundSessionHeartbeatParams(sessionUuid, true, true),
            )
            .finally(stopRenewing),
        );
      } catch (error) {
        // The daemon listed this session as the token's a moment ago: the answer is about the
        // session, not about a daemon that has yet to rehydrate it.
        throw this.isDaemonSessionNotFoundError(error)
          ? new HeldSessionNotFoundError(
              sessionUuid,
              this.boundHeartbeat.noteNotFoundAnswer(
                sessionUuid,
                null,
                releaseReasonFromError(error),
                daemonInstanceFromError(error),
              ),
            )
          : error;
      }
      this.recordHeldSessionHeartbeatSuccess(sessionUuid, true);
    } catch (error) {
      this.handleHeldSessionHeartbeatError(sessionUuid, true, error);
    }
  }

  /**
   * Heartbeat `sessionUuid` on the keeper's cadence while a claim sent outside the keeper waits
   * for its reply (#11646). The daemon accepts a claim on arrival and answers once the ownership
   * row is written; the accepted claim is the owner's heartbeat, so the lease runs from its
   * arrival. The establishment and resume claims are awaited before the keeper starts, so without
   * this a write slower than lease plus grace releases a session whose owner is live. Each renewal
   * is a plain keeper tick: the daemon stamps the lease when it arrives and answers at once, with
   * no claim and no policy change. Does nothing while the keeper is running, which then ticks for
   * the session itself.
   *
   * Returns what to call when the reply lands. A claim answered before the first renewal leaves
   * nothing behind. One that needed renewals gets a last one on the same cadence, so the lease is
   * renewed between the reply and the keeper's first tick a full interval after it.
   */
  private renewLeaseWhileClaimReplyOutstanding(
    client: DaemonClientLike,
    sessionUuid: string,
  ): () => void {
    let renewed = false;
    let replied = false;
    const stop = () => this.timer.clearInterval(renewals);
    const renewals = this.timer.setInterval(() => {
      if (this.closing || this.client !== client || !this.isHeldSession(sessionUuid)) {
        stop();
        return;
      }
      if (replied) {
        stop();
      } else if (this.heartbeatKeeperStarted) {
        return;
      }
      renewed = true;
      void client
        .callDaemonMethod(DAEMON_HEARTBEAT_METHOD, this.boundSessionHeartbeatParams(sessionUuid))
        .catch((error: unknown) => {
          // Expected while the claim is undecided (refused, or the session is gone): the claim's
          // own reply reports that, and this tick only renews a lease the daemon already granted.
          logger.debug(
            `[DaemonMcpProxy] Heartbeat for session ${sessionUuid} behind its pending claim failed: ${errorMessage(error)}`,
          );
        });
    }, this.heartbeatIntervalMs);
    // Never the reason a closing proxy's process stays up.
    renewals.unref?.();
    return () => {
      replied = true;
      if (!renewed) {
        stop();
      }
    };
  }

  /**
   * `client` was just connected with the keeper already running, so the keeper's next heartbeat
   * for each session it heartbeats re-establishes ownership on it: the latest binding (#11529)
   * and every session held besides it (#11557).
   */
  private noteOwnershipReestablishment(client: DaemonClientLike): void {
    if (this.latestHeartbeatAsked?.notFound === true && !this.latestHeartbeatAsked.handoff) {
      this.ownershipReestablishment = undefined;
      return;
    }
    const latest = this.latestBindingHeartbeatable() ? [this.boundSessionUuid!] : [];
    const sessionUuids = new Set([...latest, ...this.otherHeldSessions.keys()]);
    this.ownershipReestablishment = sessionUuids.size > 0 ? { client, sessionUuids } : undefined;
  }

  /**
   * The daemon answered a heartbeat for `sessionUuid` on `client`. True for the first answer on a
   * connection that was established to re-assert ownership of that session
   * ({@link ownershipReestablishment}), and only for that one. Each session has its own first
   * answer: one session's says nothing about its siblings'.
   */
  private answersOwnershipReestablishment(
    client: DaemonClientLike | null,
    sessionUuid: string,
  ): boolean {
    const pending = this.ownershipReestablishment;
    return pending?.client === client && pending.sessionUuids.delete(sessionUuid);
  }

  /**
   * Send the establishment heartbeat directly against the freshly connected
   * client. Deliberately NOT routed through withRecoverableReconnect(): that path
   * re-enters ensureConnected(), which is still in flight during establishment and
   * would deadlock on a reconnect. A transient failure is best-effort — the keeper
   * started next retries within the daemon's pre-first-heartbeat grace, and a
   * genuinely released session is fenced by the keeper's reconnect path or a
   * session-released notification.
   */
  private async sendFirstBoundSessionHeartbeat(): Promise<void> {
    const sessionUuid = this.boundSessionUuid;
    if (!sessionUuid || !this.latestBindingClaimable() || this.closing || !this.client) {
      return;
    }
    try {
      const ack = await this.claimFirstBoundSessionHeartbeat(this.client, sessionUuid);
      if (this.boundSessionUuid === sessionUuid && !this.terminalBoundSession) {
        this.noteDaemonIdleEvidence(sessionUuid, ack);
        this.livenessOwnershipClaimSent = true;
        // A heartbeat ack proves liveness, not use: it must not refresh the replay lease (#10656).
        this.livenessAcks.set(sessionUuid, this.timer.now());
      }
    } catch (error) {
      if (this.isDaemonSessionNotFoundError(error) && this.boundSessionUuid === sessionUuid) {
        // The first heartbeat is the session's first answer on the connection just established:
        // decided like every other not-found answer, so only a release reason that ends the
        // session fences it. With no reason the daemon may not have rehydrated it yet (#11570).
        this.boundHeartbeat.applyNotFoundOutcome(
          sessionUuid,
          this.boundHeartbeat.noteNotFoundAnswer(
            sessionUuid,
            null,
            releaseReasonFromError(error),
            daemonInstanceFromError(error),
            {
              establishes: true,
            },
          ),
        );
        return;
      }
      // Safe to swallow the rest: the establishment heartbeat is best-effort. The
      // keeper started immediately after retries within the pre-first-heartbeat
      // grace — so a transient failure here must not fail connection establishment.
      logger.debug(
        `[DaemonMcpProxy] Initial bound-session heartbeat failed: ${errorMessage(error)}`,
      );
    }
  }

  /** Keep managed claims cancellable and remember exactly which connection acknowledged them. */
  private async claimFirstBoundSessionHeartbeat(
    client: DaemonClientLike,
    sessionUuid: string,
  ): Promise<unknown> {
    const stopRenewing = this.renewLeaseWhileClaimReplyOutstanding(client, sessionUuid);
    try {
      const claiming = client.callDaemonMethod(
        DAEMON_HEARTBEAT_METHOD,
        this.boundSessionHeartbeatParams(sessionUuid, true, true),
      );
      const ack = await claiming;
      return ack;
    } finally {
      stopRenewing();
    }
  }

  /**
   * Declare this connection's bound device session CLI-owned (issue #6870).
   *
   * A `--cli` invocation is a one-shot process: it connects, runs one tool and
   * exits, so the recurring keeper above dies with it and the daemon reaps the
   * session after the 10 s heartbeat timeout — roughly the time an agent spends
   * reading the previous result. Sending one heartbeat that also carries
   * {@link CLI_SESSION_LIVENESS_POLICY} records ownership AND moves the session
   * onto a wall-clock idle timeout measured in minutes, so the next invocation
   * still finds it. Returns the declared session uuid, or undefined when there
   * was nothing to declare.
   *
   * Long-lived clients (stdio/HTTP MCP) never call this and keep the strict
   * contract: their keeper can hold it.
   */
  async adoptCliSessionLiveness(): Promise<string | undefined> {
    const sessionUuid = this.boundSessionUuid;
    if (!sessionUuid || this.terminalBoundSession || this.closing || !this.client) {
      return undefined;
    }
    try {
      // A one-shot CLI is leaving, so stop future keeper ticks and wait only a
      // short bounded interval for the current strict-policy heartbeat. This
      // both prevents an older heartbeat from restoring strict policy after
      // the declaration and prevents a completed tool result from being hidden
      // behind a stalled ownership RPC.
      const heartbeatSettled = await this.stopBoundSessionHeartbeat();
      if (!heartbeatSettled) {
        return undefined;
      }
      if (this.boundSessionUuid !== sessionUuid || this.terminalBoundSession || this.closing) {
        return undefined;
      }
      // Declare before the round-trip: a keeper tick that fires while this call
      // is in flight must already carry the CLI marker, or it would land after
      // the declaration and restore the strict contract.
      this.cliSessionLivenessDeclared = true;
      this.livenessOwnershipClaimSent = true;
      await this.client.callDaemonMethod(
        DAEMON_HEARTBEAT_METHOD,
        {
          sessionId: sessionUuid,
          livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
          livenessOwnerToken: this.livenessOwnerToken,
          claimLivenessOwnership: true,
          // The daemon resolved its own env at startup and this invocation reuses
          // it, so the override only reaches the daemon by travelling with the
          // declaration (issue #6870 review). The daemon re-validates and bounds it.
          idleTimeoutMs: getCliSessionIdleTimeoutMs(),
        },
        { timeoutMs: CLI_SESSION_FINALIZATION_TIMEOUT_MS },
      );
      return sessionUuid;
    } catch (error) {
      // Best-effort: the tool call already succeeded and its result is the
      // caller's answer. A failed declaration only means the next invocation may
      // have to re-acquire, which is the pre-#6870 behaviour — never a reason to
      // fail the invocation that just ran.
      logger.debug(
        `[DaemonMcpProxy] CLI session liveness declaration failed: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async stopBoundSessionHeartbeat(): Promise<boolean> {
    const settled = await this.heartbeatKeeper.stop();
    this.heartbeatKeeperStarted = false;
    // A later start is a fresh cadence, not a late tick.
    this.tickLateness.reset();
    if (!settled) {
      logger.warn("[DaemonMcpProxy] Bound-session heartbeat did not settle before shutdown");
    }
    return settled;
  }

  /**
   * Parameters for an ordinary (non-declaring) bound-session heartbeat.
   *
   * A long-lived stdio/HTTP proxy declares `heartbeat` so the daemon restores
   * the strict contract on a session a previous `--cli` invocation widened
   * (issue #6870 review). Once THIS proxy has declared the session CLI-owned,
   * its own remaining heartbeats keep the CLI marker instead, so a keeper tick
   * racing process exit cannot undo the declaration.
   */
  private boundSessionHeartbeatParams(
    sessionUuid: string,
    claimLivenessOwnership = false,
    reportIdleRelease = false,
  ): {
    sessionId: string;
    livenessPolicy: string;
    idleTimeoutMs?: number;
    livenessOwnerToken: string;
    claimLivenessOwnership?: true;
    reportIdleRelease?: true;
    reportDaemonInstance?: true;
  } {
    const livenessPolicy = this.cliSessionLivenessDeclared
      ? CLI_SESSION_LIVENESS_POLICY
      : HEARTBEAT_SESSION_LIVENESS_POLICY;
    return {
      sessionId: sessionUuid,
      livenessPolicy,
      ...(livenessPolicy === CLI_SESSION_LIVENESS_POLICY
        ? { idleTimeoutMs: getCliSessionIdleTimeoutMs() }
        : {}),
      livenessOwnerToken: this.livenessOwnerToken,
      ...(claimLivenessOwnership ? { claimLivenessOwnership: true } : {}),
      // Ask the daemon to say when it would idle-release the session (#10823), and which process
      // it is, so a stall probe can tell a resumed daemon from a restarted one (#10989).
      ...(reportIdleRelease ? { reportIdleRelease: true, reportDaemonInstance: true } : {}),
    };
  }

  private createHeldSessionHeartbeatOutcomesPort(): HeldSessionHeartbeatOutcomesPort {
    return {
      isClosing: () => this.closing,
      isDaemonSessionNotFoundError: (...args) => this.isDaemonSessionNotFoundError(...args),
      applyNotFoundOutcome: (...args) => this.boundHeartbeat.applyNotFoundOutcome(...args),
      recordHeldSessionTerminalLoss: (...args) => this.recordHeldSessionTerminalLoss(...args),
      dropHeldSession: (...args) => this.dropHeldSession(...args),
    };
  }

  private createBoundSessionHeartbeatPort(): BoundSessionHeartbeatPort {
    return {
      requireClient: () => this.requireClient(),
      boundSessionHeartbeatParams: (...args) => this.boundSessionHeartbeatParams(...args),
      answersOwnershipReestablishment: (...args) => this.answersOwnershipReestablishment(...args),
      noteHeartbeatDaemonInstance: (...args) => this.noteHeartbeatDaemonInstance(...args),
      noteDaemonIdleEvidence: (...args) => this.noteDaemonIdleEvidence(...args),
      isDaemonSessionNotFoundError: (...args) => this.isDaemonSessionNotFoundError(...args),
      isHeldSession: (...args) => this.isHeldSession(...args),
      latestBindingClaimable: () => this.latestBindingClaimable(),
      withRecoverableReconnect: (...args) => this.withRecoverableReconnect(...args),
      fenceBoundSessionUuid: (...args) => this.fenceBoundSessionUuid(...args),
      dropHeldSession: (...args) => this.dropHeldSession(...args),
      syncHeartbeatKeeper: () => this.syncHeartbeatKeeper(),
      isClosing: () => this.closing,
    };
  }

  private createStallProbePort(): StallProbePort {
    return {
      isClosing: () => this.closing,
      sendResumeHeartbeat: (...args) => this.sendStalledSessionResumeHeartbeat(...args),
      sendProbeHeartbeat: (sessionUuid, expectedDaemonInstance) =>
        runWithoutDaemonLifecycle(() =>
          raceWithDeadline(
            async () => {
              await this.ensureConnected();
              return this.requireClient().callDaemonMethod(DAEMON_HEARTBEAT_METHOD, {
                ...this.boundSessionHeartbeatParams(sessionUuid, false, true),
                expectedDaemonInstance,
              });
            },
            {
              timer: this.timer,
              timeoutMs: this.heartbeatRequestTimeoutMs(),
              label: "Stalled-daemon probe",
            },
          ),
        ),
      restoreResumedSession: (...args) => this.restoreResumedSession(...args),
      noteDaemonIdleEvidence: (...args) => this.noteDaemonIdleEvidence(...args),
      endLostSessionHandover: (...args) => this.endLostSessionHandover(...args),
      isDefinitiveSessionLoss: (...args) => this.isDefinitiveSessionLoss(...args),
      isDaemonSessionNotFoundError: (...args) => this.isDaemonSessionNotFoundError(...args),
      startProbeInterval: () => this.stallResumeProbe.start(),
      stopProbeInterval: () => {
        void this.stallResumeProbe.stop();
      },
    };
  }

  private createHeldSessionLossesPort(): HeldSessionLossesPort {
    return {
      boundSessionUuid: () => this.boundSessionUuid,
      terminalBoundSessionUuid: () => this.terminalBoundSession?.sessionUuid,
      isOtherHeldSession: (sessionUuid) => this.otherHeldSessions.has(sessionUuid),
      otherHeldSessionUuids: () => this.otherHeldSessions.keys(),
      stallHandover: (sessionUuid) => this.stallHandovers.get(sessionUuid),
      isSessionlessControlDeviceTool: (...args) => this.isSessionlessControlDeviceTool(...args),
      sessionUuidFromArgs: (...args) => this.sessionUuidFromArgs(...args),
      reportPendingSessionLoss: (...args) => this.reportPendingSessionLoss(...args),
      noteReleaseSurfacedBy: (...args) => this.noteReleaseSurfacedBy(...args),
    };
  }

  private createSessionBindingDependencies(): SessionBindingDependencies {
    return {
      timer: this.timer,
      state: this.sessionState,
      ownedDeviceSessions: this.ownedDeviceSessions,
      sessionPlatforms: this.sessionPlatforms,
      sessionDeviceIds: this.sessionDeviceIds,
      sessionBrokerSessions: this.sessionBrokerSessions,
      plainRestartSessionLosses: this.plainRestartSessionLosses,
      pendingHeldSessionPlatformLosses: this.pendingHeldSessionPlatformLosses,
      initialSessionUuid: () => this.config.initialSessionUuid,
      port: this.createSessionBindingPort(),
    };
  }

  private createSessionBindingPort(): SessionBindingPort {
    return {
      startBoundSessionHeartbeat: (...args) => this.startBoundSessionHeartbeat(...args),
      forwardedSessionReleaseReasonSince: (...args) =>
        this.forwardedSessionReleaseReasonSince(...args),
      fenceReleasedForwardedSession: (...args) => this.fenceReleasedForwardedSession(...args),
      throwIfSessionReleasedSince: (...args) => this.throwIfSessionReleasedSince(...args),
      sessionReleaseReasonSince: (sessionUuid, forwardEpoch) =>
        this.releaseLedger.sessionReleaseReasonSince(sessionUuid, forwardEpoch),
      invalidateListCache: (...args) => this.invalidateListCache(...args),
      notifyListChanged: (...args) => this.notifyListChanged(...args),
      holdPreviousBinding: (...args) => this.holdPreviousBinding(...args),
      clearHeldSessionLossesForSelection: (...args) =>
        this.heldSessionLosses.clearForSelection(...args),
      syncHeartbeatKeeper: (...args) => this.syncHeartbeatKeeper(...args),
      stopBoundSessionHeartbeat: (...args) => this.stopBoundSessionHeartbeat(...args),
      establishBoundSessionHeartbeat: (...args) => this.establishBoundSessionHeartbeat(...args),
      failureNeverReachedLiveSession: (...args) => this.failureNeverReachedLiveSession(...args),
      toolAcceptsSessionUuid: (...args) => this.toolAcceptsSessionUuid(...args),
      isHeartbeatKeeperStarted: () => this.heartbeatKeeperStarted,
    };
  }

  private createHeartbeatKeeperPort(): HeartbeatKeeperPort {
    return {
      runLatestBindingHeartbeatTick: (...args) => this.runLatestBindingHeartbeatTick(...args),
      hasSessionCallInFlight: (...args) => this.hasSessionCallInFlight(...args),
      daemonKeepsSessionInUse: (...args) => this.daemonKeepsSessionInUse(...args),
      recordHeldSessionTerminalLoss: (...args) => this.recordHeldSessionTerminalLoss(...args),
      idleSessionReleaseReason: (...args) => this.idleSessionReleaseReason(...args),
      dropHeldSession: (...args) => this.dropHeldSession(...args),
      withRecoverableReconnect: (...args) => this.withRecoverableReconnect(...args),
      askSessionHeartbeat: (...args) => this.boundHeartbeat.askSessionHeartbeat(...args),
      recordHeldSessionHeartbeatSuccess: (...args) =>
        this.recordHeldSessionHeartbeatSuccess(...args),
      noteLateHeartbeatAck: (...args) => this.heartbeatOutcomes.noteLateHeartbeatAck(...args),
      handleHeldSessionHeartbeatError: (...args) => this.handleHeldSessionHeartbeatError(...args),
      isMissingHeartbeatAcknowledgement: (...args) =>
        this.heartbeatOutcomes.isMissingHeartbeatAcknowledgement(...args),
      heldSessionUuids: (...args) => this.heldSessionUuids(...args),
      isClosing: () => this.closing,
    };
  }

  private runBoundSessionHeartbeatTick(): Promise<void> {
    return this.proxyHeartbeatKeeper.tick();
  }

  /** Every session this proxy heartbeats: the latest binding plus the ones it still holds. */
  private heldSessionUuids(): string[] {
    const latest = this.latestBindingClaimable() ? [this.boundSessionUuid!] : [];
    return [...latest, ...this.otherHeldSessions.keys()];
  }

  /**
   * Whether the latest binding is one this proxy claims and heartbeats: live, and minted by this
   * proxy or configured at startup, never merely named in a tool call's args (#10664).
   */
  private latestBindingClaimable(): boolean {
    return (
      this.boundSessionUuid !== undefined &&
      !this.terminalBoundSession &&
      this.claimableSessions.has(this.boundSessionUuid)
    );
  }

  private createLivenessRecovery(): LivenessRecovery {
    return new LivenessRecovery({
      timer: this.timer,
      leaseMs: this.heartbeatLeashMs,
      requestTimeoutMs: this.heartbeatRequestTimeoutMs(),
      lastAckAt: (sessionUuid) => this.livenessAckedAt(sessionUuid),
      hasAcknowledgedSince: (sessionUuid, sinceMs) =>
        (this.livenessAcks.get(sessionUuid) ?? Number.NEGATIVE_INFINITY) > sinceMs,
      deviceIdOf: (sessionUuid) => this.sessionDeviceIds.get(sessionUuid),
      isActive: (sessionUuid) => !this.closing && this.isHeldSession(sessionUuid),
      attempt: (sessionUuid, attemptNumber, _deadlineMs, claimSocketReset) =>
        this.runRecoveryAttempt(sessionUuid, attemptNumber, claimSocketReset),
      onRecovered: ({ sessionUuid, code, attempts, restoredAfterLapse }) => {
        logger.info(
          `[DaemonMcpProxy] Recovered ${code} for session ${sessionUuid} after ${attempts} attempt(s)` +
            (restoredAfterLapse ? "; the daemon held it as suspect and kept the same UUID" : ""),
        );
      },
      onSessionGone: (sessionUuid) => {
        // The same decision as a keeper tick answered not-found: a replacement daemon that has
        // not materialised a persisted session yet says so with no release reason, and the next
        // tool call restores it (#11411).
        const outcome = this.recoveryNotFoundOutcomes.get(sessionUuid)?.outcome ?? {
          kind: "stopped",
        };
        this.recoveryNotFoundOutcomes.delete(sessionUuid);
        this.boundHeartbeat.applyNotFoundOutcome(sessionUuid, outcome);
      },
      onHandover: (handover) => this.deliverLivenessHandover(handover),
    });
  }

  private isHeldSession(sessionUuid: string): boolean {
    return (
      (sessionUuid === this.boundSessionUuid && this.latestBindingClaimable()) ||
      this.otherHeldSessions.has(sessionUuid)
    );
  }

  /** When the daemon last acknowledged this session's heartbeat, falling back to when it was bound. */
  private livenessAckedAt(sessionUuid: string): number {
    return (
      this.livenessAcks.get(sessionUuid) ??
      (sessionUuid === this.boundSessionUuid ? this.boundSessionUuidAt : undefined) ??
      this.timer.now()
    );
  }

  /** How long a heartbeat is given before it counts as unanswered. */
  private heartbeatRequestTimeoutMs(): number {
    return heartbeatRequestTimeoutMs(this.heartbeatLeashMs, this.heartbeatIntervalMs);
  }

  /**
   * One recovery attempt: reconnect if needed and re-heartbeat with the same owner token. The
   * connection is observation-only, so an unreachable daemon fails the attempt; this proxy never
   * starts, restarts or stops it.
   */
  private async runRecoveryAttempt(
    sessionUuid: string,
    attemptNumber: number,
    claimSocketReset: () => boolean,
  ): Promise<RecoveryAttemptOutcome> {
    const claimLivenessOwnership = this.livenessClaimPending(sessionUuid);
    let attemptedClient: DaemonClientLike | null = null;
    try {
      await runWithoutDaemonLifecycle(async () => {
        if (this.shouldReplaceSocketForRecovery(attemptNumber, claimSocketReset)) {
          await this.resetConnection();
        }
        await this.ensureConnected();
        attemptedClient = this.requireClient();
        const ack = await attemptedClient.callDaemonMethod(
          DAEMON_HEARTBEAT_METHOD,
          this.boundSessionHeartbeatParams(sessionUuid, claimLivenessOwnership, true),
        );
        if (this.isHeldSession(sessionUuid)) {
          this.noteDaemonIdleEvidence(sessionUuid, ack);
        }
      });
    } catch (error) {
      if (error instanceof DaemonShuttingDownError) {
        // The daemon answered, so the socket works: it is draining, not dead, and the tool calls
        // in flight on it still get their answers ({@link drainingToolCalls}).
        if (attemptedClient !== null && attemptedClient === this.client) {
          this.waitForDaemonShutdownDisconnect();
        }
      } else if (attemptedClient && error instanceof DaemonUnavailableError) {
        this.deadSocketClients.add(attemptedClient);
      }
      return this.classifyRecoveryAttemptError(sessionUuid, attemptNumber, error, attemptedClient);
    }
    this.answersOwnershipReestablishment(attemptedClient, sessionUuid);
    this.recordRecoveryAcknowledgement(sessionUuid, claimLivenessOwnership);
    return "acknowledged";
  }

  /**
   * Whether this attempt may replace the daemon socket. It is one connection shared by every
   * session this proxy holds and by tool calls in flight, so replacing it rejects all of their
   * requests. From the second attempt a socket that is open but silent has already failed to carry
   * a heartbeat, so it is replaced, but at most once per recovery episode (not per session) and
   * never beneath a tool call in flight unless the socket is already proven dead by a transport
   * failure, when there is nothing left to lose.
   */
  private shouldReplaceSocketForRecovery(
    attemptNumber: number,
    claimSocketReset: () => boolean,
  ): boolean {
    const client = this.client;
    if (attemptNumber <= 1 || !client) {
      return false;
    }
    if (this.deadSocketClients.has(client)) {
      return true;
    }
    if ((this.toolCallsInFlight.get(client) ?? 0) > 0) {
      return false;
    }
    return claimSocketReset();
  }

  /**
   * Count a tool call on `client` while it awaits an answer. The caller gets the call's own
   * promise back, not a wrapper, so tracking adds no scheduling turns to the forwarding path.
   */
  private trackToolCallInFlight<T>(client: DaemonClientLike, send: () => Promise<T>): Promise<T> {
    const settle = () => {
      const remaining = Math.max(0, (this.toolCallsInFlight.get(client) ?? 1) - 1);
      this.toolCallsInFlight.set(client, remaining);
      if (remaining === 0) {
        this.toolCallsSettled.get(client)?.resolve();
        this.toolCallsSettled.delete(client);
      }
    };
    this.toolCallsInFlight.set(client, (this.toolCallsInFlight.get(client) ?? 0) + 1);
    let forwarded: Promise<T>;
    try {
      forwarded = send();
    } catch (error) {
      settle();
      throw error;
    }
    forwarded.then(settle, settle);
    return forwarded;
  }

  private classifyRecoveryAttemptError(
    sessionUuid: string,
    attemptNumber: number,
    error: unknown,
    attemptedClient: DaemonClientLike | null,
  ): RecoveryAttemptOutcome {
    if (this.isDaemonSessionNotFoundError(error)) {
      // The same decision as any other heartbeat's not-found: an attempt that reached a daemon
      // this proxy just connected to gets that session's first answer on the connection (#11570).
      const releaseReason = releaseReasonFromError(error);
      const outcome = this.boundHeartbeat.noteNotFoundAnswer(
        sessionUuid,
        attemptedClient,
        releaseReason,
        daemonInstanceFromError(error),
      );
      this.recoveryNotFoundOutcomes.set(sessionUuid, {
        outcome,
        releaseReason,
      });
      return outcome.kind === "awaited" ? "session-awaited" : "session-gone";
    }
    if (!this.heartbeatOutcomes.isMissingHeartbeatAcknowledgement(error)) {
      // The daemon answered: the session's next answer on this connection is not its first.
      this.answersOwnershipReestablishment(attemptedClient, sessionUuid);
    }
    if (isLivenessOwnershipLostError(error)) {
      // Another token took the session over while this proxy could not heartbeat it.
      return "superseded";
    }
    if (!this.heartbeatOutcomes.isMissingHeartbeatAcknowledgement(error)) {
      // The daemon answered with a conflict refusal: it is reachable, and the regular tick's
      // own conflict handling takes it from here.
      return "acknowledged";
    }
    logger.warn(
      `[DaemonMcpProxy] Recovery attempt ${attemptNumber} for session ${sessionUuid} failed: ${errorMessage(error)}`,
    );
    return "unreachable";
  }

  private livenessClaimPending(sessionUuid: string): boolean {
    if (sessionUuid === this.boundSessionUuid && !this.terminalBoundSession) {
      return !this.livenessOwnershipClaimSent;
    }
    return this.otherHeldSessions.get(sessionUuid)?.claimSent === false;
  }

  private recordRecoveryAcknowledgement(
    sessionUuid: string,
    claimLivenessOwnership: boolean,
  ): void {
    if (sessionUuid === this.boundSessionUuid && !this.terminalBoundSession) {
      this.recordBoundSessionHeartbeatSuccess(sessionUuid, claimLivenessOwnership, () => true);
    } else if (this.otherHeldSessions.has(sessionUuid)) {
      this.recordHeldSessionHeartbeatSuccess(sessionUuid, claimLivenessOwnership);
    }
  }

  /**
   * Automatic recovery was exhausted: stop heartbeating the affected sessions, remember the
   * structured error for the next tool call that reaches each of them, and tell the harness now.
   */
  private deliverLivenessHandover(handover: LivenessHandover): void {
    if (handover.code === PROXY_STALLED_CODE) {
      // Capture each recovery refusal before fencing forgets its liveness state.
      handover = {
        ...handover,
        releaseReasons: Object.fromEntries(
          handover.sessions.map(({ sessionUuid }) => [
            sessionUuid,
            this.recoveryNotFoundOutcomes.get(sessionUuid)?.releaseReason ??
              SESSION_NOT_FOUND_REASON,
          ]),
        ),
      };
    }
    if (this.isHandoverAfterCleanDaemonShutdown(handover)) {
      logger.warn(
        `[DaemonMcpProxy] ${handover.code} after a clean daemon shutdown (no daemon has ` +
          `acknowledged a heartbeat since): ${livenessHandoverMessage(handover)}`,
      );
    } else {
      logger.error(`[DaemonMcpProxy] ${handover.code}: ${livenessHandoverMessage(handover)}`);
    }
    for (const { sessionUuid } of handover.sessions) {
      this.stallHandovers.set(sessionUuid, this.stallHandoverRecord(handover, sessionUuid));
    }
    for (const { sessionUuid } of handover.sessions) {
      if (sessionUuid === this.boundSessionUuid && !this.terminalBoundSession) {
        this.fenceBoundSessionUuid(sessionUuid, handover.code);
      } else {
        this.dropHeldSession(sessionUuid, true);
      }
    }
    if (handover.code === PROXY_STALLED_CODE) {
      // Recovery already received a definitive missing-session or superseded-owner answer.
      for (const { sessionUuid } of handover.sessions) {
        this.endLostSessionHandover(sessionUuid, handover.releaseReasons?.[sessionUuid]);
      }
    }
    this.notifyLivenessHandoverListeners(handover);
    if (this.stallProbe.hasProbeableStall() && !this.closing) {
      this.stallResumeProbe.start();
    }
  }

  /**
   * A `daemon_stalled` handover whose sessions were last acknowledged before the daemon announced
   * its own shutdown: nothing has answered since the old daemon said it was going away.
   */
  private isHandoverAfterCleanDaemonShutdown(handover: LivenessHandover): boolean {
    return (
      handover.code === DAEMON_STALLED_CODE &&
      this.daemonShutdownAnnouncedAt !== undefined &&
      handover.lastAcknowledgedHeartbeatAt <= this.daemonShutdownAnnouncedAt
    );
  }

  private notifyLivenessHandoverListeners(handover: LivenessHandover): void {
    for (const listener of this.livenessHandoverListeners) {
      try {
        listener(handover);
      } catch (error) {
        // Best-effort: a dead client transport must not stop the other listeners or the proxy.
        logger.warn(`[DaemonMcpProxy] liveness handover listener failed: ${error}`);
      }
    }
  }

  /**
   * A handover record for one session. Only `daemon_stalled` is probed, and only when the daemon
   * reported which process it is: a resumed daemon is told from a restarted one by it (#10989).
   */
  private stallHandoverRecord(
    handover: LivenessHandover,
    sessionUuid: string,
  ): StallHandoverRecord {
    const probed = handover.code === DAEMON_STALLED_CODE && this.ackedDaemonInstance !== undefined;
    return {
      handover,
      delivered: false,
      ...(probed ? { probeDaemonInstance: this.ackedDaemonInstance } : {}),
      ...(this.ackedDaemonInstance !== undefined
        ? { stalledDaemonInstance: this.ackedDaemonInstance }
        : {}),
      restore: this.stallRestoreSnapshot(sessionUuid),
    };
  }

  /** Answers keep their named session and those still handed over; listeners keep the snapshot. */
  private currentHandover(sessionUuid: string, record: StallHandoverRecord): LivenessHandover {
    const handover = record.handover;
    const sessions = handover.sessions.filter(
      (session) =>
        session.sessionUuid === sessionUuid || this.stallHandovers.has(session.sessionUuid),
    );
    if (sessions.length === handover.sessions.length) {
      return handover;
    }
    return {
      ...handover,
      sessions,
      lastAcknowledgedHeartbeatAt: Math.max(
        ...sessions.map((session) => session.lastAcknowledgedHeartbeatAt),
      ),
    };
  }

  /** How a session is held right before it is handed over, so a resume restores it as it was. */
  private stallRestoreSnapshot(sessionUuid: string): StallHandoverRecord["restore"] {
    const bound = sessionUuid === this.boundSessionUuid && !this.terminalBoundSession;
    return {
      bound,
      lastUsedAt:
        (bound ? this.boundSessionUuidAt : this.otherHeldSessions.get(sessionUuid)?.lastUsedAt) ??
        this.timer.now(),
      initialBinding: bound && this.initialSessionBindingConfigured,
    };
  }

  /**
   * The daemon acknowledged a handed-over session again (#10989): lift its handover and hold it as
   * it was held before, heartbeating it from now on. Its next tool call carries a warning instead
   * of the handover.
   */
  private restoreResumedSession(sessionUuid: string, restart?: DaemonRestartEvidence): void {
    const record = this.stallHandovers.get(sessionUuid);
    if (!record) {
      return;
    }
    this.stallHandovers.delete(sessionUuid);
    this.pendingHeldSessionPlatformLosses.delete(sessionUuid);
    this.plainRestartSessionLosses.delete(sessionUuid);
    this.resumedStallNotices.set(sessionUuid, {
      handover: record.handover,
      ...(restart ? { restart } : {}),
    });
    this.livenessAcks.set(sessionUuid, this.timer.now());
    const terminal = this.terminalBoundSession;
    if (terminal?.sessionUuid === sessionUuid) {
      this.terminalBoundSession = undefined;
      this.releaseSurfacedFor = undefined;
      if (record.restore.bound && this.boundSessionUuid === undefined) {
        this.rebindResumedSession(sessionUuid, record, terminal.fromResultMint);
      }
    }
    if (this.boundSessionUuid !== sessionUuid && this.claimableSessions.has(sessionUuid)) {
      this.otherHeldSessions.set(sessionUuid, {
        claimSent: true,
        lastUsedAt: record.restore.lastUsedAt,
      });
    }
    this.resumeHeartbeatKeeper();
    if (!this.stallProbe.hasProbeableStall()) {
      void this.stallResumeProbe.stop();
    }
  }

  /** Make a resumed session the latest binding again, exactly as it was before the handover. */
  private rebindResumedSession(
    sessionUuid: string,
    record: StallHandoverRecord,
    fromResultMint: boolean,
  ): void {
    this.boundSessionUuid = sessionUuid;
    this.boundSessionUuidAt = record.restore.lastUsedAt;
    this.initialSessionBindingConfigured = record.restore.initialBinding;
    this.boundSessionFromResultMint = fromResultMint;
    // The resume heartbeat carried this proxy's token and the daemon acknowledged it.
    this.livenessOwnershipClaimSent = true;
    this.ownedDeviceSessions.add(sessionUuid);
    // The fence changed the scope discovery runs in; it changes back.
    this.discoveryEpoch += 1;
    this.invalidateCache();
    if (fromResultMint) {
      this.notifyListChanged("tools");
    }
  }

  /** Restart the keeper for resumed sessions when the handover idled it (#10989). */
  private resumeHeartbeatKeeper(): void {
    // Idempotent while the keeper runs; restarts it when the handover's stop already cleared it.
    this.syncHeartbeatKeeper();
  }

  /**
   * A tool call names a session this proxy gave up on (#10053). It first attempts an
   * observation-only resume with the same token: a daemon that still holds the session (it
   * resumed after its stall, or the harness restarted it) restores it and the call goes ahead,
   * carrying a warning instead of a failure (#10989). A daemon that still does not answer returns
   * the structured handover; a definitive loss queues one structured loss delivery. A call that
   * reaches a handed-over binding without naming it still gets the handover at once: the stall
   * probe resumes that binding as soon as the daemon answers.
   */
  private async resumeStalledSessionNamedBy(args: Record<string, unknown>): Promise<void> {
    const sessionUuid = this.sessionUuidFromArgs(args);
    const record = sessionUuid ? this.stallHandovers.get(sessionUuid) : undefined;
    if (!sessionUuid || !record) {
      return;
    }
    let ack: unknown;
    try {
      ack = await this.sendStalledSessionResumeHeartbeat(sessionUuid);
    } catch (error) {
      if (
        this.isDefinitiveSessionLoss(error) &&
        !this.stallProbe.awaitManagedReclaimNotFound(sessionUuid, record, error)
      ) {
        this.endLostSessionHandover(sessionUuid, releaseReasonFromError(error), error);
        this.reportPendingSessionLoss(args);
        return;
      }
      logger.warn(
        "[DaemonMcpProxy] Handed-over session was not acknowledged; retaining lifecycle fence",
        error,
      );
      record.delivered = true;
      throw new DaemonSessionStalledError(sessionUuid, this.currentHandover(sessionUuid, record));
    }
    if (this.stallHandovers.get(sessionUuid) === record) {
      this.restoreResumedSession(sessionUuid, daemonRestartEvidence(record, ack));
    }
    this.noteDaemonIdleEvidence(sessionUuid, ack);
  }

  /** Resume-by-name and managed reclaim use the same unpinned, observation-only owner claim. */
  private sendStalledSessionResumeHeartbeat(sessionUuid: string): Promise<unknown> {
    return runWithoutDaemonLifecycle(() =>
      raceWithDeadline(
        async () => {
          await this.ensureConnected();
          return this.requireClient().callDaemonMethod(
            DAEMON_HEARTBEAT_METHOD,
            this.boundSessionHeartbeatParams(sessionUuid, true, true),
          );
        },
        {
          timer: this.timer,
          timeoutMs: this.heartbeatRequestTimeoutMs(),
          label: "Resume handed-over session",
        },
      ),
    );
  }

  private isDefinitiveSessionLoss(error: unknown): boolean {
    return (
      (error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === DAEMON_SESSION_NOT_FOUND_CODE) ||
      isLivenessOwnershipLostError(error) ||
      isLivenessOwnerConflictError(error)
    );
  }

  private endLostSessionHandover(
    sessionUuid: string,
    releaseReason = SESSION_NOT_FOUND_REASON,
    error?: unknown,
  ): void {
    const record = this.stallHandovers.get(sessionUuid);
    if (!record) {
      return;
    }
    if (this.endPlainRestartSessionHandover(sessionUuid, record, releaseReason, error)) {
      return;
    }
    // A delivered proxy_stalled already reported this definitive loss. daemon_stalled did not.
    if (record.handover.code !== PROXY_STALLED_CODE || !record.delivered) {
      const loss: LivenessHandover = {
        ...record.handover,
        code: PROXY_STALLED_CODE,
        ...(record.handover.code === DAEMON_STALLED_CODE ? { stalledBy: "daemon" as const } : {}),
        releaseReasons: { [sessionUuid]: releaseReason },
        sessions: record.handover.sessions.filter((session) => session.sessionUuid === sessionUuid),
        lastAcknowledgedHeartbeatAt:
          record.handover.sessions.find((session) => session.sessionUuid === sessionUuid)
            ?.lastAcknowledgedHeartbeatAt ?? record.handover.lastAcknowledgedHeartbeatAt,
        action: "reacquire_lost_sessions",
      };
      this.pendingSessionLosses.set(sessionUuid, loss);
      this.recordHeldSessionTerminalLoss(sessionUuid, releaseReason);
      if (record.handover.code === DAEMON_STALLED_CODE) {
        // A daemon stall that ends in a lost session pushes the same liveness notification a
        // proxy stall does, worded as the daemon stall it was (#11028). A proxy_stalled handover
        // was already pushed when it was delivered.
        this.notifyLivenessHandoverListeners(loss);
      }
    }
    this.forgetSessionLivenessState(sessionUuid);
    if (!this.stallProbe.hasProbeableStall()) {
      void this.stallResumeProbe.stop();
    }
    this.ownedDeviceSessions.delete(sessionUuid);
    this.claimableSessions.delete(sessionUuid);
    this.recordTerminalStallLoss(sessionUuid, releaseReason);
  }

  /** A plain successor's definitive release uses terminal ownership loss, with no stall push. */
  private endPlainRestartSessionHandover(
    sessionUuid: string,
    record: StallHandoverRecord,
    releaseReason: string,
    error: unknown,
  ): boolean {
    const answeringDaemonInstance = daemonInstanceFromError(error);
    const restarted =
      record.managedReclaimSince !== undefined ||
      (answeringDaemonInstance !== undefined &&
        answeringDaemonInstance !== record.stalledDaemonInstance);
    if (!restarted) {
      return false;
    }
    this.plainRestartSessionLosses.set(sessionUuid, releaseReason);
    this.recordHeldSessionTerminalLoss(sessionUuid, releaseReason);
    if (this.terminalBoundSession?.sessionUuid === sessionUuid) {
      this.fenceBoundSessionUuid(sessionUuid, releaseReason);
    }
    this.forgetSessionLivenessState(sessionUuid);
    this.ownedDeviceSessions.delete(sessionUuid);
    this.claimableSessions.delete(sessionUuid);
    if (!this.stallProbe.hasProbeableStall()) {
      void this.stallResumeProbe.stop();
    }
    return true;
  }

  private recordTerminalStallLoss(sessionUuid: string, releaseReason: string): void {
    const terminal = this.terminalBoundSession;
    if (terminal?.sessionUuid !== sessionUuid) {
      return;
    }
    terminal.reason = releaseReason;
  }

  private reportToolSessionLoss(name: string, args: Record<string, unknown>): void {
    if (this.pendingSessionLosses.size === 0) {
      return;
    }
    const sessionless =
      isDeviceSessionAcquisitionTool(name) ||
      isDeviceInventoryTool(name) ||
      name === SET_TOOL_ENABLED_TOOL_NAME;
    const usesDeviceSelector =
      this.toolTargetsDevice(name) &&
      this.hasImplicitDeviceSelector(args, name === "setActiveDevice");
    this.reportPendingSessionLoss(
      args,
      !sessionless && !this.canUseSurvivingSession(args, usesDeviceSelector, name),
    );
  }

  private reportPendingSessionLoss(args: Record<string, unknown>, terminalRouted = true): void {
    const sessionUuid =
      this.sessionUuidFromArgs(args) ??
      (terminalRouted ? this.terminalBoundSession?.sessionUuid : undefined);
    const loss = sessionUuid ? this.pendingSessionLosses.get(sessionUuid) : undefined;
    if (sessionUuid && loss) {
      this.pendingSessionLosses.delete(sessionUuid);
      const answer = new DaemonSessionStalledError(sessionUuid, loss);
      // The stall-loss answer tells the caller its session is gone, like any terminal refusal.
      this.noteReleaseSurfacedBy(answer);
      throw answer;
    }
  }

  /**
   * The daemon refused a tool call because the session is suspect: its owner can still restore it.
   * Returns the refusal when the call may be forwarded once more after that recovery.
   */
  private noteSuspectSessionResult(
    name: string,
    result: unknown,
    forwardedArgs: Record<string, unknown>,
    allowRetry: boolean,
  ): DeviceSessionSuspectRefusal | undefined {
    const sessionUuid = this.sessionUuidFromArgs(forwardedArgs);
    if (!sessionUuid || !this.isHeldSession(sessionUuid) || !declaresDeviceSessionSuspect(result)) {
      return undefined;
    }
    logger.warn(`[DaemonMcpProxy] Session ${sessionUuid} is suspect; re-heartbeating it now`);
    this.livenessRecovery.begin(sessionUuid, DAEMON_STALLED_CODE);
    const refusal = readDeviceSessionSuspectRefusal(result);
    return allowRetry &&
      refusal &&
      isSuspectRefusalRetryable(name, sessionUuid, refusal) &&
      this.livenessRecovery.isRecovering(sessionUuid)
      ? refusal
      : undefined;
  }

  private heartbeatHeldSession(sessionUuid: string): Promise<void> {
    return this.proxyHeartbeatKeeper.heartbeatHeldSession(sessionUuid);
  }

  private heartbeatWithStallDetection(
    sessionUuid: string,
    send: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    return this.proxyHeartbeatKeeper.heartbeatWithStallDetection(sessionUuid, send);
  }

  // Kept as named methods: the liveness-clock guard follows the keeper's port to them.
  private recordHeldSessionHeartbeatSuccess(
    ...args: Parameters<HeldSessionHeartbeatOutcomes["recordHeldSessionHeartbeatSuccess"]>
  ): void {
    this.heartbeatOutcomes.recordHeldSessionHeartbeatSuccess(...args);
  }

  private handleHeldSessionHeartbeatError(
    ...args: Parameters<HeldSessionHeartbeatOutcomes["handleHeldSessionHeartbeatError"]>
  ): void {
    this.heartbeatOutcomes.handleHeldSessionHeartbeatError(...args);
  }

  private clearNotFoundHistory(sessionUuid: string): void {
    this.notFoundWindows.delete(sessionUuid);
    this.notFoundStopped.delete(sessionUuid);
    this.sessionDaemonInstances.delete(sessionUuid);
  }

  /**
   * Forget what the proxy tracks per session for liveness once it stops heartbeating it. A
   * session handed over for a stall stays resumable by UUID, so its device and the pending
   * handover are kept for the harness's next call. A not-found stop also keeps its handoff and
   * process evidence with stopped membership until acknowledgement, admitted use or termination.
   */
  private forgetSessionLivenessState(
    sessionUuid: string,
    keepHandover = false,
    keepNotFoundHistory = false,
  ): void {
    this.livenessAcks.delete(sessionUuid);
    this.daemonIdleReports.delete(sessionUuid);
    this.livenessConflictLogged.delete(sessionUuid);
    this.recoveryNotFoundOutcomes.delete(sessionUuid);
    if (!keepNotFoundHistory) {
      this.clearNotFoundHistory(sessionUuid);
    }
    // Held again later on this connection, its next heartbeat is not the connection's first.
    this.ownershipReestablishment?.sessionUuids.delete(sessionUuid);
    if (!keepHandover) {
      this.sessionDeviceIds.delete(sessionUuid);
      this.sessionPlatforms.delete(sessionUuid);
      this.stallHandovers.delete(sessionUuid);
    }
  }

  /** Stop heartbeating a held session; idle the keeper once nothing remains to heartbeat. */
  private dropHeldSession(
    sessionUuid: string,
    keepHandover = false,
    keepNotFoundHistory = false,
  ): void {
    if (!this.otherHeldSessions.delete(sessionUuid)) {
      return;
    }
    this.forgetSessionLivenessState(sessionUuid, keepHandover, keepNotFoundHistory);
    this.syncHeartbeatKeeper();
  }

  /** The latest binding moves on: its session stays held and keeps its claim state. */
  private holdPreviousBinding(nextSessionUuid: string): void {
    const previous = this.boundSessionUuid;
    this.pendingHeldSessionPlatformLosses.delete(nextSessionUuid);
    this.plainRestartSessionLosses.delete(nextSessionUuid);
    this.otherHeldSessions.delete(nextSessionUuid);
    this.latestBindingConflict = undefined;
    // Only a session this proxy claims stays held: an args-named one was never heartbeated (#10664).
    if (previous && previous !== nextSessionUuid && this.claimableSessions.has(previous)) {
      // Held again, it is asked again: its not-found answer may be out of date by now.
      this.notFoundStopped.delete(previous);
      this.otherHeldSessions.set(previous, {
        claimSent: this.livenessOwnershipClaimSent,
        lastUsedAt: this.boundSessionUuidAt ?? this.timer.now(),
      });
    }
  }

  // Kept as named methods: the liveness-clock guard follows the keeper and tick paths to them.
  private sendBoundSessionHeartbeat(isCurrent?: () => boolean): Promise<void> {
    return this.boundHeartbeat.sendBoundSessionHeartbeat(isCurrent);
  }

  private recordBoundSessionHeartbeatSuccess(
    ...args: Parameters<BoundSessionHeartbeat["recordBoundSessionHeartbeatSuccess"]>
  ): void {
    this.boundHeartbeat.recordBoundSessionHeartbeatSuccess(...args);
  }

  private async runLatestBindingHeartbeatTick(): Promise<void> {
    const sessionUuid = this.boundSessionUuid;
    if (!sessionUuid || !this.latestBindingClaimable() || this.closing) {
      return;
    }
    if (this.notFoundStopped.has(sessionUuid)) {
      // The daemon answered that it does not know this session; heartbeating it again cannot help.
      this.retireIdleLatestBinding(sessionUuid);
      return;
    }
    // Heartbeat first, then judge idleness (#10972): the judgement uses this tick's report, and a
    // session the daemon already released answers not-found with its own reason, which the agent
    // then sees instead of the proxy's.
    // A caller that explicitly schedules heartbeats beyond the lease cannot
    // maintain daemon ownership by cadence. Preserve that opt-out's prior
    // single-flight behavior (used by replay-lease tests).
    try {
      if (this.heartbeatIntervalMs >= this.heartbeatLeashMs) {
        await this.sendBoundSessionHeartbeat();
      } else {
        await this.heartbeatWithStallDetection(sessionUuid, (isCurrent) =>
          this.sendBoundSessionHeartbeat(isCurrent),
        );
      }
    } finally {
      this.retireIdleLatestBinding(sessionUuid);
    }
  }

  /**
   * Backstop for a missed session-released notification (#10702): an idle binding is retired here,
   * so the keeper stops instead of heartbeating it until the next call arrives.
   */
  private retireIdleLatestBinding(sessionUuid: string): void {
    if (
      this.boundSessionUuid === sessionUuid &&
      !this.terminalBoundSession &&
      this.isBoundSessionReplayExpired()
    ) {
      this.retireIdleBinding(sessionUuid);
    }
  }

  /**
   * The daemon admitted a call under `sessionUuid` and used it, so it knows the session (again):
   * its window is over, and a session the proxy stopped heartbeating on a not-found answer is
   * heartbeated again (#11570). A held session that was dropped for that answer is held again;
   * the latest binding is re-armed where it is bound. Only this echo restores: a read, a refusal
   * or a sessionless call names no admitted use, and never holds a session.
   */
  private noteSessionRestoredByCall(sessionUuid: string): void {
    const stopped = this.notFoundStopped.has(sessionUuid);
    this.clearNotFoundHistory(sessionUuid);
    if (!stopped || this.closing) {
      return;
    }
    if (
      sessionUuid !== this.boundSessionUuid &&
      sessionUuid !== this.terminalBoundSession?.sessionUuid &&
      this.claimableSessions.has(sessionUuid) &&
      !this.otherHeldSessions.has(sessionUuid)
    ) {
      this.otherHeldSessions.set(sessionUuid, { claimSent: false, lastUsedAt: this.timer.now() });
      this.pendingHeldSessionPlatformLosses.delete(sessionUuid);
      this.plainRestartSessionLosses.delete(sessionUuid);
    }
    this.syncHeartbeatKeeper();
  }

  private forwardedSessionReleaseReasonSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): string | undefined {
    const forwardedUuid = this.sessionUuidFromArgs(forwardedArgs);
    if (!forwardedUuid) {
      return undefined;
    }
    return this.releaseLedger.sessionReleaseReasonSince(forwardedUuid, forwardEpoch);
  }

  private throwIfSessionReleasedSince(sessionUuid: string, forwardEpoch: number): void {
    const releaseReason = this.releaseLedger.sessionReleaseReasonSince(sessionUuid, forwardEpoch);
    if (releaseReason) {
      throw new DaemonBoundSessionExpiredError(sessionUuid, releaseReason);
    }
  }

  private fenceReleasedForwardedSession(
    forwardedArgs: Record<string, unknown>,
    reason: string,
  ): void {
    const forwardedUuid = this.sessionUuidFromArgs(forwardedArgs) ?? "";
    if (
      forwardedUuid.length > 0 &&
      (!this.boundSessionUuid || this.boundSessionUuid === forwardedUuid)
    ) {
      this.fenceBoundSessionUuid(forwardedUuid, reason);
    }
  }

  private throwIfForwardedSessionReleasedSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): void {
    const reason = this.forwardedSessionReleaseReasonSince(forwardedArgs, forwardEpoch);
    if (!reason) {
      return;
    }
    const forwardedUuid = this.sessionUuidFromArgs(forwardedArgs)!;
    this.fenceReleasedForwardedSession(forwardedArgs, reason);
    if (this.terminalBoundSession?.sessionUuid === forwardedUuid) {
      throw this.boundSessionExpiredError();
    }
    throw new DaemonBoundSessionExpiredError(forwardedUuid, reason);
  }

  /** Learn which device a session runs on so a liveness handover can name it (#10053). */
  private rememberSessionDevice(sessionUuid: string, deviceId: unknown): void {
    return rememberSessionDeviceId(this.sessionDeviceIds, sessionUuid, deviceId);
  }

  private toolAcceptsSessionUuid(name: string): boolean {
    const tool =
      this.cachedTools?.find((definition) => definition.name === name) ??
      this.staticToolDefinitionsProvider().find((definition) => definition.name === name);
    const properties = tool?.inputSchema.properties;
    return typeof properties === "object" && properties !== null && "sessionUuid" in properties;
  }

  /** A rejection proving the call never reached the handler with a live session. */
  private failureNeverReachedLiveSession(error: unknown): boolean {
    return (
      isUnprovenSessionAdmissionError(error) ||
      this.isRecoverableDaemonSessionError(error) ||
      this.isPreDispatchDaemonSessionError(error) ||
      this.shouldSkipLeaseRefreshForDeviceControlTransportError(error)
    );
  }

  private async toolUnavailableError(
    name: string,
    daemonRejection?: string,
    daemonGated = false,
  ): Promise<Error> {
    let daemonIdentity: BuildIdentity = { entryScript: "", buildId: "unknown" };
    try {
      const status = await this.daemonManager.status();
      daemonIdentity = buildIdentityFromStatus(status);
    } catch (error) {
      logger.warn(
        `[DaemonMcpProxy] Failed to read daemon status for tool-unavailable error: ${error}`,
      );
    }
    if (!this.frontendRegistersTool(name)) {
      if (daemonGated && daemonRejection !== undefined) {
        // The daemon registers a tool this frontend has never heard of (a newer
        // daemon); its rejection already carries the gate reason.
        return Object.assign(new Error(daemonRejection), { code: DAEMON_TOOL_UNAVAILABLE_CODE });
      }
      const hint = getRemovedToolHint(name);
      return new Error(`Unknown tool "${name}".${hint ? ` ${hint}` : ""}`);
    }
    return new DaemonToolUnavailableError({
      toolName: name,
      client: this.buildIdentity,
      daemon: daemonIdentity,
      // A gate is daemon configuration, not skew: whatever the build identities say,
      // never tell the caller to restart the daemon for it.
      buildMismatch: daemonGated
        ? false
        : !buildIdentitiesMatch(this.buildIdentity, daemonIdentity),
      daemonRejection,
      gated: daemonGated,
    });
  }

  private frontendRegistersTool(name: string): boolean {
    const found =
      this.cachedTools?.find((definition) => definition.name === name) ??
      this.staticToolDefinitionsProvider().find((definition) => definition.name === name);
    return !!found;
  }

  /**
   * Get list of available resources from daemon
   */
  async listResources(): Promise<ProxiedResourceDefinition[]> {
    if (this.hasLivenessLifecycleFence()) {
      return this.listDuringLivenessFence(
        () => this.fetchResources(true),
        () => this.cachedResources ?? [],
      );
    }
    return this.fetchResources(this.discoveryAfterResultMintRelease());
  }

  private async fetchResources(releasedResultMint: boolean): Promise<ProxiedResourceDefinition[]> {
    // Return cached resources if available
    if (this.cachedResources) {
      return this.cachedResources;
    }

    try {
      const discoveryEpoch = this.discoveryEpoch;
      const forwardedParams = releasedResultMint ? {} : this.withBoundSessionUuid({});
      const result = await this.withRecoverableReconnect(
        () => this.requireClient().callDaemonMethod("resources/list", forwardedParams),
        this.sessionUuidFromArgs(forwardedParams),
        releasedResultMint,
      );
      const resources = result?.resources ?? [];
      // Discard a response invalidated mid-flight rather than caching the stale
      // scope (issue #4655); the next listResources() refetches. An unbound list
      // after a result-minted release is never cached: re-acquiring a session
      // does not invalidate the resource cache, so it would outlive the rebind.
      if (this.discoveryEpoch === discoveryEpoch && !releasedResultMint) {
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
    if (this.hasLivenessLifecycleFence()) {
      return this.listDuringLivenessFence(
        () => this.fetchResourceTemplates(true),
        () => this.cachedResourceTemplates ?? [],
      );
    }
    return this.fetchResourceTemplates(this.discoveryAfterResultMintRelease());
  }

  private async fetchResourceTemplates(
    releasedResultMint: boolean,
  ): Promise<ProxiedResourceTemplate[]> {
    // Return cached templates if available
    if (this.cachedResourceTemplates) {
      return this.cachedResourceTemplates;
    }

    try {
      const discoveryEpoch = this.discoveryEpoch;
      const forwardedParams = releasedResultMint ? {} : this.withBoundSessionUuid({});
      const result = await this.withRecoverableReconnect(
        () => this.requireClient().callDaemonMethod("resources/list-templates", forwardedParams),
        this.sessionUuidFromArgs(forwardedParams),
        releasedResultMint,
      );
      const templates = result?.resourceTemplates ?? [];
      // Discard a response invalidated mid-flight rather than caching the stale
      // scope (issue #4655); the next listResourceTemplates() refetches. Not
      // cached while unbound after a result-minted release (see listResources).
      if (this.discoveryEpoch === discoveryEpoch && !releasedResultMint) {
        this.cachedResourceTemplates = templates;
      }
      return templates;
    } catch (error) {
      logger.error(`[DaemonMcpProxy] Failed to list resource templates: ${error}`);
      throw error;
    }
  }

  // Route a session-scoped observation read to the session named in its URI when
  // this connection owns that session but has since bound a newer one (e.g.
  // getApple after getAndroid). Forwarding the URI's session — not the latest
  // binding — makes the daemon seed the loopback SessionToolBinding with the
  // owning session, so the just-established owner is authorized instead of denied
  // with SCREENSHOT_ACCESS_DENIED (issue #5663). Returns undefined for any other
  // URI, a foreign/unowned session (which must keep forwarding this connection's
  // own binding and stay denied), or the current binding (already handled by
  // withBoundSessionUuid). A terminally fenced connection can still forward to a
  // different live owned session through canUseSurvivingSession, including its
  // still-owned configured initial session after a later binding is released.
  private freshScreenshotOwnerForwardParams(uri: string): Record<string, unknown> | undefined {
    const uriSessionUuid = sessionScopedObservationUriSessionUuid(uri);
    if (
      !uriSessionUuid ||
      uriSessionUuid === this.boundSessionUuid ||
      !this.ownedDeviceSessions.has(uriSessionUuid)
    ) {
      return undefined;
    }
    const configuredInitialSessionUuid = this.config.initialSessionUuid?.trim();
    const isLiveConfiguredInitialSession =
      uriSessionUuid === configuredInitialSessionUuid &&
      uriSessionUuid !== this.terminalBoundSession?.sessionUuid;
    if (
      this.terminalBoundSession &&
      !this.canUseSurvivingSession({ sessionUuid: uriSessionUuid }, false) &&
      !isLiveConfiguredInitialSession
    ) {
      return undefined;
    }
    return {
      sessionUuid: uriSessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: uriSessionUuid,
    };
  }

  private throwIfResourceSessionHandedOver(uri: string): void {
    if (!this.connected || !this.client) {
      this.throwIfLivenessHandedOver();
    }
    if (isToolOutputResourceUri(uri)) {
      return;
    }
    const sessionUuid =
      sessionScopedObservationUriSessionUuid(uri) ??
      this.boundSessionUuid ??
      this.terminalBoundSession?.sessionUuid;
    const record = sessionUuid ? this.stallHandovers.get(sessionUuid) : undefined;
    if (sessionUuid && record) {
      throw new DaemonSessionStalledError(sessionUuid, this.currentHandover(sessionUuid, record));
    }
  }

  /**
   * Whether a resource read is forwarded with no session. A tool-output artifact always is. The
   * rest is the resource form of {@link isSessionlessReadAfterRelease} (#11483): once the binding is
   * released and one call has been told so, a read of a resource that names no session (the
   * booted-device inventory, anything `resources/list` still lists while unbound) is forwarded
   * without one, as `listDevices` and `observe {deviceId}` are. A URI that names a session, in
   * any session-scoped resource family, is never read without one: it keeps its own routing and,
   * for the released session, the typed terminal answer (its data is gone with it, apart from the
   * fresh screenshot). A liveness handover is reported until the harness acts on it.
   */
  private isSessionlessResourceRead(uri: string): boolean {
    if (isToolOutputResourceUri(uri)) {
      // Session-independent at any time, fenced or not (#5917).
      return true;
    }
    const terminal = this.terminalBoundSession;
    return (
      terminal !== undefined &&
      this.releaseSurfacedFor === terminal.sessionUuid &&
      !this.stallHandovers.has(terminal.sessionUuid) &&
      !resourceUriNamesSession(uri)
    );
  }

  /**
   * Read a resource from the daemon
   */
  async readResource(
    uri: string,
    { signal: callerSignal }: { signal?: AbortSignal } = {},
  ): Promise<any> {
    const signal = this.untilClosed(callerSignal);
    signal.throwIfAborted();
    await this.waitForLivenessRecovery(signal);
    this.throwIfResourceSessionHandedOver(uri);
    signal?.throwIfAborted();
    const terminalSessionUuid = this.terminalBoundSession?.sessionUuid;
    // A tool-output artifact read is session-independent, so it survives a
    // terminal release without any session params at all (issue #5917). The
    // fresh-screenshot exemption, by contrast, must still target the released
    // session it belongs to.
    const isToolOutput = isToolOutputResourceUri(uri);
    const isReleasedSessionScreenshot =
      terminalSessionUuid !== undefined && isFreshSessionScreenshotUri(uri, terminalSessionUuid);
    const ownerForwardedParams = isToolOutput
      ? undefined
      : this.freshScreenshotOwnerForwardParams(uri);
    const isSessionless = this.isSessionlessResourceRead(uri);
    const allowReleasedSession =
      isSessionless || isReleasedSessionScreenshot || ownerForwardedParams !== undefined;
    const forwardedParams = isSessionless
      ? {}
      : isReleasedSessionScreenshot
        ? {
            sessionUuid: terminalSessionUuid,
            [DAEMON_BOUND_SESSION_PARAM]: terminalSessionUuid,
            [DAEMON_RELEASED_SESSION_PARAM]: terminalSessionUuid,
          }
        : (ownerForwardedParams ?? this.withBoundSessionUuid({}));
    const forwarding = this.withRecoverableReconnect(
      () => this.requireClient().readResource(uri, forwardedParams, { signal }),
      this.sessionUuidFromArgs(forwardedParams),
      allowReleasedSession,
      true,
      undefined,
      signal,
    );
    // Recovery is shared with siblings; abandon this wait without cancelling it.
    return await raceWithDeadline(forwarding, {
      timer: this.timer,
      signal,
      label: `Daemon resource ${uri}`,
    });
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

  /** The caller's signal, also aborted (with a typed `DaemonUnavailableError`) by {@link close}. */
  private untilClosed(signal: AbortSignal | undefined): AbortSignal {
    return signal ? AbortSignal.any([signal, this.closeAbort.signal]) : this.closeAbort.signal;
  }

  /**
   * Close the connection to the daemon. Stdin EOF waits for received requests' answers before
   * reaching close (#12049); a signal, a stdout write error, or the EOF hard bound still cancels
   * calls here, before releasing owned sessions and broker grants. Session release is admitted
   * in arrival order on this proxy's socket, behind any call still running there; otherwise
   * release would time out unadmitted and leave the session to owner-disconnect release (#11642).
   * Each caller is answered with a typed `DaemonUnavailableError`, never left waiting. At the
   * EOF hard bound, `OutputGatedTransport` still writes received answers while dropping all
   * unsolicited output; a stdout write error closes that gate fully at once (#11951).
   */
  close(): Promise<void> {
    // EOF and signal/transport shutdown may overlap: keep the socket until the same release settles.
    return (this.closePromise ??= this.closeOnce());
  }

  private async closeOnce(): Promise<void> {
    const connectedClient = this.connected ? this.client : null;
    this.closing = true;
    const closingError = new DaemonUnavailableError("MCP proxy is closing");
    this.sessionBrokerAcquisitionAbort?.abort(closingError);
    this.closeAbort.abort(closingError);
    this.connected = false;
    this.livenessRecovery.stop();
    // Not awaited: a probe round waiting on a frozen daemon must not hold up close; `closing`
    // already keeps it from acting on any answer.
    void this.stallResumeProbe.stop();
    this.resourceSubscriptions.clear();
    this.resourceUpdatedListeners.clear();
    this.structuredSessionNotFound = false;
    this.completeDaemonShutdownDisconnect();
    this.cancelBackgroundConnectRetry();
    this.cancelConnectedFallbackReconcile();
    this.connectionCloseReject?.(new DaemonUnavailableError("MCP proxy is closing"));
    // Before the keeper stops, so the lease stays live until the release lands (#11176).
    await Promise.all([
      this.releaseOwnedSessions(connectedClient),
      this.releaseBrokerSessions(),
      this.joinConnectionAttempt(),
    ]);
    await this.stopBoundSessionHeartbeat();
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.notificationUnsubscribe?.();
    this.notificationUnsubscribe = null;
    this.connectionClosedUnsubscribe?.();
    this.connectionClosedUnsubscribe = null;
    this.connected = false;
    this.clearBoundSessionUuid();
    this.otherHeldSessions.clear();
    this.sessionBrokerSessions.clear();
    this.sessionBrokerBinding = undefined;
    // Every not-found window ends with the proxy: nothing is heartbeated or asked again (#11570).
    this.notFoundWindows.clear();
    this.notFoundStopped.clear();
    this.sessionDaemonInstances.clear();
    this.recoveryNotFoundOutcomes.clear();
    this.ownershipReestablishment = undefined;
    this.latestHeartbeatAsked = undefined;
    this.livenessAcks.clear();
    this.daemonIdleReports.clear();
    this.sessionDeviceIds.clear();
    this.sessionPlatforms.clear();
    this.stallHandovers.clear();
    this.resumedStallNotices.clear();
    this.pendingSessionLosses.clear();
    this.pendingHeldSessionPlatformLosses.clear();
    this.plainRestartSessionLosses.clear();
    this.livenessHandoverListeners.clear();
    this.ownedDeviceSessions.clear();
    this.terminalBoundSession = undefined;
    // Drain the per-UUID release-tracking maps at the close/reconnect boundary.
    // Ordinary completion already evicts each entry when its last in-flight
    // reference drops (issue #4655 / #5412), so these maps are bounded by the
    // count of concurrently in-flight calls. Clearing them on close is the
    // backstop the reference counter does not cover — a proxy closed with calls
    // still in flight, or reused across a reconnect, cannot retain release
    // records across its lifetime (issue #4689).
    this.releaseLedger.clearReleaseRecords();
    this.invalidateCache();
    logger.debug("[DaemonMcpProxy] Disconnected from daemon");
  }
}
