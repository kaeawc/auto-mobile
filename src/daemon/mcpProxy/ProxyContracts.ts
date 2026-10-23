import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type { BackoffInput } from "../../utils/Backoff";
import { type IdGenerator } from "../../utils/IdGenerator";
import { type Timer } from "../../utils/SystemTimer";
import { carryToolFailureMark } from "../../utils/toolFailureSignal";
import { type BuildIdentity } from "../buildIdentity";
import { DaemonClient, type DaemonClientFactory } from "../client";
import { DaemonBoundSessionLostError } from "../DaemonBoundSessionLostError";
import {
  type DeviceSessionSuspectRefusal,
  isDeviceSessionAcquisitionTool,
} from "../deviceSessionResult";
import { type DaemonManagerLike } from "../manager";
import {
  DaemonBoundSessionExpiredError,
  DaemonToolOutcomeUnknownError,
} from "../proxy/daemonErrors";
import { livenessResumedNotice } from "../proxyLivenessRecovery";
import { getConnectedStaticToolDefinitions } from "../staticToolDefinitions";
import { type DaemonOptions, type DaemonStatus } from "../types";

export const CLI_SESSION_FINALIZATION_TIMEOUT_MS = 2_000;

export const COLD_RESOURCE_CONNECT_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;

// These inventory tools never operate a device or mint a device session. They
// normally retain a live binding's policy, but after that binding is terminally
// released they must be able to discover the stable target for an explicit
// getAndroid/getApple reacquisition (#7144).
export const SESSIONLESS_DEVICE_DISCOVERY_TOOLS = ["listDevices", "listDeviceImages"] as const;

/**
 * A tool definition's read classification, generated from the tool's `deviceReadOnly`
 * registration (#10971): the tool only watches a device, which never requires a session.
 */
export const DEVICE_READ_ONLY_META_KEY = "automobile/deviceReadOnly";

export const DEVICE_READ_ONLY_ARGS_META_KEY = "automobile/deviceReadOnlyArgs";

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
export function isSuspectRefusalRetryable(
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

/** Per-call options of {@link DaemonMcpProxy.callTool}. */
export interface DaemonProxyToolCallOptions {
  /**
   * Whether the client's own `tools/call` declared the MCP Tasks extension (#4668). Only then may
   * the daemon answer with a task handle.
   */
  readonly declaresTasks?: boolean;
}

/** Failures that give no evidence the forwarded session is still live and admitted. */
export function isUnprovenSessionAdmissionError(error: unknown): boolean {
  return (
    error instanceof DaemonBoundSessionExpiredError ||
    error instanceof DaemonBoundSessionLostError ||
    error instanceof DaemonToolOutcomeUnknownError
  );
}

export function isFreshSessionScreenshotUri(uri: string, sessionUuid: string): boolean {
  return uri === `automobile:device-session/${sessionUuid}/screenshot`;
}

/** Append the resumed-session warning as one more text block of a tool result (#10989). */
export function withResumedNotice(
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
export const tokenOwnedSessionSchema = z.object({
  sessionId: z.string().min(1),
  deviceId: z.string().optional().catch(undefined),
  platform: z.enum(["android", "ios"]).optional().catch(undefined),
  /**
   * The daemon's record of the session's last tool use. Unknown means no use this proxy can vouch
   * for: the held session then stays only while the daemon reports it in use.
   */
  lastUsedAt: z.number().catch(Number.NEGATIVE_INFINITY),
});

export type TokenOwnedSession = z.infer<typeof tokenOwnedSessionSchema>;

/** The daemon's `daemon/tokenOwnedSessions` answer; malformed entries are skipped. */
export function parseTokenOwnedSessions(result: unknown): TokenOwnedSession[] {
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
  /** Interval of the list_changed polling fallback (#4678); defaults to 30 s. */
  listPollIntervalMs?: number;
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
  /** Version a daemon started from this checkout would report now; null when unknown. */
  readCheckoutVersion?: () => Promise<string | null>;
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
  title?: string;
  annotations?: ToolAnnotations;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  // Passed through verbatim from the daemon (live path) or the committed static
  // surface (cold path) — e.g. the MCP Apps UI pointer `_meta.ui.resourceUri`
  // (issue #4669). Non-Apps hosts ignore it.
  _meta?: Record<string, unknown>;
}

export function connectedStaticToolDefinitionsProvider(
  config: DaemonMcpProxyConfig,
): (daemonOptions?: DaemonOptions) => ProxiedToolDefinition[] {
  return (
    config.connectedStaticToolDefinitionsProvider ??
    config.staticToolDefinitionsProvider ??
    getConnectedStaticToolDefinitions
  );
}

export function daemonAvailabilityProbe(
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

export interface DaemonMcpProxyCloseOptions {
  /**
   * The proxy shuts down because its execution owner died (#12791): broker sessions are ended as
   * `session_owner_exited`, not as the client's release.
   */
  executionOwnerLost?: boolean;
}
