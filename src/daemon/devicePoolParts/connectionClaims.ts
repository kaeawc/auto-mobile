import { logger } from "../../utils/logger";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface ConnectionClaimsOperations {
  /**
   * Track a bind for `mcpSessionId` until the returned callback runs (#11146). The tool-call entry
   * holds one across a whole explicit-sessionUuid device call (#11348): its attach runs after the
   * handler, so a close during the handler must still be seen by {@link recordBindOwnership}.
   */
  beginMcpBind(mcpSessionId: string | undefined): () => void;
  /** #11999: retain a connection's close through forwarding and its terminal answer write. */
  beginMcpToolCall(mcpSessionId: string | undefined): (delivered?: boolean) => void;
  recordBindOwnership(mcpSessionId: string | undefined, sessionId: string): boolean;
  ownershipSessionId(sessionId: string): string;
  hasAcquiredDeviceSession(mcpSessionId: string, sessionId: string): boolean;
  /** Remember the connection's identity before acquisition, even with no retained sessions. */
  declareMcpSessionLivenessOwnerToken(mcpSessionId: string, token: string): void;
  registerMcpSessionOwnerCallReader(): void;
  /** Only a still-connected caller presenting the mint's token defends its claim lease. */
  beginMcpSessionOwnerCall(mcpSessionId: string, token: string): () => void;
  recordMintedSessionOwnership(
    mcpSessionId: string | undefined,
    sessionId: string,
    oneShotCli: boolean,
    clientSuppliedId?: boolean,
  ): boolean;
  recordMcpSessionOwnership(mcpSessionId: string | undefined, namedSessionId: string): void;
}
type ConnectionClaimsState = Pick<
  DevicePoolState,
  | "mcpBindsInFlight"
  | "mcpSessionUndeliveredMints"
  | "ownerDisconnectRelease"
  | "sessionManager"
  | "mcpSessionAcquiredDeviceSessions"
  | "mcpSessionLivenessOwnerTokens"
  | "ownerConnectionIntervals"
  | "mcpSessionOwnerCallsInFlight"
  | "autolockManager"
>;
export type ConnectionClaimsCallbacks = Pick<
  DevicePoolOperations,
  "beginMcpBind" | "hasConnectedMcpSessionOwner"
>;

/** Connection Claims responsibilities of DevicePool. */
export class DevicePoolConnectionClaims {
  constructor(
    private readonly state: ConnectionClaimsState,
    private readonly callbacks: ConnectionClaimsCallbacks,
  ) {}
  /**
   * Track a bind for `mcpSessionId` until the returned callback runs (#11146). The tool-call entry
   * holds one across a whole explicit-sessionUuid device call (#11348): its attach runs after the
   * handler, so a close during the handler must still be seen by {@link recordBindOwnership}.
   */
  beginMcpBind(mcpSessionId: string | undefined): () => void {
    if (!mcpSessionId) {
      return () => {};
    }
    const bind = this.state.mcpBindsInFlight.get(mcpSessionId) ?? {
      pending: 0,
      closed: false,
      toolCalls: 0,
    };
    bind.pending++;
    this.state.mcpBindsInFlight.set(mcpSessionId, bind);
    let ended = false;
    return () => {
      if (ended) {
        return;
      }
      ended = true;
      bind.pending--;
      if (bind.pending === 0 && this.state.mcpBindsInFlight.get(mcpSessionId) === bind) {
        this.state.mcpBindsInFlight.delete(mcpSessionId);
      }
    };
  }

  /** #11999: retain a connection's close through forwarding and its terminal answer write. */
  beginMcpToolCall(mcpSessionId: string | undefined): (delivered?: boolean) => void {
    const endBind = this.callbacks.beginMcpBind(mcpSessionId);
    const bind =
      mcpSessionId === undefined ? undefined : this.state.mcpBindsInFlight.get(mcpSessionId);
    if (bind) {
      bind.toolCalls++;
    }
    let ended = false;
    return (delivered = true) => {
      if (ended) {
        return;
      }
      ended = true;
      if (bind && mcpSessionId !== undefined) {
        bind.toolCalls--;
        // A delivered answer acknowledges its mints; a closed connection retains none (#11999).
        if (delivered || bind.closed) {
          this.state.mcpSessionUndeliveredMints.delete(mcpSessionId);
        }
      }
      endBind();
    };
  }

