import { shellQuote } from "../../utils/shellQuote";
import { releaseVersion } from "../../utils/mcpVersion";
import { DaemonUnavailableError } from "../client";
import { type BuildIdentity, describeBuildIdentity } from "../buildIdentity";

export type VersionMismatchReason =
  | "autoStartDisabled"
  | "cooldown"
  | "daemonNewer"
  | "nonNumeric"
  | "staleClient"
  | "restartMismatch";

function daemonRestartCommand(clientVersion: string, clientBuild?: BuildIdentity): string {
  if (clientBuild?.entryScript) {
    return `${shellQuote(process.execPath)} ${shellQuote(clientBuild.entryScript)} --daemon restart`;
  }
  const installableVersion = releaseVersion(clientVersion);
  return installableVersion.length > 0 && installableVersion !== "unknown"
    ? `bunx @kaeawc/auto-mobile@${installableVersion} --daemon restart`
    : "the same installed auto-mobile package";
}

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
    clientBuild?: BuildIdentity;
    daemonBuild?: BuildIdentity;
  }) {
    // Use the client's own entrypoint when available. Direct callers that do not
    // provide build identity retain the published-version fallback.
    const installableVersion = releaseVersion(params.clientVersion);
    const restartCommand = daemonRestartCommand(params.clientVersion, params.clientBuild);
    const unresolvedClientVersion =
      installableVersion.trim() === "" || installableVersion === "unknown";
    const retryGuidance =
      params.reason === "staleClient"
        ? " Restarting the daemon cannot reconcile this mismatch because the daemon already runs this checkout's current version. Relaunch this MCP client so it loads the current checkout."
        : unresolvedClientVersion
          ? " The client package version could not be resolved. Reinstall or repair the AutoMobile client package, then relaunch this MCP client. Restarting the daemon cannot repair missing client version metadata."
          : params.retryAfterMs !== undefined
            ? ` Retry after ${params.retryAfterMs}ms or restart the daemon from this client's build: ${restartCommand}`
            : ` Restart the daemon from this client's build: ${restartCommand}`;
    const sameRelease =
      releaseVersion(params.daemonVersion) === releaseVersion(params.clientVersion) &&
      params.daemonVersion !== params.clientVersion;
    const mismatchMessage =
      params.reason !== "staleClient" && sameRelease && params.clientBuild && params.daemonBuild
        ? `AutoMobile daemon build mismatch: daemon build ${describeBuildIdentity(params.daemonBuild)} != ` +
          `client build ${describeBuildIdentity(params.clientBuild)} (${params.detail}).${retryGuidance}`
        : `AutoMobile daemon version mismatch: daemon=${params.daemonVersion}, client=${params.clientVersion} ` +
          `(${params.detail}).${retryGuidance}`;
    super(mismatchMessage);
    this.name = "DaemonVersionMismatchError";
    this.clientVersion = params.clientVersion;
    this.daemonVersion = params.daemonVersion;
    this.reason = params.reason;
    this.retryAfterMs = params.retryAfterMs;
  }
}
