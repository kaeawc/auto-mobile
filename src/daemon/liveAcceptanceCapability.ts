import { createHmac, timingSafeEqual } from "node:crypto";
import { stableStringify } from "../utils/stableStringify";

/**
 * A live-acceptance harness creates this secret before it starts a daemon. It
 * is inherited only by the harness-launched daemon and short-lived harness CLI
 * children; ordinary clients never receive it from the daemon.
 */
export const DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV =
  "AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET";

export interface DaemonGenerationIdentity {
  pid: number;
  startedAt: number;
  processGenerationToken?: string;
  version: string;
  buildId: string;
  entryScript: string;
}

export function daemonGenerationIdentityFromStatus(
  status: Partial<DaemonGenerationIdentity>,
): DaemonGenerationIdentity | undefined {
  if (
    typeof status.pid !== "number" ||
    typeof status.startedAt !== "number" ||
    typeof status.version !== "string" ||
    typeof status.buildId !== "string" ||
    typeof status.entryScript !== "string" ||
    (status.processGenerationToken !== undefined &&
      typeof status.processGenerationToken !== "string")
  ) {
    return undefined;
  }
  return {
    pid: status.pid,
    startedAt: status.startedAt,
    ...(status.processGenerationToken === undefined
      ? {}
      : { processGenerationToken: status.processGenerationToken }),
    version: status.version,
    buildId: status.buildId,
    entryScript: status.entryScript,
  };
}

function generationCapabilityPayload(identity: DaemonGenerationIdentity): string {
  return [
    "auto-mobile-live-acceptance-capability-v1",
    identity.pid,
    identity.startedAt,
    identity.processGenerationToken ?? "",
    identity.version,
    identity.buildId,
    identity.entryScript,
  ].join("\0");
}

/**
 * Derives a capability that is valid only for one daemon generation. The
 * startup secret itself is never returned by a daemon RPC.
 */
export function createDaemonLiveAcceptanceCapability(
  startupSecret: string,
  identity: DaemonGenerationIdentity,
): string {
  return createHmac("sha256", startupSecret)
    .update(generationCapabilityPayload(identity))
    .digest("base64url");
}

export function daemonLiveAcceptanceCapabilityMatches(
  startupSecret: string | undefined,
  identity: DaemonGenerationIdentity,
  capability: unknown,
): boolean {
  return daemonLiveAcceptanceScopedCapabilityMatches(
    startupSecret,
    identity,
    undefined,
    capability,
  );
}

/**
 * A live-acceptance operation can additionally bind authority to an immutable
 * request scope (for example one persisted session and its signed control set).
 * The daemon validates the scope before acting; a capability for one scope
 * cannot be replayed for another session, target, or generation.
 */
export function createDaemonLiveAcceptanceScopedCapability(
  startupSecret: string,
  identity: DaemonGenerationIdentity,
  scope: unknown,
): string {
  return createHmac("sha256", startupSecret)
    .update(`${generationCapabilityPayload(identity)}\0${stableStringify(scope)}`)
    .digest("base64url");
}

export function daemonLiveAcceptanceScopedCapabilityMatches(
  startupSecret: string | undefined,
  identity: DaemonGenerationIdentity,
  scope: unknown,
  capability: unknown,
): boolean {
  if (!startupSecret || typeof capability !== "string") {
    return false;
  }
  const expected = Buffer.from(
    scope === undefined
      ? createDaemonLiveAcceptanceCapability(startupSecret, identity)
      : createDaemonLiveAcceptanceScopedCapability(startupSecret, identity, scope),
  );
  const supplied = Buffer.from(capability);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/**
 * Reject short accidental values rather than turning a regular daemon launch
 * into an acceptance-enabled daemon.
 */
export function daemonLiveAcceptanceStartupSecret(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const secret = environment[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
  return secret && secret.length >= 32 ? secret : undefined;
}
