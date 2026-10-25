import { timingSafeEqual } from "node:crypto";
import {
  INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM,
  INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM,
  INTERNAL_ACTIONS_COMPACT_METADATA_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_SESSION_PARAM,
  INTERNAL_ONE_SHOT_CLI_PARAM,
  INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM,
} from "../../../daemon/wire/constants";

function extractInternalMcpSessionId(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }

  const value = (params as Record<string, unknown>)[INTERNAL_MCP_SESSION_PARAM];
  return typeof value === "string" ? value : undefined;
}

function extractInternalOneShotCli(params: unknown): boolean {
  return (
    !!params &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    (params as Record<string, unknown>)[INTERNAL_ONE_SHOT_CLI_PARAM] === true
  );
}

function extractInternalMcpRequestTimeoutMs(params: unknown): number | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[INTERNAL_MCP_REQUEST_TIMEOUT_PARAM];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Extract {@link INTERNAL_MCP_REQUEST_DEADLINE_PARAM} -- the ABSOLUTE
 * deadline the daemon anchored at capture time, before this process's own
 * HTTP dispatch and admission/tool-selection repo reads could consume any of
 * `requestTimeoutMs`'s budget (issue #6222 review, PRRT_kwDOP-GF5M6fuyts P1).
 * A handler that receives this should prefer it outright over recomputing
 * `execution.startTime + requestTimeoutMs`, which re-grants that gap.
 */
function extractInternalMcpRequestDeadlineMs(params: unknown): number | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[INTERNAL_MCP_REQUEST_DEADLINE_PARAM];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function extractInternalLiveDeadlineKey(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[INTERNAL_LIVE_DEADLINE_KEY_PARAM];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractInternalToolResultsNoStructuredContent(params: unknown): boolean | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[
    INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM
  ];
  return typeof value === "boolean" ? value : undefined;
}

function extractInternalActionsCompactMetadata(params: unknown): boolean | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[INTERNAL_ACTIONS_COMPACT_METADATA_PARAM];
  return typeof value === "boolean" ? value : undefined;
}

function extractInternalAcceptanceDiscoveryOrder(
  params: unknown,
  expectedCapability: string | undefined,
): "forward" | "reverse" | undefined {
  if (!expectedCapability || !params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const values = params as Record<string, unknown>;
  const suppliedCapability = values[INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM];
  if (
    typeof suppliedCapability !== "string" ||
    suppliedCapability.length !== expectedCapability.length ||
    !timingSafeEqual(Buffer.from(suppliedCapability), Buffer.from(expectedCapability))
  ) {
    return undefined;
  }
  const value = values[INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM];
  return value === "forward" || value === "reverse" ? value : undefined;
}

// `formatToolParamError` lives in its own module so non-server callers (e.g.
// PlanExecutor, #5854 §3) can share the exact MCP-boundary rendering without
// importing the whole server entrypoint (which would be circular). Re-exported

/**
 * The call context the daemon forwards in-band as `__*` argument keys. This is
 * the one place those keys are read: every later stage reads this typed value,
 * never the raw arguments.
 */
export interface CallContext {
  /** The forwarded MCP connection identity (daemon transport only). */
  readonly requestMcpSessionId: string | undefined;
  readonly requestOneShotCli: boolean;
  readonly requestedToolResultsNoStructuredContent: boolean | undefined;
  readonly requestedActionsCompactMetadata: boolean | undefined;
  readonly requestTimeoutMs: number | undefined;
  readonly requestDeadlineMs: number | undefined;
  readonly requestLiveDeadlineKey: string | undefined;
  readonly requestAcceptanceDiscoveryOrder: "forward" | "reverse" | undefined;
}

export interface ParseCallContextOptions {
  readonly daemonMode: boolean;
  readonly acceptanceDiscoveryCapability: string | undefined;
  /** The request's explicit session key (the session-key header, or a forward's connection key). */
  readonly sessionKey?: string;
  /**
   * The call came over the daemon's own in-process forward: its in-band `__mcpSessionId`
   * identifies the originating client and outranks `sessionKey` (#13315).
   */
  readonly trustForwardedSessionId?: boolean;
}

/**
 * The one session identity of a daemon call (#13315, owner decision). The session-key header
 * wins; the exception is a trusted forwarder, whose in-band id names the client behind the
 * forwarding connection. A direct request with no header still falls back to its in-band id.
 * A call with no in-band id yields none: the key alone is the server's binding key.
 */
function resolveRequestMcpSessionId(
  params: unknown,
  options: ParseCallContextOptions,
): string | undefined {
  const inBand = extractInternalMcpSessionId(params);
  if (inBand === undefined) {
    // No in-band carrier: the key stays the server's binding key, not an implicit-autolock id.
    return undefined;
  }
  return options.trustForwardedSessionId === true ? inBand : (options.sessionKey ?? inBand);
}

/**
 * Read every forwarded in-band key from the raw arguments. They are honored
 * only when the call is DAEMON-forwarded: `daemonMode` is a server-construction
 * boundary a direct (stdio / in-memory) caller cannot influence, so gating on
 * it is what stops such a caller from forging its own identity, transport
 * deadline or ownership (#6222, #11096).
 */
export function parseCallContext(params: unknown, options: ParseCallContextOptions): CallContext {
  const { daemonMode } = options;
  return {
    requestMcpSessionId: daemonMode ? resolveRequestMcpSessionId(params, options) : undefined,
    requestOneShotCli: daemonMode && extractInternalOneShotCli(params),
    requestedToolResultsNoStructuredContent: daemonMode
      ? extractInternalToolResultsNoStructuredContent(params)
      : undefined,
    requestedActionsCompactMetadata: daemonMode
      ? extractInternalActionsCompactMetadata(params)
      : undefined,
    requestTimeoutMs: daemonMode ? extractInternalMcpRequestTimeoutMs(params) : undefined,
    requestDeadlineMs: daemonMode ? extractInternalMcpRequestDeadlineMs(params) : undefined,
    requestLiveDeadlineKey: daemonMode ? extractInternalLiveDeadlineKey(params) : undefined,
    requestAcceptanceDiscoveryOrder: daemonMode
      ? extractInternalAcceptanceDiscoveryOrder(params, options.acceptanceDiscoveryCapability)
      : undefined,
  };
}
