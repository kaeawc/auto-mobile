/**
 * Re-owning live managed executions after a daemon restart (#11275).
 *
 * A binding's execution owner is the daemon process holding the execution's session: the session (its
 * owner lease, heartbeat and idle judgement) lives in that daemon, and so do the reservations the
 * reconciler claims before a session exists. The proxy's process is not recorded: the daemon never
 * learns a trusted proxy PID, and a proxy without its daemon session cannot use the binding anyway.
 *
 * A managed-execution session survives a daemon restart (it is rehydrated and its proxy re-binds),
 * but the binding still names the previous daemon's PID, which is now dead. Left alone, the binding looks
 * ownerless: a duplicate acquisition takes it over and the abandonment sweep can fence it. So once
 * this daemon holds such a session again (rehydration, or the proxy's `daemon/registerSession`
 * re-bind) it re-stamps the binding's owner with itself, claiming the binding for the same session UUID.
 * Rehydrated work stays gated until that host-visible ownership is confirmed (#12053).
 */

import type { BackoffPolicy } from "../../../utils/Backoff";
import type { ActionableError } from "../../../models/ActionableError";
import { BindingOwnershipLostError, BindingOwnershipUnconfirmedError } from "./refusal";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import type { ReleaseDeviceHold } from "../../sessionManager";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS } from "./executionRelease";
import {
  RegistryRetryPacing,
  REGISTRY_RETRY_INITIAL_DELAY_MS,
  REGISTRY_RETRY_MAX_DELAY_MS,
  REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS,
  REGISTRY_BUSY_WRITE_MS,
} from "../registry/registryRetryPacing";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import {
  journalOwnersEqual,
  type ClaimExecutionResult,
  type BindingAssignmentRecord,
  type BindingProcessIdentity,
  type BindingRegistry,
} from "../registry/bindingRegistry";

export type ManagedExecutionReownRegistry = Pick<
  BindingRegistry,
  "findExecutionAssignments" | "claimExecution"
>;

export interface ManagedExecutionReownerDependencies {
  registry: () => Promise<ManagedExecutionReownRegistry>;
  /**
   * Whether the host registry exists. A host that never served a broker binding has none, and
   * re-owning must not create it. Defaults to always existing.
   */
  registryExists?: () => boolean;
  /** This daemon, as recorded for a binding's execution owner. */
  owner: () => BindingProcessIdentity;
  timer?: Timer;
  retryBackoff?: BackoffPolicy;
  /** Live admission for re-owns; an active release hold also permits its recovery attempt. */
  isSessionHeld?: (sessionUuid: string) => boolean;
  /** Object retention, independent of expiry/fences/releases. Absent: use isSessionHeld. */
  isSessionPresent?: (sessionUuid: string) => boolean;
  onOwnershipConfirmed?: (sessionUuid: string) => void;
  onOwnershipLost?: (sessionUuid: string) => void;
  /** Captured before release hides the session, for an unknown-ownership state-drop diagnostic. */
  deviceOf?: (sessionUuid: string) => string | null;
}

/** Worst case of one shared registry turn: the 700 ms attempt bound plus one blocked registry write. */
const REGISTRY_TURN_WORST_CASE_MS =
  MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS + REGISTRY_BUSY_WRITE_MS;
// Measured on the daemon's timer; covers one turn in flight when the hold is created
// plus the hold's own expedited attempt. More than one eligible attempt queued ahead
// is still not guaranteed to fit. A synchronous write crossing the cap delays it by
// at most that write, and the cap-derived cleanup hint is short by that delay.
export const MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS =
  REGISTRY_TURN_WORST_CASE_MS /* the turn in flight when the hold is created */ +
  REGISTRY_TURN_WORST_CASE_MS; /* the hold's own expedited attempt */
