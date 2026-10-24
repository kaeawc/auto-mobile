import { type BuildIdentity, describeBuildIdentity } from "../wire/buildIdentity";
import { DAEMON_TOOL_UNAVAILABLE_CODE } from "../types";

/** Raised when a frontend-advertised tool is rejected by the daemon as unknown. */
export class DaemonToolUnavailableError extends Error {
  /** Set when the daemon's availability gate rejected the call, so callers can tell it from skew. */
  readonly code?: typeof DAEMON_TOOL_UNAVAILABLE_CODE;
  readonly toolName: string;
  readonly clientBuildId: string;
  readonly daemonBuildId: string;

  constructor(params: {
    toolName: string;
    client: BuildIdentity;
    daemon: BuildIdentity;
    buildMismatch?: boolean;
    daemonRejection?: string;
    gated?: boolean;
  }) {
    const matchingReason =
      params.client.buildId !== "unknown" &&
      params.client.buildId.length > 0 &&
      params.daemon.buildId !== "unknown" &&
      params.daemon.buildId.length > 0
        ? "The client and daemon build IDs match."
        : params.client.entryScript.length > 0 && params.daemon.entryScript.length > 0
          ? "One or both build IDs are unknown; the entry-script paths match."
          : "Build identity is unavailable on at least one side, so the builds cannot be compared.";
    super(
      params.buildMismatch === false
        ? `Tool "${params.toolName}" is advertised by this AutoMobile client but is unavailable in ` +
            `the connected daemon's current configuration for this session. ` +
            `${params.daemonRejection ? `Daemon rejection: ${params.daemonRejection}. ` : ""}` +
            `client build=${describeBuildIdentity(params.client)}, ` +
            `daemon build=${describeBuildIdentity(params.daemon)}. ${matchingReason}`
        : `Tool "${params.toolName}" is advertised by this AutoMobile client but the connected daemon ` +
            `does not provide it, even after restarting and refreshing the tool list. This usually means a ` +
            `wrong-build daemon is serving this frontend. ` +
            `client build=${describeBuildIdentity(params.client)}, ` +
            `daemon build=${describeBuildIdentity(params.daemon)}. ` +
            `Restart the daemon from this checkout to resolve the skew.` +
            `${params.daemonRejection ? ` Daemon rejection: ${params.daemonRejection}.` : ""}`,
    );
    this.name = "DaemonToolUnavailableError";
    if (params.gated) {
      this.code = DAEMON_TOOL_UNAVAILABLE_CODE;
    }
    this.toolName = params.toolName;
    this.clientBuildId = params.client.buildId;
    this.daemonBuildId = params.daemon.buildId;
  }
}
