import type { Session } from "./sessionManager";
import { judgedLeaseHeartbeat, ownerLeaseLiveAt } from "./livenessOwnerLease";
import { forgivenLeaseStart } from "./stallForgiveness";
import { MAX_CREDIBLE_DAEMON_STALL_MS } from "./timerLateness";

interface ConnectedInterval {
  since: number;
  closedAt?: number;
}
interface ConnectionHistory {
  current?: ConnectedInterval;
  lastClosed?: ConnectedInterval;
}

/** Session-clock socket intervals, keyed by incarnation so reused ids inherit nothing (#11992). */
export class OwnerConnectionIntervals {
  private readonly histories = new WeakMap<Session, ConnectionHistory>();

  /** Moving ownership between connected sockets keeps the current interval continuous. */
  connected(session: Session, since: number): void {
    const history = this.histories.get(session) ?? {};
    history.current ??= { since };
    this.histories.set(session, history);
  }

  disconnected(session: Session, closedAt: number): void {
    const history = this.histories.get(session);
    if (history?.current) {
      history.lastClosed = { ...history.current, closedAt };
      history.current = undefined;
    }
  }

  connectedAt(session: Session, at: number): boolean {
    const history = this.histories.get(session);
    return [history?.current, history?.lastClosed].some(
      (interval) =>
        interval !== undefined &&
        interval.since <= at &&
        (interval.closedAt === undefined || interval.closedAt > at),
    );
  }
}

const budgets = new WeakMap<Session, { heartbeat: number; creditedMs: number }>();
export type OwnerConnectedAtReader = (session: Session, at: number) => boolean;

/**
 * Extra awake-stall credit for a connected owner whose raw lease already expired (#11992).
 * Across all late ticks with the same raw owner heartbeat, total credit is at most
 * MAX_CREDIBLE_DAEMON_STALL_MS. Socket openness alone therefore cannot prevent release after
 * heartbeatTimeoutMs + SUSPECT_GRACE_MS + that cap, plus one scan. An on-time host retains
 * its lease + grace + one scan bound (10 s at defaults). No budget is persisted.
 */
function connectedOwnerCredit(
  session: Session,
  lostMs: number,
  gapBeganAt: number | undefined,
  reader: OwnerConnectedAtReader | undefined,
): number {
  if (
    lostMs <= 0 ||
    gapBeganAt === undefined ||
    session.ownership !== "owned" ||
    !(reader?.(session, gapBeganAt) ?? false)
  ) {
    return 0;
  }
  const heartbeat = session.lastOwnerHeartbeat ?? session.lastHeartbeat;
  const previous = budgets.get(session);
  const creditedMs = previous?.heartbeat === heartbeat ? previous.creditedMs : 0;
  const credit = Math.min(lostMs, MAX_CREDIBLE_DAEMON_STALL_MS - creditedMs);
  budgets.set(session, { heartbeat, creditedMs: creditedMs + credit });
  return credit;
}

/** The existing full lease rule takes precedence and never spends connected-owner credit. */
export function daemonStallLeaseExtension(
  session: Session,
  resumedAt: number,
  gap: { lostMs: number; sleptMs: number; gapBeganAt?: number },
  reader: OwnerConnectedAtReader | undefined,
): {
  leaseStart?: number;
  leaseExtended: number;
  connectedExtended: number;
  connectedCreditMs: number;
} {
  const full = ownerLeaseLiveAt(session, gap.gapBeganAt);
  const connectedCreditMs = full
    ? 0
    : connectedOwnerCredit(session, gap.lostMs, gap.gapBeganAt, reader);
  const credit = full ? gap.lostMs + gap.sleptMs : connectedCreditMs;
  const before = judgedLeaseHeartbeat(session);
  const leaseStart = full || credit > 0 ? forgivenLeaseStart(before, resumedAt, credit) : undefined;
  const extended = Number(leaseStart !== undefined && leaseStart > before);
  return {
    leaseStart,
    leaseExtended: full ? extended : 0,
    connectedExtended: full ? 0 : extended,
    connectedCreditMs,
  };
}