export const MANAGED_EXECUTION_REOWN_RETRY_INITIAL_DELAY_MS = REGISTRY_RETRY_INITIAL_DELAY_MS;
export const MANAGED_EXECUTION_REOWN_RETRY_MAX_DELAY_MS = REGISTRY_RETRY_MAX_DELAY_MS;
export const MANAGED_EXECUTION_REOWN_RETRY_MAX_BLOCKED_WAIT_MS = REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS;
export const MANAGED_EXECUTION_REOWN_WARN_AFTER_MS = 5_000;
/** One minute from the first attempt tolerates slow recovery hosts and shared registry queues. */
export const MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS = 60_000;
/** Elapsed time alone cannot fence a session starved of shared registry turns. */
export const MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS = 3;
type HoldOutcome = "teardown" | "skip-device-writes";
interface ReleaseHold {
  settled: Promise<HoldOutcome>;
  resolve: (outcome: HoldOutcome) => void;
  timeout: NodeJS.Timeout;
  device: string;
}

type OwnershipState = "unconfirmed" | "lost";
type ReownAttempt = {
  assignments: BindingAssignmentRecord[];
  outcome: "confirmed" | "retry" | "lost";
  error?: Error;
};

export class ManagedExecutionReowner {
  private readonly recovering = new Map<string, Promise<unknown>>();
  /** Deduplicates the startup/late batch against each creation's own trigger, until release. */
  private readonly recoveredSessions = new Set<string>();
  private readonly ownership = new Map<string, OwnershipState>();
  private readonly attempts = new Map<string, Promise<ReownAttempt>>();
  /** A deadline abandons the waiter, never the operation or its late result. */
  private readonly registryOpens = new Map<string, Promise<ManagedExecutionReownRegistry>>();
  private readonly ownerReads = new Map<string, Promise<BindingAssignmentRecord[]>>();
  private readonly ownerClaims = new Map<string, Promise<ClaimExecutionResult>>();
  private readonly background = new Map<string, Promise<void>>();
  /** Only a retry waiting for backoff/quiet/a turn can consume a hold's one expedite. */
  private readonly retryExpedites = new Map<string, AbortController>();
  private readonly closing = new AbortController();
  private readonly releaseHolds = new Map<string, ReleaseHold>();
  private readonly episodes = new Map<
    string,
    {
      attempts: number;
      inFlight: boolean;
      warned: boolean;
      sinceMs: number;
      stop: AbortController;
      deadline?: NodeJS.Timeout;
    }
  >();
  private readonly pacing: RegistryRetryPacing;
  private closed = false;

  constructor(private readonly deps: ManagedExecutionReownerDependencies) {
    this.pacing = new RegistryRetryPacing({
      timer: deps.timer ?? defaultTimer,
      initialDelayMs: MANAGED_EXECUTION_REOWN_RETRY_INITIAL_DELAY_MS,
      maxDelayMs: MANAGED_EXECUTION_REOWN_RETRY_MAX_DELAY_MS,
      maxBlockedWaitMs: MANAGED_EXECUTION_REOWN_RETRY_MAX_BLOCKED_WAIT_MS,
      backoff: deps.retryBackoff,
    });
  }

  /**
   * Mark rehydrated sessions synchronously, then attempt each session once inline. Failures never
   * escape or stop the batch; only marked sessions retry in the background, with their gate closed.
   */
  async reown(
    sessionUuids: readonly string[],
    options?: { rehydrated?: boolean },
  ): Promise<BindingAssignmentRecord[]> {
    if (this.closed || sessionUuids.length === 0 || this.deps.registryExists?.() === false) {
      return [];
    }
    this.pruneReleasedSessions();
    if (options?.rehydrated) {
      this.markUnconfirmed(sessionUuids.filter((id) => !this.recoveredSessions.has(id)));
    }
    const assignments: BindingAssignmentRecord[] = [];
    for (const id of sessionUuids) {
      assignments.push(...(await this.reownInline(id)));
    }
    return assignments;
  }

  /** Close admission before a recovered session becomes visible, without starting registry work yet. */
  noteRecovering(sessionUuid: string, recovered: Promise<unknown>): void {
    if (this.closed || this.deps.registryExists?.() === false || this.recovering.has(sessionUuid)) {
      return;
    }
    this.isPresent(sessionUuid);
    this.resetEpisode(sessionUuid);
    this.recovering.set(sessionUuid, recovered);
    this.recoveredSessions.add(sessionUuid);
    this.ownership.set(sessionUuid, "unconfirmed");
    this.episode(sessionUuid);
    void recovered.then(
      () => {
        this.recovering.delete(sessionUuid);
        if (this.isHeld(sessionUuid)) {
          void this.reown([sessionUuid], { rehydrated: true });
        }
      },
      (error: unknown) => {
        // Failed recovery leaves no usable session; the recovery path reports the failure.
        if (!this.closed) {
          logger.debug(`[Bindings] Recovery of ${sessionUuid} failed before re-owning`, error);
        }
        this.recovering.delete(sessionUuid);
        this.isPresent(sessionUuid);
      },
    );
  }

