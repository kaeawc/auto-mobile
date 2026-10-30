import { DaemonUnavailableError } from "../client/client";
import { type BuildIdentity, describeBuildIdentity } from "../wire/buildIdentity";

export type BuildMismatchReason = "autoStartDisabled" | "cooldown" | "restartMismatch";

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
    const retryGuidance =
      params.retryAfterMs !== undefined ? ` Retry after ${params.retryAfterMs}ms.` : "";
    super(
      `AutoMobile daemon build mismatch: the running daemon is a different build than this client ` +
        `(${params.detail}). daemon build=${describeBuildIdentity(params.daemon)}, ` +
        `client build=${describeBuildIdentity(params.client)}.${retryGuidance}`,
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
