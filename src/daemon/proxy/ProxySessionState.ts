import type { LivenessHandover, OwnerConflictLeash } from "../proxyLivenessRecovery";
import type { SessionReleaseSnapshot } from "../sessionManager";

/** A `daemon_stalled` / `proxy_stalled` handover recorded for one session (#10053). */
export interface StallHandoverRecord {
  handover: LivenessHandover;
  delivered: boolean;
  /**
   * The daemon process the stall probe resumes the session on; undefined once that daemon was
   * found replaced, or when its identity was never reported (#10989).
   */
  probeDaemonInstance?: string;
  /** First instance-change answer; marks a handed-over session reclaiming without a daemon pin. */
  managedReclaimSince?: number;
  /**
   * First awaitable not-found from an answering daemon process; silence never resets it.
   * Only an answer naming a different defined daemon instance opens a fresh window.
   */
  managedNotFoundWindow?: { since: number; daemonInstance: string | undefined };
  /**
   * The daemon process that last acknowledged a heartbeat before the handover, kept even after
   * probing stops, so a resume acknowledged by another process is reported as a restart (#11018).
   */
  stalledDaemonInstance?: string;
  /** How the session was held when it was handed over, so a resume restores it as it was. */
  restore: {
    /** It was the latest binding. */
    bound: boolean;
    /** Replay-lease start (latest binding) or last use (held session). */
    lastUsedAt: number;
    /** The latest binding came from `--initial-session-uuid`. */
    initialBinding: boolean;
  };
}

export interface OtherHeldSession {
  claimSent: boolean;
  /**
   * Proxy-clock time a tool call last bound this session (#10657). A held session nothing
   * has named for the session idle window (`boundSessionReplayTtlMs`) is abandoned and
   * evicted, so a conversation that moved to another device stops pinning the old one.
   */
  lastUsedAt: number;
  /** The daemon's refusals of this session's claim as a live-owner conflict (#10050, #10701). */
  conflict?: OwnerConflictLeash;
}

export interface TerminalBoundSession {
  sessionUuid: string;
  reason: string;
  fromResultMint: boolean;
  release?: SessionReleaseSnapshot;
  /** First reported managed stall loss; lives and clears with this terminal binding. */
  reportedStallLossReason?: string;
}

export class ProxySessionState {
  /**
   * Each session's latest not-found window (when it opened, by the injected timer) and the
   * handoffs it has had a window for ({@link decideNotFoundAnswer}). An entry outlives its window,
   * so no later answer of the same handoff opens another.
   * Cleared by a heartbeat acknowledgement, by a call the daemon admitted under the session, or by
   * the session ending here; a call that proves nothing about the session leaves it (#11570).
   */
  readonly notFoundWindows = new Map<string, { since: number; handoffs: Set<string> }>();
  /**
   * Sessions the proxy stopped heartbeating on a not-found answer that did not end them (#10702):
   * the latest binding stays bound, a held session is dropped. A tool call that reaches the
   * session re-arms its heartbeat, and the daemon may still hand it back (#11400).
   */
  readonly notFoundStopped = new Set<string>();
  /**
   * Device sessions this proxy still holds besides its latest binding, each with
   * whether its ownership claim has been delivered (#9335). `boundSessionUuid`
   * only tracks the LATEST binding, so acquiring or naming a second session moves
   * it off the first, which still depends on this proxy for liveness. Every entry
   * is heartbeated on the keeper's cadence under the same owner token; an entry
   * leaves on release, fencing, confirmed loss and close.
   */
  readonly otherHeldSessions = new Map<string, OtherHeldSession>();
  /**
   * Handovers per affected session. A tool call that names the session first attempts an
   * observation-only resume and returns the structured error only when the daemon still does not
   * answer; one that reaches it implicitly returns the error. The stall probe, an acknowledged
   * resume or a definitive daemon answer ends the handover (#10989).
   */
  readonly stallHandovers = new Map<string, StallHandoverRecord>();
  // The daemon clears socket-local state when its RPC connection drops. Keep this
  // proxy's successful explicit binding so subsequent sessionless calls can seed
  // a replacement socket without sharing the binding with other proxies.
  boundSessionUuid: string | undefined = undefined;
  // When the binding above was last set/refreshed, on the injected clock. Once
  // the daemon's session idle window elapses with no forwarded call (explicit or
  // injected sessionUuid) refreshing it, the remembered UUID is treated as
  // retired so a sessionless call is not rewritten to a released session (issue
  // #4610). Heartbeat acks never refresh it: they prove liveness, not use (#10656).
  boundSessionUuidAt: number | undefined = undefined;
  /**
   * Sessions this proxy may claim liveness ownership of and heartbeat (#10664): ones it minted
   * from an acquisition RESULT, plus the startup `initialSessionUuid`. A session only NAMED in a
   * tool call's `sessionUuid` arg is forwarded and bound for routing, but never claimed or
   * heartbeated, so a proxy cannot inherit a session another proxy (or a CLI keeper) owns once
   * that owner's lease lapses. The other owner keeps it alive or the daemon reaps it.
   */
  readonly claimableSessions = new Set<string>();
  // Once the daemon confirms this transport's bound session is gone, preserve
  // that terminal identity instead of clearing it and allowing the same UUID to
  // acquire another device. `fromResultMint` records the binding's provenance at
  // fence time (see boundSessionFromResultMint).
  terminalBoundSession: TerminalBoundSession | undefined = undefined;

  /**
   * Whether this binding has sent its one ownership-claim heartbeat. Marked
   * before awaiting the request, because the daemon may apply it even when the
   * response is lost; reconnects must then verify the same token, not reclaim.
   */
  livenessOwnershipClaimSent = false;

  // Whether the current binding was minted by a device-acquisition RESULT
  // (getAndroid/getApple/startDevice), i.e. never named by the client, versus
  // client-declared (an explicit `sessionUuid` arg, or a startup
  // `initialSessionUuid`). Governs how a fenced sessionless call is reported: a
  // client-declared binding keeps the ownership-lost-for-UUID error, while a
  // result-minted one reports the connection state instead of a stale UUID the
  // caller never referenced (issue #5689).
  boundSessionFromResultMint = false;

  // Startup bindings remain authoritative until the daemon signals release.
  // Replay expiration only protects bindings inferred from ordinary calls.
  initialSessionBindingConfigured = false;
}
