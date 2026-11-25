import { type BuildIdentity, describeBuildIdentity } from "../wire/buildIdentity";
import { DAEMON_TOOL_UNAVAILABLE_CODE } from "../types";
import { PLAN_ONLY_CALL_HINT } from "../toolUnavailableError";

interface DaemonToolUnavailableParams {
  toolName: string;
  client: BuildIdentity;
  daemon: BuildIdentity;
  buildMismatch?: boolean;
  daemonRejection?: string;
  gated?: boolean;
}

function hasKnownBuildId(identity: BuildIdentity): boolean {
  return identity.buildId !== "unknown" && identity.buildId.length > 0;
}

function matchingReasonFor(client: BuildIdentity, daemon: BuildIdentity): string {
  if (hasKnownBuildId(client) && hasKnownBuildId(daemon)) {
    return "The client and daemon build IDs match.";
  }
  return client.entryScript.length > 0 && daemon.entryScript.length > 0
    ? "One or both build IDs are unknown; the entry-script paths match."
    : "Build identity is unavailable on at least one side, so the builds cannot be compared.";
}

function buildsOf(params: DaemonToolUnavailableParams): string {
  return (
    `client build=${describeBuildIdentity(params.client)}, ` +
    `daemon build=${describeBuildIdentity(params.daemon)}.`
  );
}

function unavailableMessage(params: DaemonToolUnavailableParams): string {
  const rejection = params.daemonRejection;
  if (params.buildMismatch !== false) {
    return (
      `Tool "${params.toolName}" is advertised by this AutoMobile client but the connected daemon ` +
      `does not provide it, even after restarting and refreshing the tool list. This usually means a ` +
      `wrong-build daemon is serving this frontend. ${buildsOf(params)} ` +
      `Restart the daemon from this checkout to resolve the skew.` +
      `${rejection ? ` Daemon rejection: ${rejection}.` : ""}`
    );
  }
  if (rejection?.includes(PLAN_ONLY_CALL_HINT)) {
    // A plan-only tool is not a configuration problem: lead with how to call it (#19194).
    return (
      `Tool "${params.toolName}" ${PLAN_ONLY_CALL_HINT}; a direct call is refused. ` +
      `Daemon rejection: ${rejection}.`
    );
  }
  return (
    `Tool "${params.toolName}" is advertised by this AutoMobile client but is unavailable in ` +
    `the connected daemon's current configuration for this session. ` +
    `${rejection ? `Daemon rejection: ${rejection}. ` : ""}` +
    `${buildsOf(params)} ${matchingReasonFor(params.client, params.daemon)}`
  );
}

/** Raised when a frontend-advertised tool is rejected by the daemon as unknown. */
export class DaemonToolUnavailableError extends Error {
  /** Set when the daemon's availability gate rejected the call, so callers can tell it from skew. */
  readonly code?: typeof DAEMON_TOOL_UNAVAILABLE_CODE;
  readonly toolName: string;
  /** True when the client and daemon builds differ, so a daemon restart can fix it. */
  readonly buildMismatch: boolean;
  readonly clientBuildId: string;
  readonly daemonBuildId: string;

  constructor(params: DaemonToolUnavailableParams) {
    super(unavailableMessage(params));
    this.name = "DaemonToolUnavailableError";
    if (params.gated) {
      this.code = DAEMON_TOOL_UNAVAILABLE_CODE;
    }
    this.toolName = params.toolName;
    this.buildMismatch = params.buildMismatch !== false;
    this.clientBuildId = params.client.buildId;
    this.daemonBuildId = params.daemon.buildId;
  }
}
