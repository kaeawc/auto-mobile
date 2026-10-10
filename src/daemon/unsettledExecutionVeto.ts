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
 * Fallback bound on an execution's veto, from when the veto started, used when some vetoing
 * execution carries no request deadline. No request's deadline can exceed the caller timeout cap,
 * so an execution still tracked this long has outlived any deadline it could have had.
 */
export const UNSETTLED_EXECUTION_VETO_CEILING_MS = MAX_CALLER_MCP_REQUEST_TIMEOUT_MS;

/**
 * How long past its request's deadline an execution may still veto a release: the time a call
 * aborted at its deadline needs to unwind and end its execution. Past it the call's result has
 * no consumer.
 */
export const UNSETTLED_EXECUTION_DEADLINE_GRACE_MS = 10_000;

/** What the veto needs to know about a session's in-flight work. */
export interface SessionExecutionProbe {
  hasActiveExecutions(sessionId: string): boolean;
  /**
   * The latest request deadline among the session's in-flight executions, on the veto's clock
   * (the daemon's session clock, #11162).
   * `Number.POSITIVE_INFINITY` (or no method) when any of them carries no deadline, and
   * undefined when nothing is in flight.
   */
  latestExecutionDeadlineMs?(sessionId: string): number | undefined;
}

/** Accept the bare predicate older call sites pass, or a full probe. */
export type SessionExecutionProbeInput = SessionExecutionProbe | ((sessionId: string) => boolean);

export function toSessionExecutionProbe(input: SessionExecutionProbeInput): SessionExecutionProbe {
  return typeof input === "function" ? { hasActiveExecutions: input } : input;
}

/** When a veto stops holding: the facts the bound is derived from, all on one clock. */
export interface UnsettledExecutionVetoBoundInput {
  /** When active executions first kept this session from its release. */
  vetoedSince: number;
  /** See {@link SessionExecutionProbe.latestExecutionDeadlineMs}. */
  latestDeadlineMs?: number;
  ceilingMs?: number;
  deadlineGraceMs?: number;
}

/** The facts the policy judges, all on one clock. */
export interface UnsettledExecutionVetoInput extends UnsettledExecutionVetoBoundInput {
  /** Whether the session still has an execution in flight. */
  hasActiveExecutions: boolean;
  now: number;
}

/**
 * When an active-execution veto stops holding: the vetoing executions' own request deadline plus
 * {@link UNSETTLED_EXECUTION_DEADLINE_GRACE_MS} when every one of them has a deadline, otherwise
 * {@link UNSETTLED_EXECUTION_VETO_CEILING_MS} after the veto started. Exported so every release
 * path (including session expiry) can adopt the same bound.
 */
export function unsettledExecutionVetoExpiresAt(input: UnsettledExecutionVetoBoundInput): number {
  const { latestDeadlineMs } = input;
  if (hasDeadline(latestDeadlineMs)) {
    return latestDeadlineMs + (input.deadlineGraceMs ?? UNSETTLED_EXECUTION_DEADLINE_GRACE_MS);
  }
  return input.vetoedSince + (input.ceilingMs ?? UNSETTLED_EXECUTION_VETO_CEILING_MS);
}

/**
 * Whether active executions still keep a session from an automatic release. False once nothing
 * is in flight, and false once the veto has outlived its bound.
 */
export function isReleaseVetoedByExecutions(input: UnsettledExecutionVetoInput): boolean {
  return input.hasActiveExecutions && input.now < unsettledExecutionVetoExpiresAt(input);
}

export type UnsettledExecutionVetoVerdict =
  /** Nothing is in flight: the release may proceed. */
  | { kind: "clear" }
  /** In-flight work keeps the session until `until`; `firstKept` on the first such verdict. */
  | { kind: "kept"; until: number; firstKept: boolean }
  /**
   * In-flight work outlived its bound (the request deadline plus grace, or the fallback ceiling)
   * after vetoing for `vetoedMs`: release anyway.
   */
  | { kind: "expired"; vetoedMs: number; bound: UnsettledExecutionVetoBound };

/** Which bound ended a veto. */
export type UnsettledExecutionVetoBound = "request-deadline" | "ceiling";

function hasDeadline(latestDeadlineMs: number | undefined): latestDeadlineMs is number {
  return latestDeadlineMs !== undefined && Number.isFinite(latestDeadlineMs);
}

/**
 * Stateful form of the policy: remembers when the veto started for each session incarnation
 * (keyed by the session object, so a re-created session starts a fresh window).
 *
 * The veto's clock is `now`: the daemon passes its session clock (#11162), so a wall-clock step
 * neither ends a call's veto early nor stretches it, and the probe's deadlines must be on that same
 * clock. Absent, the timer's wall clock.
 */
export class UnsettledExecutionVeto {
  private readonly vetoedSince = new WeakMap<object, number>();
  private readonly probe: SessionExecutionProbe;
  private readonly now: () => number;

  constructor(
    probe: SessionExecutionProbeInput,
    timer: Timer,
    private readonly ceilingMs: number = UNSETTLED_EXECUTION_VETO_CEILING_MS,
    now?: () => number,
  ) {
    this.probe = toSessionExecutionProbe(probe);
    this.now = now ?? (() => timer.now());
  }

  judge(session: { readonly sessionId: string }): UnsettledExecutionVetoVerdict {
    if (!this.probe.hasActiveExecutions(session.sessionId)) {
      this.vetoedSince.delete(session);
      return { kind: "clear" };
    }
    const now = this.now();
    const recorded = this.vetoedSince.get(session);
    const vetoedSince = recorded ?? now;
    if (recorded === undefined) {
      this.vetoedSince.set(session, vetoedSince);
    }
    const latestDeadlineMs = this.probe.latestExecutionDeadlineMs?.(session.sessionId);
    const until = unsettledExecutionVetoExpiresAt({
      vetoedSince,
      latestDeadlineMs,
      ceilingMs: this.ceilingMs,
    });
    if (now < until) {
      return { kind: "kept", until, firstKept: recorded === undefined };
    }
    return {
      kind: "expired",
      vetoedMs: now - vetoedSince,
      bound: hasDeadline(latestDeadlineMs) ? "request-deadline" : "ceiling",
    };
  }

  /** The session is no longer a release candidate: a later veto starts a fresh window. */
  forget(session: { readonly sessionId: string }): void {
    this.vetoedSince.delete(session);
  }
}