  ownershipState(sessionUuid: string): OwnershipState | undefined {
    return this.isPresent(sessionUuid) ? this.ownership.get(sessionUuid) : undefined;
  }

  /** A hold permits recovery until proof or its cap; live sessions retry until the episode bound. */
  releaseDeviceHold(sessionUuid: string): ReleaseDeviceHold | undefined {
    // The manager has validated this release's identity. A reap may already hide its live lease.
    if (this.deps.isSessionPresent && !this.isPresent(sessionUuid)) {
      return undefined;
    }
    const state = this.ownership.get(sessionUuid);
    if (state === "lost") {
      return { skipDeviceWrites: true };
    }
    if (state !== "unconfirmed") {
      return undefined;
    }
    if (this.closed) {
      this.warnDroppedState(sessionUuid, this.deps.deviceOf?.(sessionUuid) ?? "unknown device");
      return { skipDeviceWrites: true };
    }
    let hold = this.releaseHolds.get(sessionUuid);
    if (!hold) {
      const settled = Promise.withResolvers<HoldOutcome>();
      const timer = this.deps.timer ?? defaultTimer;
      hold = {
        settled: settled.promise,
        resolve: settled.resolve,
        device: this.deps.deviceOf?.(sessionUuid) ?? "unknown device",
        timeout: timer.setTimeout(
          () => this.resolveUnknownHold(sessionUuid),
          MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS,
        ),
      };
      this.releaseHolds.set(sessionUuid, hold);
      this.expediteRetry(sessionUuid);
    }
    return { settled: hold.settled, capMs: MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS };
  }

  private expediteRetry(id: string): void {
    if (this.canAttempt(id)) {
      this.retryExpedites.get(id)?.abort();
    }
  }

  isReleaseHeld(sessionUuid: string): boolean {
    return this.releaseHolds.has(sessionUuid);
  }

  /** A drain confirms only a stamp or a settling record that still names this session. */
  confirmOwnership(sessionUuid: string): void {
    this.settleOwnership(sessionUuid, "confirmed");
  }

  /** A peer's live execution proves loss only for a currently unconfirmed session. */
  loseOwnership(sessionUuid: string): void {
    this.settleOwnership(sessionUuid, "lost");
  }

  private resolveHold(id: string, outcome: HoldOutcome): void {
    const hold = this.releaseHolds.get(id);
    if (!hold) {
      return;
    }
    (this.deps.timer ?? defaultTimer).clearTimeout(hold.timeout);
    this.releaseHolds.delete(id);
    hold.resolve(outcome);
  }

  private resolveUnknownHold(id: string): void {
    const hold = this.releaseHolds.get(id);
    if (!hold) {
      return;
    }
    this.warnDroppedState(id, hold.device);
    this.resolveHold(id, "skip-device-writes");
  }

  private warnDroppedState(id: string, device: string): void {
    logger.warn(
      `[Bindings] Session ${id} on device ${device}: saved device state was dropped because ownership could not be confirmed.`,
    );
  }

  private episode(id: string) {
    let episode = this.episodes.get(id);
    if (!episode) {
      episode = {
        attempts: 0,
        inFlight: false,
        warned: false,
        sinceMs: (this.deps.timer ?? defaultTimer).now(),
        stop: new AbortController(),
      };
      this.episodes.set(id, episode);
    }
    return episode;
  }

  private startDeadline(id: string): void {
    const episode = this.episode(id);
    if (episode.deadline !== undefined) {
      return;
    }
    const timer = this.deps.timer ?? defaultTimer;
    episode.deadline = timer.setTimeout(
      () => {
        // Let an in-flight result prove ownership, even if it completes past the bound.
        this.canAttempt(id);
      },
      Math.max(0, MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS - (timer.now() - episode.sinceMs)),
    );
  }

