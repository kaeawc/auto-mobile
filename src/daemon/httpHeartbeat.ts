import { z } from "zod";
import { logger } from "../utils/logger";
import {
  isTokenOwnedOrClaimPending,
  resolveHeartbeatMiss,
  type HeartbeatMiss,
} from "./daemonRequestHandlers";
import { isSessionReleasing } from "./sessionReleaseState";
import { releasedSessionNotFoundFields } from "./types";

/**
 * The HTTP `POST /heartbeat` route (#11819). The not-found, observer and tokenless-owner rules are
 * the socket heartbeat's (`resolveHeartbeatMiss`, `isTokenOwnedOrClaimPending`); this module only
 * adapts them to HTTP status codes and validates the request body instead of trusting its shape.
 */

export interface HttpHeartbeatSession {
  livenessOwnerToken?: string;
  livenessOwnershipClaims?: { size: number };
}

/** What the HTTP route reads and writes on the session manager. */
export interface HttpHeartbeatManager {
  getSession(sessionId: string): HttpHeartbeatSession | null;
  getReleasingSession?(sessionId: string): HttpHeartbeatSession | null;
  hasLivenessOwnership(sessionId: string, ownerToken: string): boolean;
  claimUnownedLivenessOwnership(sessionId: string, ownerToken: string): boolean;
  recordHeartbeat(sessionId: string): void;
  creditOwnerHeartbeatDuringRelease?(sessionId: string, ownerToken: string): void;
  getReleasedSessionReason?(sessionId: string): Promise<string | undefined>;
}

export interface HttpHeartbeatResponse {
  status: 200 | 400 | 404;
  body: Record<string, unknown>;
}

const heartbeatBodySchema = z.object({
  sessionId: z.string().min(1),
  livenessOwnerToken: z.unknown().optional(),
});

/** The validated body, or the 400 the route answers with. */
export function parseHttpHeartbeatBody(
  raw: string,
):
  | { ok: true; sessionId: string; livenessOwnerToken: unknown }
  | { ok: false; response: HttpHeartbeatResponse } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    // Invalid client JSON is expected; the 400 response fully describes the failure.
    logger.debug(`Invalid heartbeat JSON: ${error}`);
    return { ok: false, response: { status: 400, body: { error: "Invalid JSON" } } };
  }
  const parsed = heartbeatBodySchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, response: { status: 400, body: { error: "Missing sessionId" } } };
  }
  return {
    ok: true,
    sessionId: parsed.data.sessionId,
    livenessOwnerToken: parsed.data.livenessOwnerToken,
  };
}

const OK: HttpHeartbeatResponse = { status: 200, body: { status: "ok" } };

function readOwnerToken(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function handleHttpHeartbeat(
  manager: HttpHeartbeatManager,
  observers: Parameters<typeof resolveHeartbeatMiss>[1],
  sessionId: string,
  livenessOwnerToken: unknown,
): Promise<HttpHeartbeatResponse> {
  const ownerToken = readOwnerToken(livenessOwnerToken);
  const session = manager.getSession(sessionId) ?? manager.getReleasingSession?.(sessionId) ?? null;
  // An unknown, released, or releasing session id is a 404 unless it names a live observer
  // session, so a client learns its session is gone instead of heartbeating a dead id forever.
  if (!session || isSessionReleasing(manager, sessionId, session)) {
    const miss: HeartbeatMiss = await resolveHeartbeatMiss(
      // The resolver reads only the credit and release-reason hooks.
      manager as Parameters<typeof resolveHeartbeatMiss>[0],
      observers,
      sessionId,
      ownerToken,
    );
    if (miss.kind === "observer") {
      return OK;
    }
    return {
      status: 404,
      body: {
        error: `Session not found: ${sessionId}`,
        ...releasedSessionNotFoundFields(miss.recordedReason),
      },
    };
  }
  // Match the socket's non-claiming rule; a different owner remains a 200 liveness no-op.
  const ownsLiveness = ownerToken
    ? manager.hasLivenessOwnership(sessionId, ownerToken) ||
      manager.claimUnownedLivenessOwnership(sessionId, ownerToken)
    : !isTokenOwnedOrClaimPending(session);
  if (ownsLiveness) {
    manager.recordHeartbeat(sessionId);
  }
  return OK;
}
