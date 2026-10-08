/**
 * One policy for how long active executions may veto the automatic release of a session whose
 * owner is gone (#10663, #10712).
 *
 * The #5343 rule — never release a session while one of its calls is in flight — holds while the
 * call can still finish inside its request deadline. An execution that never settles must not
 * hold its abandoned owner's device forever, so the veto is bounded. Both automatic release paths
 * (the heartbeat monitor's stale-session reap and the owner-disconnect release) judge the veto
 * through this module, so they cannot drift apart.
 */

import type { Timer } from "../utils/SystemTimer";
import { MAX_CALLER_MCP_REQUEST_TIMEOUT_MS } from "./mcpRequestTimeout";

/**
 * Longest an execution may veto a release once the veto started. No request's deadline can
 * exceed the caller timeout cap, so an execution still tracked this long has outlived any
 * deadline it could have had, and nobody is left to consume its result.
 */
export const UNSETTLED_EXECUTION_VETO_CEILING_MS = MAX_CALLER_MCP_REQUEST_TIMEOUT_MS;

/** What the veto needs to know about a session's in-flight work. */
export interface SessionExecutionProbe {
  hasActiveExecutions(sessionId: string): boolean;
}

/** Accept the bare predicate older call sites pass, or a full probe. */
export type SessionExecutionProbeInput = SessionExecutionProbe | ((sessionId: string) => boolean);

export function toSessionExecutionProbe(input: SessionExecutionProbeInput): SessionExecutionProbe {
  return typeof input === "function" ? { hasActiveExecutions: input } : input;
}

/** The facts the policy judges, all on one clock. */
export interface UnsettledExecutionVetoInput {
  /** Whether the session still has an execution in flight. */
  hasActiveExecutions: boolean;
  /** When active executions first kept this session from its release. */
  vetoedSince: number;
  now: number;
  ceilingMs?: number;
}

/**
 * When an active-execution veto that started at `vetoedSince` stops holding. Exported so every
 * release path (including session expiry) can adopt the same bound.
 */
export function unsettledExecutionVetoExpiresAt(
  vetoedSince: number,
  ceilingMs: number = UNSETTLED_EXECUTION_VETO_CEILING_MS,
): number {
  return vetoedSince + ceilingMs;
}

/**
 * Whether active executions still keep a session from an automatic release. False once nothing
 * is in flight, and false once the veto has outlived its bound.
 */
export function isReleaseVetoedByExecutions(input: UnsettledExecutionVetoInput): boolean {
  return (
    input.hasActiveExecutions &&
    input.now < unsettledExecutionVetoExpiresAt(input.vetoedSince, input.ceilingMs)
  );
}

export type UnsettledExecutionVetoVerdict =
  /** Nothing is in flight: the release may proceed. */
  | { kind: "clear" }
  /** In-flight work keeps the session until `until`; `firstKept` on the first such verdict. */
  | { kind: "kept"; until: number; firstKept: boolean }
  /** In-flight work outlived its bound after `vetoedMs`: release anyway. */
  | { kind: "expired"; vetoedMs: number; boundMs: number };

/**
 * Stateful form of the policy: remembers when the veto started for each session incarnation
 * (keyed by the session object, so a re-created session starts a fresh window).
 */
export class UnsettledExecutionVeto {
  private readonly vetoedSince = new WeakMap<object, number>();
  private readonly probe: SessionExecutionProbe;

  constructor(
    probe: SessionExecutionProbeInput,
    private readonly timer: Timer,
    private readonly ceilingMs: number = UNSETTLED_EXECUTION_VETO_CEILING_MS,
  ) {
    this.probe = toSessionExecutionProbe(probe);
  }

  judge(session: { readonly sessionId: string }): UnsettledExecutionVetoVerdict {
    if (!this.probe.hasActiveExecutions(session.sessionId)) {
      this.vetoedSince.delete(session);
      return { kind: "clear" };
    }
    const now = this.timer.now();
    const recorded = this.vetoedSince.get(session);
    const vetoedSince = recorded ?? now;
    if (recorded === undefined) {
      this.vetoedSince.set(session, vetoedSince);
    }
    const until = unsettledExecutionVetoExpiresAt(vetoedSince, this.ceilingMs);
    if (
      isReleaseVetoedByExecutions({
        hasActiveExecutions: true,
        vetoedSince,
        now,
        ceilingMs: this.ceilingMs,
      })
    ) {
      return { kind: "kept", until, firstKept: recorded === undefined };
    }
    return { kind: "expired", vetoedMs: now - vetoedSince, boundMs: until - vetoedSince };
  }

  /** The session is no longer a release candidate: a later veto starts a fresh window. */
  forget(session: { readonly sessionId: string }): void {
    this.vetoedSince.delete(session);
  }
}