  /**
   * Record a bind's caller as the session's owner, unless that connection closed while the bind
   * was in flight (#11146): its bindings were already released, so it would stay a dead owner and
   * suppress the owner-disconnect release (#10503). Then the session is ownerless, so arm that
   * release instead, exactly as the close would have for an owner recorded in time. Returns
   * whether the owner was recorded; autolock acquisition publishes its routes only then (#11166).
   */
  recordBindOwnership(mcpSessionId: string | undefined, sessionId: string): boolean {
    if (!mcpSessionId || !this.state.mcpBindsInFlight.get(mcpSessionId)?.closed) {
      this.recordMcpSessionOwnership(mcpSessionId, sessionId);
      return true;
    }
    logger.info(
      `[DevicePool] MCP connection ${mcpSessionId} closed while binding session ${sessionId}; not recording it as owner`,
    );
    if (!this.callbacks.hasConnectedMcpSessionOwner(sessionId)) {
      this.state.ownerDisconnectRelease.ownerDisconnected(
        this.ownershipSessionId(sessionId),
        mcpSessionId,
      );
    }
    return false;
  }

  /**
   * The session whose owning connection speaks for `sessionId` (#11586). A derived
   * `${base}:${label}` session records no owner of its own and counts as its base (#11542), so
   * every read and write of connection ownership keys on this id: judging or recording a derived
   * session is judging or recording its base. Any other id is its own.
   */
  ownershipSessionId(sessionId: string): string {
    // A label session published under another label session resolves to the outermost base. The
    // lookup judges only: it never releases an expired base.
    return this.state.sessionManager.ownershipSessionUuid(sessionId);
  }

  /** Whether `mcpSessionId` acquired (or restored as its own) the owner of `sessionId`. */
  hasAcquiredDeviceSession(mcpSessionId: string, sessionId: string): boolean {
    const acquired = this.state.mcpSessionAcquiredDeviceSessions.get(mcpSessionId);
    return acquired !== undefined && acquired.has(this.ownershipSessionId(sessionId));
  }

  /** Remember the connection's identity before acquisition, even with no retained sessions. */
  declareMcpSessionLivenessOwnerToken(mcpSessionId: string, token: string): void {
    this.state.mcpSessionLivenessOwnerTokens.set(mcpSessionId, token);
  }

  registerMcpSessionOwnerCallReader(): void {
    this.state.sessionManager.setOwnerConnectedAtReader?.((session, at) => {
      const ownerId = this.ownershipSessionId(session.sessionId);
      const owner =
        ownerId === session.sessionId ? session : this.state.sessionManager.peekSession(ownerId);
      // Autolock-only ownership records no acquisition interval: conservatively not connected.
      return owner !== null && this.state.ownerConnectionIntervals.connectedAt(owner, at);
    });
    this.state.sessionManager.setLivenessOwnerCallInFlightReader?.((token) => {
      for (const calls of this.state.mcpSessionOwnerCallsInFlight.values()) {
        if ((calls.get(token) ?? 0) > 0) {
          return true;
        }
      }
      return false;
    });
  }

  /** Only a still-connected caller presenting the mint's token defends its claim lease. */
  beginMcpSessionOwnerCall(mcpSessionId: string, token: string): () => void {
    const calls =
      this.state.mcpSessionOwnerCallsInFlight.get(mcpSessionId) ?? new Map<string, number>();
    calls.set(token, (calls.get(token) ?? 0) + 1);
    this.state.mcpSessionOwnerCallsInFlight.set(mcpSessionId, calls);
    let ended = false;
    return () => {
      if (ended || this.state.mcpSessionOwnerCallsInFlight.get(mcpSessionId) !== calls) {
        return;
      }
      ended = true;
      const pending = (calls.get(token) ?? 0) - 1;
      if (pending > 0) {
        calls.set(token, pending);
      } else {
        calls.delete(token);
      }
      if (calls.size === 0) {
        this.state.mcpSessionOwnerCallsInFlight.delete(mcpSessionId);
      }
      this.state.sessionManager.restartMintBoundClaimLeases(token);
    };
  }

