import type { Socket } from "node:net";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { StreamSocketAuthenticator } from "../streamSocketAuth";
import type { SubscriptionResponse } from "../socketServer/index";

export interface StreamSocketIdentitiesHost {
  readonly authenticator: StreamSocketAuthenticator;
  sendJson(socket: Socket, message: SubscriptionResponse): void;
  onConnectionClose(socket: Socket): void;
}

/** Tracks admitted identities and ends sockets whose sessions have been released. */
export class StreamSocketIdentities {
  constructor(private readonly host: StreamSocketIdentitiesHost) {}

  clear(): void {
    this.identitiesBySocket.clear();
  }

  delete(socket: Socket): void {
    this.identitiesBySocket.delete(socket);
  }

  /** Identities each connection was admitted with, so a gone observer's streams end (#11076). */
  private readonly identitiesBySocket = new Map<Socket, Set<string>>();

  /**
   * End every connection admitted with `sessionUuid` (an observer whose registration was released
   * or expired, #11076): its subscriptions and storage observers are dropped and the client gets a
   * terminal `SESSION_ENDED` frame. Returns how many connections ended.
   */
  revokeIdentity(sessionUuid: string): number {
    const sockets = [...this.identitiesBySocket]
      .filter(([, identities]) => identities.has(sessionUuid))
      .map(([socket]) => socket);
    for (const socket of sockets) {
      this.endSessionEndedSocket(socket);
    }
    return sockets.length;
  }

  /**
   * End every connection admitted under an identity that is no longer live (released, expired or
   * releasing). Called on session release and before each device frame push, so a subscriber of a
   * released session never sees the next holder's hierarchies, screenshots or storage (#11130).
   */
  endStaleIdentitySockets(): number {
    const sockets = [...this.identitiesBySocket.keys()].filter((socket) =>
      this.isSocketIdentityStale(socket),
    );
    for (const socket of sockets) {
      this.endSessionEndedSocket(socket);
    }
    return sockets.length;
  }

  /** Whether any identity this connection was admitted with is gone. Pure; never ends the socket. */
  isSocketIdentityStale(socket: Socket): boolean {
    const identities = this.identitiesBySocket.get(socket);
    return !!identities && [...identities].some((sessionUuid) => !this.isIdentityLive(sessionUuid));
  }

  private isIdentityLive(sessionUuid: string): boolean {
    const identity = this.host.authenticator.resolveSubscriptionIdentity?.({ sessionUuid });
    if (identity) {
      return !identity.authEnabled || identity.sessionExists;
    }
    try {
      this.host.authenticator.authorize({ sessionUuid });
      return true;
    } catch (error) {
      // A refused re-authorization is the expected answer for a released identity; the caller
      // ends the connection with SESSION_ENDED, so there is nothing further to surface here.
      logger.debug(`[DeviceDataStream] identity no longer authorized: ${errorMessage(error)}`);
      return false;
    }
  }

  private endSessionEndedSocket(socket: Socket): void {
    logger.info("[DeviceDataStream] ending connection: reason=session_ended");
    try {
      if (!socket.destroyed) {
        this.host.sendJson(socket, {
          type: "error",
          success: false,
          code: "SESSION_ENDED",
          error: "Observation stream ended: session_ended",
        } satisfies SubscriptionResponse);
      }
    } catch (error) {
      // The peer may already be gone; its subscriptions are released below either way.
      logger.debug(`[DeviceDataStream] session_ended notice failed: ${errorMessage(error)}`);
    }
    this.host.onConnectionClose(socket);
    this.endRevokedSocket(socket);
  }

  private endRevokedSocket(socket: Socket): void {
    try {
      socket.end();
    } catch (error) {
      logger.warn(`[DeviceDataStream] Failed to end revoked connection: ${errorMessage(error)}`);
      socket.destroy();
    }
  }

  recordSocketIdentity(socket: Socket, sessionUuid: string | undefined): void {
    if (typeof sessionUuid !== "string" || sessionUuid.length === 0 || socket.destroyed) {
      return;
    }
    const identities = this.identitiesBySocket.get(socket) ?? new Set<string>();
    identities.add(sessionUuid);
    this.identitiesBySocket.set(socket, identities);
  }
}
