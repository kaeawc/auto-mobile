import { releaseVersion } from "../utils/mcpVersion";
import {
  type BuildIdentity,
  buildIdentitiesMatch,
  describeBuildIdentity,
} from "./buildIdentity";

/**
 * Server-side version/build-identity handshake for the shared per-uid daemon
 * socket.
 *
 * All AutoMobile clients (the TypeScript MCP proxy, the Android JUnit runner,
 * the iOS XCTestRunner) connect to one per-uid Unix socket. Build-identity
 * enforcement previously lived only in the TypeScript proxy, client-side, so a
 * Kotlin/Swift client could silently execute against a wrong-build daemon
 * (#2744). This module is the single, language-agnostic gate the daemon runs on
 * every inbound request: a client declares its version (and, for the TS client,
 * its build id) and the daemon rejects a mismatch with an actionable error.
 *
 * The comparison mirrors {@link DaemonMcpProxy}'s `ensureVersionMatches` /
 * `ensureBuildMatches`: the release portion (before the `+g<sha>` dev stamp)
 * drives the version decision, and the entry-script content hash drives the
 * build decision. The daemon cannot restart itself, so any mismatch is a hard
 * reject — the client reconciles (restart the daemon, or self-heal).
 */

export type HandshakeMismatchReason = "version" | "build";

/**
 * The identity fields a client declares on connect. All optional so a legacy
 * client that sends none is allowed through (backward compatible). Kotlin/Swift
 * declare only {@link clientVersion}; the TS client additionally declares its
 * build id + entry script so same-release dev-skew is caught.
 */
export interface ClientHandshake {
  clientVersion?: string;
  clientBuildId?: string;
  clientEntryScript?: string;
}

/** The daemon's own identity, compared against each client handshake. */
export interface DaemonSelfIdentity {
  version: string;
  build: BuildIdentity;
}

export type HandshakeEvaluation =
  | { ok: true }
  | { ok: false; reason: HandshakeMismatchReason; message: string };

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Pull the optional handshake fields off an inbound request payload, normalizing
 * whitespace and dropping non-string values.
 */
export function extractClientHandshake(request: {
  clientVersion?: unknown;
  clientBuildId?: unknown;
  clientEntryScript?: unknown;
}): ClientHandshake {
  return {
    clientVersion: trimmedString(request.clientVersion),
    clientBuildId: trimmedString(request.clientBuildId),
    clientEntryScript: trimmedString(request.clientEntryScript),
  };
}

/** Whether the client declared anything to gate on. */
export function hasClientHandshake(handshake: ClientHandshake): boolean {
  return (
    (handshake.clientVersion?.length ?? 0) > 0 ||
    (handshake.clientBuildId?.length ?? 0) > 0
  );
}

/**
 * Decide whether a client may attach to this daemon.
 *
 * - No handshake fields -> allow (legacy client; matches the "unknown => match"
 *   philosophy of {@link buildIdentitiesMatch} so existing clients are not
 *   broken).
 * - Build gate (checked first): reject when both sides expose a known build id
 *   and it differs. Version-only clients (Kotlin/Swift) skip this branch because
 *   {@link buildIdentitiesMatch} treats an unknown id as a match.
 * - Version gate: a version-only client is compared on the release portion (so a
 *   plain `0.0.40` still matches a source-checkout daemon's `0.0.40+g<sha>`). A
 *   client that supplies a build identity (the TS client) is instead held to the
 *   **full** dev-stamped version: its entry-script build hash is blind to changes
 *   in imported files (same `argv[1]`, different commit), so the git stamp is the
 *   only signal for same-entry dev-skew — the #2732 case that a TS socket client
 *   bypassing {@link DaemonMcpProxy} (e.g. the CLI's direct `DaemonClient`) would
 *   otherwise slip past.
 */
export function evaluateClientHandshake(
  daemon: DaemonSelfIdentity,
  client: ClientHandshake
): HandshakeEvaluation {
  if (!hasClientHandshake(client)) {
    return { ok: true };
  }

  const clientBuild: BuildIdentity = {
    entryScript: client.clientEntryScript ?? "",
    buildId: client.clientBuildId ?? "unknown",
  };
  const clientDeclaresBuildId =
    (client.clientBuildId?.length ?? 0) > 0 && client.clientBuildId !== "unknown";

  if (!buildIdentitiesMatch(daemon.build, clientBuild)) {
    return {
      ok: false,
      reason: "build",
      message:
        `AutoMobile daemon build mismatch: the shared daemon socket is served by a different ` +
        `build than this client. daemon build=${describeBuildIdentity(daemon.build)}, ` +
        `client build=${describeBuildIdentity(clientBuild)}. ` +
        `Restart the daemon from this client's checkout to resolve the skew.`,
    };
  }

  const clientVersion = client.clientVersion;
  if (clientVersion) {
    const daemonFull = daemon.version.trim();
    const versionsDiffer = clientDeclaresBuildId
      ? daemonFull.length > 0 && daemonFull !== clientVersion
      : (() => {
          const clientBase = releaseVersion(clientVersion);
          const daemonBase = releaseVersion(daemonFull);
          return clientBase.length > 0 && daemonBase.length > 0 && clientBase !== daemonBase;
        })();
    if (versionsDiffer) {
      return {
        ok: false,
        reason: "version",
        message:
          `AutoMobile daemon version mismatch: the shared daemon socket is served by ` +
          `daemon=${daemon.version || "unknown"} but this client is ${clientVersion}. ` +
          `Restart the daemon from this client's build (e.g. \`auto-mobile --daemon restart\`) ` +
          `so the per-uid socket serves a matching version.`,
      };
    }
  }

  return { ok: true };
}