  /** Record a minted session's owner and its acquisition identity in one synchronous commit. */
  recordMintedSessionOwnership(
    mcpSessionId: string | undefined,
    sessionId: string,
    oneShotCli: boolean,
    clientSuppliedId?: boolean,
  ): boolean {
    const keepsOrdinaryGrace = (): boolean => oneShotCli || clientSuppliedId === true;
    const recorded = this.recordBindOwnership(mcpSessionId, sessionId);
    const token = mcpSessionId && this.state.mcpSessionLivenessOwnerTokens.get(mcpSessionId);
    if (recorded && token) {
      this.state.sessionManager.bindAcquiredLivenessOwnerToken(sessionId, token);
    }
    if (mcpSessionId !== undefined && !keepsOrdinaryGrace()) {
      const ownerSessionId = this.ownershipSessionId(sessionId);
      if (!recorded && !this.callbacks.hasConnectedMcpSessionOwner(ownerSessionId)) {
        this.state.ownerDisconnectRelease.ownerDisconnected(ownerSessionId, mcpSessionId, 0);
      } else if (recorded && this.state.mcpBindsInFlight.get(mcpSessionId)?.toolCalls) {
        const undelivered =
          this.state.mcpSessionUndeliveredMints.get(mcpSessionId) ?? new Set<string>();
        undelivered.add(ownerSessionId);
        this.state.mcpSessionUndeliveredMints.set(mcpSessionId, undelivered);
      }
    }
    return recorded;
  }

  recordMcpSessionOwnership(mcpSessionId: string | undefined, namedSessionId: string): void {
    if (!mcpSessionId) {
      return;
    }
    const sessionId = this.ownershipSessionId(namedSessionId);
    this.state.ownerDisconnectRelease.cancel(sessionId);
    // One owning connection per session (#11107): recording ownership moves it off any other
    // connection, so the previous owner's disconnect can no longer be suppressed by a duplicate.
    for (const [otherMcpSessionId, otherAcquired] of this.state.mcpSessionAcquiredDeviceSessions) {
      if (
        otherMcpSessionId !== mcpSessionId &&
        otherAcquired.delete(sessionId) &&
        otherAcquired.size === 0
      ) {
        this.state.mcpSessionAcquiredDeviceSessions.delete(otherMcpSessionId);
      }
    }
    this.state.autolockManager.releaseMcpSessionOwnershipExcept(sessionId, mcpSessionId);
    const acquired =
      this.state.mcpSessionAcquiredDeviceSessions.get(mcpSessionId) ?? new Set<string>();
    acquired.add(sessionId);
    this.state.mcpSessionAcquiredDeviceSessions.set(mcpSessionId, acquired);
    const session = this.state.sessionManager.peekSession(sessionId);
    if (session) {
      this.state.ownerConnectionIntervals.connected(
        session,
        this.state.sessionManager.sessionNow(),
      );
    }
  }
}

export function connectConnectionClaims(
  part: () => DevicePoolConnectionClaims,
  seams: Pick<
    DevicePoolOperations,
    | "beginMcpBind"
    | "beginMcpToolCall"
    | "declareMcpSessionLivenessOwnerToken"
    | "beginMcpSessionOwnerCall"
  >,
): ConnectionClaimsOperations {
  return {
    beginMcpBind: (...args) => seams.beginMcpBind(...args),
    beginMcpToolCall: (...args) => seams.beginMcpToolCall(...args),
    recordBindOwnership: (...args) => part().recordBindOwnership(...args),
    ownershipSessionId: (...args) => part().ownershipSessionId(...args),
    hasAcquiredDeviceSession: (...args) => part().hasAcquiredDeviceSession(...args),
    declareMcpSessionLivenessOwnerToken: (...args) =>
      seams.declareMcpSessionLivenessOwnerToken(...args),
    registerMcpSessionOwnerCallReader: (...args) =>
      part().registerMcpSessionOwnerCallReader(...args),
    beginMcpSessionOwnerCall: (...args) => seams.beginMcpSessionOwnerCall(...args),
    recordMintedSessionOwnership: (...args) => part().recordMintedSessionOwnership(...args),
    recordMcpSessionOwnership: (...args) => part().recordMcpSessionOwnership(...args),
  };
}