  private clearDeadline(id: string): void {
    const episode = this.episodes.get(id);
    if (episode?.deadline !== undefined) {
      (this.deps.timer ?? defaultTimer).clearTimeout(episode.deadline);
      episode.deadline = undefined;
    }
  }

  private resetEpisode(id: string): void {
    this.clearDeadline(id);
    this.episodes.get(id)?.stop.abort();
    this.episodes.delete(id);
  }

  private logUnconfirmed(id: string, message: string, error?: unknown): void {
    if (this.closed) {
      return;
    }
    const episode = this.episode(id);
    // Busy writes and unready bindings are expected while the retained session recovers.
    logger.debug(message, error);
    const ageMs = (this.deps.timer ?? defaultTimer).now() - episode.sinceMs;
    if (
      this.ownership.get(id) === "unconfirmed" &&
      !episode.warned &&
      ageMs > MANAGED_EXECUTION_REOWN_WARN_AFTER_MS
    ) {
      episode.warned = true;
      logger.warn(
        `[Bindings] Session ${id} ownership unconfirmed for ${ageMs} ms (${episode.attempts} attempts): ${errorMessage(error)}; retries continue`,
        error,
      );
    }
  }

  private markUnconfirmed(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.isPresent(id) && !this.ownership.has(id)) {
        this.ownership.set(id, "unconfirmed");
        if (this.episode(id).attempts > 0) {
          this.startDeadline(id);
        }
      }
    }
  }

  private async reownInline(id: string): Promise<BindingAssignmentRecord[]> {
    if (!this.canAttempt(id) || this.ownership.get(id) === "lost") {
      return [];
    }
    const episode = this.episode(id);
    try {
      const attempt = await this.attempt(id);
      if (!this.acceptResult(id, attempt.outcome, episode.stop.signal)) {
        return [];
      }
      this.settleOwnership(id, attempt.outcome);
      if (attempt.outcome === "retry") {
        this.logRetry(id, attempt.error);
        this.retryInBackground(id);
      }
      return attempt.assignments;
    } catch (error) {
      if (!this.canAttempt(id, episode.stop.signal)) {
        // A closed or resolved episode cannot act on a late registry result.
        if (!this.closed) {
          logger.debug(
            `[Bindings] Re-owning managed execution ${id} failed after resolution`,
            error,
          );
        }
        return [];
      }
      this.logUnconfirmed(
        id,
        `[Bindings] Re-owning managed execution ${id} failed: ${errorMessage(error)}`,
        error,
      );
      this.retryInBackground(id);
      return [];
    }
  }

  private isAdmitted(id: string, stopped?: AbortSignal): boolean {
    return !this.closed && !stopped?.aborted && !this.recovering.has(id) && this.isHeld(id);
  }

  private acceptResult(
    id: string,
    outcome: ReownAttempt["outcome"],
    stopped: AbortSignal,
  ): boolean {
    return outcome === "confirmed" ? this.isAdmitted(id, stopped) : this.canAttempt(id, stopped);
  }

  private canAttempt(id: string, stopped?: AbortSignal): boolean {
    if (!this.isAdmitted(id, stopped)) {
      return false;
    }
    const episode = this.episodes.get(id);
    // Check between attempts/results too: synchronous registry work can outrun its timer.
    if (
      this.ownership.get(id) === "unconfirmed" &&
      episode &&
      !episode.inFlight &&
      episode.attempts >= MANAGED_EXECUTION_REOWN_MIN_ATTEMPTS &&
      (this.deps.timer ?? defaultTimer).now() - episode.sinceMs >=
        MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS
    ) {
      this.settleOwnership(id, "lost");
      return false;
    }
    return true;
  }

  /** Synchronous O(1) automation admission for sessions marked by rehydration or foreign-owner evidence. */
  automationRefusal(sessionUuid: string): ActionableError | undefined {
    switch (this.ownershipState(sessionUuid)) {
      case "unconfirmed": {
        const episode = this.episode(sessionUuid);
        return new BindingOwnershipUnconfirmedError(
          sessionUuid,
          episode.attempts === 0 ? 0 : (this.deps.timer ?? defaultTimer).now() - episode.sinceMs,
        );
      }
      case "lost":
        return new BindingOwnershipLostError(sessionUuid);
      default:
        return undefined;
    }
  }

  /** Stop registry work and abort waits, retaining the gate while this process still holds it. */
  close(): void {
    this.closed = true;
    for (const id of this.releaseHolds.keys()) {
      this.resolveUnknownHold(id);
    }
    for (const [id, episode] of this.episodes) {
      this.clearDeadline(id);
      episode.stop.abort();
    }
    this.closing.abort();
    this.pacing.close();
    this.registryOpens.clear();
    this.ownerReads.clear();
    this.ownerClaims.clear();
  }

  async whenIdle(): Promise<void> {
    this.pruneReleasedSessions();
    while (this.background.size > 0 || this.attempts.size > 0 || this.releaseHolds.size > 0) {
      await Promise.allSettled([
        ...this.background.values(),
        ...this.attempts.values(),
        ...Array.from(this.releaseHolds.values(), (hold) => hold.settled),
      ]);
    }
  }

  /** Retained/releasing objects alone cannot keep registry retries alive. */
  private isHeld(id: string): boolean {
    const held =
      this.isPresent(id) && (this.releaseHolds.has(id) || this.deps.isSessionHeld?.(id) !== false);
    // Managed liveness ends only on release, expiry or policy departure; that incarnation
    // cannot become live again. A release hold explicitly admits its final recovery attempt.
    if (!held) {
      this.clearDeadline(id);
    }
    return held;
  }

  /** Prune only absent objects, never an expired, fenced or releasing session. */
  private isPresent(id: string): boolean {
    if (this.releaseHolds.has(id) || this.recovering.has(id)) {
      return true;
    }
    const present = this.deps.isSessionPresent ?? this.deps.isSessionHeld;
    if (present?.(id) !== false) {
      return true;
    }
    this.ownership.delete(id);
    this.recoveredSessions.delete(id);
    this.clearDeadline(id);
    this.episodes.get(id)?.stop.abort();
    this.episodes.delete(id);
    this.forgetRegistrySteps(id);
    return false;
  }

  private forgetRegistrySteps(id: string): void {
    this.registryOpens.delete(id);
    this.ownerReads.delete(id);
    this.ownerClaims.delete(id);
  }

  private pruneReleasedSessions(): void {
    for (const id of new Set([
      ...this.ownership.keys(),
      ...this.recoveredSessions,
      ...this.episodes.keys(),
    ])) {
      this.isPresent(id);
    }
  }

  private settleOwnership(id: string, outcome: ReownAttempt["outcome"]): void {
    if (this.closed || !this.isPresent(id)) {
      return;
    }
    const episode = this.episode(id);
    if (outcome !== "retry") {
      this.resetEpisode(id);
    }
    if (this.ownership.get(id) !== "unconfirmed") {
      return;
    }
    if (outcome === "confirmed") {
      this.forgetRegistrySteps(id);
      this.ownership.delete(id);
      logger.info(
        `[Bindings] Session ${id} ownership confirmed after ${(this.deps.timer ?? defaultTimer).now() - episode.sinceMs} ms (${episode.attempts} attempts); re-owned by daemon ${this.deps.owner().daemonId}.`,
      );
      this.resolveHold(id, "teardown");
      this.notifyOwnership(id, "confirmed");
    }
    if (outcome === "lost") {
      this.forgetRegistrySteps(id);
      this.ownership.set(id, "lost");
      logger.warn(
        `[Bindings] Session '${id}' no longer owns its broker binding; acquire a new session.`,
      );
      this.resolveHold(id, "skip-device-writes");
      this.notifyOwnership(id, "lost");
    }
  }

  private notifyOwnership(id: string, outcome: "confirmed" | "lost"): void {
    const hook =
      outcome === "confirmed" ? this.deps.onOwnershipConfirmed : this.deps.onOwnershipLost;
    try {
      hook?.(id);
    } catch (error) {
      logger.warn(`[Bindings] Ownership-${outcome} hook failed for ${id}`, error);
    }
  }

  private needsRetry(id: string): boolean {
    return this.canAttempt(id) && this.ownership.get(id) === "unconfirmed";
  }

  private logRetry(
    id: string,
    failure: unknown = new Error("binding ownership unconfirmed"),
  ): void {
    this.logUnconfirmed(
      id,
      `[Bindings] Re-owning managed execution ${id} failed; retrying: ${errorMessage(failure)}`,
      failure,
    );
  }

  private retryInBackground(id: string): void {
    if (!this.needsRetry(id) || this.background.has(id)) {
      return;
    }
    const work = this.retryLoop(id).finally(() => {
      this.background.delete(id);
    });
    this.background.set(id, work);
  }

  private async retryLoop(id: string): Promise<void> {
    const stopped = this.episode(id).stop.signal;
    for (let retry = 1; this.needsRetry(id); retry++) {
      const expedite = new AbortController();
      this.retryExpedites.set(id, expedite);
      try {
        await this.pacing.wait(this.pacing.delay(retry), stopped, expedite.signal);
        if (!this.needsRetry(id)) {
          return;
        }
        const result = await this.attempt(id, expedite.signal);
        if (!this.acceptResult(id, result.outcome, stopped)) {
          return;
        }
        this.settleOwnership(id, result.outcome);
        if (result.outcome === "retry") {
          this.logRetry(id, result.error);
        }
      } catch (error) {
        // Contention/deadlines retain the gate for another turn. Silence after cancel/close
        // is deliberate, pinned by "close wakes a retry wait and suppresses all later logs and calls".
        const admitted = this.canAttempt(id, stopped);
        if (!admitted && !this.closed && !stopped.aborted) {
          // Recovery admission or an ended hold makes this best-effort retry unnecessary.
          logger.debug(
            `[Bindings] Re-own retry no longer admitted for ${id}: ${errorMessage(error)}`,
          );
        }
        if (!admitted) {
          return;
        }
        this.logRetry(id, error);
      } finally {
        this.retryExpedites.delete(id);
      }
    }
  }

  private attempt(id: string, expedited?: AbortSignal): Promise<ReownAttempt> {
    const pending = this.attempts.get(id);
    if (pending) {
      return pending;
    }
    const episode = this.episode(id);
    const work = this.pacing
      .run(
        async () => {
          this.retryExpedites.delete(id);
          if (!this.canAttempt(id, episode.stop.signal)) {
            return { assignments: [], outcome: "retry" } satisfies ReownAttempt;
          }
          if (episode.attempts === 0) {
            episode.sinceMs = (this.deps.timer ?? defaultTimer).now();
            if (this.ownership.get(id) === "unconfirmed") {
              this.startDeadline(id);
            }
          }
          episode.attempts++;
          episode.inFlight = true;
          try {
            return await this.boundedAttempt(id, episode.stop.signal);
          } finally {
            episode.inFlight = false;
          }
        },
        (result) => result.outcome !== "retry",
        episode.stop.signal,
        expedited,
      )
      .finally(() => {
        this.attempts.delete(id);
      });
    this.attempts.set(id, work);
    return work;
  }

  private async boundedAttempt(id: string, stopped: AbortSignal): Promise<ReownAttempt> {
    const attemptStop = new AbortController();
    const signal = AbortSignal.any([this.closing.signal, stopped, attemptStop.signal]);
    try {
      return await raceWithDeadline(() => this.reownSession(id, signal, stopped), {
        timer: this.deps.timer ?? defaultTimer,
        timeoutMs: MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS,
        signal,
        onTimeout: () => attemptStop.abort(new Error(`Re-owning session ${id} attempt timed out`)),
        label: `Re-owning session ${id}`,
      });
    } finally {
      // Stop continuations between registry calls; a late open must not fill the quiet period.
      attemptStop.abort();
    }
  }

  private async registryStep<T>(
    id: string,
    pending: Map<string, Promise<T>>,
    start: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    let observed = false;
    try {
      return await raceWithDeadline(
        () => {
          let operation = pending.get(id);
          if (!operation) {
            operation = start();
            pending.set(id, operation);
          }
          // SingleFlight removes settled flights, but a late result must stay until a turn observes it.
          return operation.then(
            (value) => {
              observed = !signal.aborted;
              return value;
            },
            (error: unknown) => {
              observed = !signal.aborted;
              throw error;
            },
          );
        },
        {
          timer: this.deps.timer ?? defaultTimer,
          signal,
          label: `Re-owning session ${id} registry step`,
        },
      );
    } finally {
      if (observed) {
        pending.delete(id);
      }
    }
  }

  private async readCurrentAssignments(
    sessionUuid: string,
    registry: ManagedExecutionReownRegistry,
    stopped: AbortSignal,
  ): Promise<BindingAssignmentRecord[]> {
    // Consume an abandoned write/read before checking current ownership; its old result is not proof.
    const retainedClaim = this.ownerClaims.get(sessionUuid);
    if (retainedClaim) {
      const claimed = await this.registryStep(
        sessionUuid,
        this.ownerClaims,
        () => retainedClaim,
        stopped,
      );
      if (!this.closed) {
        logger.debug(
          `[Bindings] Session ${sessionUuid} retained claim completed (${claimed.kind}); checking current ownership`,
        );
      }
    }
    const read = () =>
      this.registryStep(
        sessionUuid,
        this.ownerReads,
        () => registry.findExecutionAssignments(sessionUuid),
        stopped,
      );
    if (this.ownerReads.has(sessionUuid)) {
      await read();
      if (!this.closed) {
        logger.debug(
          `[Bindings] Session ${sessionUuid} retained ownership read completed; checking current ownership`,
        );
      }
    }
    return await read();
  }

  private async reownSession(
    sessionUuid: string,
    stopped: AbortSignal,
    episodeStop: AbortSignal,
  ): Promise<ReownAttempt> {
    const result: ReownAttempt = { assignments: [], outcome: "retry" };
    const registry = await this.registryStep(
      sessionUuid,
      this.registryOpens,
      () => this.deps.registry(),
      stopped,
    );
    if (!this.isAdmitted(sessionUuid, stopped)) {
      return result;
    }
    const found = await this.readCurrentAssignments(sessionUuid, registry, stopped);
    if (!this.isAdmitted(sessionUuid, stopped)) {
      return result;
    }
    result.outcome = "confirmed";
    if (found.length === 0) {
      result.outcome = "lost";
    }
    const owner = this.deps.owner();
    for (const assignment of found) {
      if (!this.isAdmitted(sessionUuid, stopped)) {
        return { ...result, outcome: "retry" };
      }
      if (assignment.execOwner && journalOwnersEqual(assignment.execOwner, owner)) {
        continue;
      }
      let claimed: ClaimExecutionResult;
      try {
        claimed = await this.registryStep(
          sessionUuid,
          this.ownerClaims,
          () =>
            registry.claimExecution(
              { scopeKey: assignment.scopeKey, bindingIndex: assignment.bindingIndex },
              { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
              { ...owner, sessionUuid },
              { supersedesSessionUuid: sessionUuid },
            ),
          stopped,
        );
      } catch (error) {
        // The read proved a foreign owner, and a failed write cannot confirm this daemon's fence.
        if (this.isAdmitted(sessionUuid, episodeStop)) {
          this.markUnconfirmed([sessionUuid]);
        }
        throw error;
      }
      if (!this.isAdmitted(sessionUuid, stopped)) {
        return { ...result, outcome: "retry" };
      }
      if (claimed.kind === "claimed") {
        result.assignments.push(claimed.assignment);
      } else {
        this.markUnconfirmed([sessionUuid]);
        this.recordRefusal(result, claimed.kind, assignment, sessionUuid);
      }
    }
    return result;
  }

  private recordRefusal(
    result: ReownAttempt,
    kind: Exclude<ClaimExecutionResult["kind"], "claimed">,
    assignment: BindingAssignmentRecord,
    sessionUuid: string,
  ): void {
    if (
      kind === "binding_in_use" ||
      kind === "scope_not_valid" ||
      kind === "binding_missing" ||
      // Defensive: the shared result type includes this commit-only refusal.
      kind === "device_assigned_elsewhere"
    ) {
      result.outcome = "lost";
      // A marked session gets one permanent-loss warning from settleOwnership.
      if (kind === "binding_in_use" && this.ownership.has(sessionUuid)) {
        return;
      }
    } else if (result.outcome !== "lost") {
      result.outcome = "retry";
    }
    result.error = new Error(
      `Binding ${assignment.bindingIndex} of ${assignment.scopeKey} was not re-owned for session ${sessionUuid}: ${kind}`,
    );
  }
}
