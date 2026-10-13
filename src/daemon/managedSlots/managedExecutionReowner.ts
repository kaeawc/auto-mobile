/**
 * Re-owning live managed executions after a daemon restart (#11275).
 *
 * A slot's execution owner is the daemon process holding the execution's session: the session (its
 * owner lease, heartbeat and idle judgement) lives in that daemon, and so do the reservations the
 * reconciler claims before a session exists. The proxy's process is not recorded: the daemon never
 * learns a trusted proxy PID, and a proxy without its daemon session cannot use the slot anyway.
 *
 * A managed-execution session survives a daemon restart (it is rehydrated and its proxy re-binds),
 * but the slot still names the previous daemon's PID, which is now dead. Left alone, the slot looks
 * ownerless: a duplicate acquisition takes it over and the abandonment sweep can fence it. So once
 * this daemon holds such a session again (rehydration, or the proxy's `daemon/registerSession`
 * re-bind) it re-stamps the slot's owner with itself, claiming the slot for the same session UUID.
 * Rehydrated work stays gated until that host-visible ownership is confirmed (#12053).
 */

import type { BackoffPolicy } from "../../utils/Backoff";
import type { ActionableError } from "../../models/ActionableError";
import {
  ManagedSlotOwnershipLostError,
  ManagedSlotOwnershipUnconfirmedError,
} from "./managedSlotRefusal";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { ReleaseDeviceHold } from "../sessionManager";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS } from "./managedExecutionRelease";
import {
  RegistryRetryPacing,
  REGISTRY_RETRY_INITIAL_DELAY_MS,
  REGISTRY_RETRY_MAX_DELAY_MS,
  REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS,
  REGISTRY_BUSY_WRITE_MS,
} from "./registryRetryPacing";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  journalOwnersEqual,
  type ClaimExecutionResult,
  type SlotAssignmentRecord,
  type SlotProcessIdentity,
  type SlotRegistry,
} from "./slotRegistry";

export type ManagedExecutionReownRegistry = Pick<
  SlotRegistry,
  "findExecutionAssignments" | "claimExecution"
>;

export interface ManagedExecutionReownerDependencies {
  registry: () => Promise<ManagedExecutionReownRegistry>;
  /**
   * Whether the host registry exists. A host that never served a managed slot has none, and
   * re-owning must not create it. Defaults to always existing.
   */
  registryExists?: () => boolean;
  /** This daemon, as recorded for a slot's execution owner. */
  owner: () => SlotProcessIdentity;
  timer?: Timer;
  retryBackoff?: BackoffPolicy;
  /** Live admission for new re-owns; pending holds and present unconfirmed sessions also retry. */
  isSessionHeld?: (sessionUuid: string) => boolean;
  /** Object retention, independent of expiry/fences/releases. Absent: use isSessionHeld. */
  isSessionPresent?: (sessionUuid: string) => boolean;
  onOwnershipConfirmed?: (sessionUuid: string) => void;
  onOwnershipLost?: (sessionUuid: string) => void;
  /** Captured before release hides the session, for an unknown-ownership state-drop diagnostic. */
  deviceOf?: (sessionUuid: string) => string | null;
}

// One re-own attempt's 700 ms bound plus one blocked registry write's 250 ms busy timeout = 950 ms.
// Measured on the daemon's timer; an attempt queued behind another pacer's turn is not
// guaranteed to finish inside the cap. A synchronous write crossing it delays the cap
// by at most that write, and the cap-derived cleanup hint is short by that delay.
export const MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS =
  MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS + REGISTRY_BUSY_WRITE_MS;
export const MANAGED_EXECUTION_REOWN_RETRY_INITIAL_DELAY_MS = REGISTRY_RETRY_INITIAL_DELAY_MS;
export const MANAGED_EXECUTION_REOWN_RETRY_MAX_DELAY_MS = REGISTRY_RETRY_MAX_DELAY_MS;
export const MANAGED_EXECUTION_REOWN_RETRY_MAX_BLOCKED_WAIT_MS = REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS;
export const MANAGED_EXECUTION_REOWN_WARN_AFTER_MS = 5_000;
type HoldOutcome = "teardown" | "skip-device-writes";
interface ReleaseHold {
  settled: Promise<HoldOutcome>;
  resolve: (outcome: HoldOutcome) => void;
  timeout: NodeJS.Timeout;
  device: string;
}

type OwnershipState = "unconfirmed" | "lost";
type ReownAttempt = {
  assignments: SlotAssignmentRecord[];
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
  private readonly ownerReads = new Map<string, Promise<SlotAssignmentRecord[]>>();
  private readonly ownerClaims = new Map<string, Promise<ClaimExecutionResult>>();
  private readonly background = new Map<string, Promise<void>>();
  /** Only a retry waiting for backoff/quiet/a turn can consume a hold's one expedite. */
  private readonly retryExpedites = new Map<string, AbortController>();
  private readonly closing = new AbortController();
  private readonly releaseHolds = new Map<string, ReleaseHold>();
  private readonly episodes = new Map<
    string,
    { attempts: number; warned: boolean; sinceMs: number; stop: AbortController }
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
  ): Promise<SlotAssignmentRecord[]> {
    if (this.closed || sessionUuids.length === 0 || this.deps.registryExists?.() === false) {
      return [];
    }
    this.pruneReleasedSessions();
    if (options?.rehydrated) {
      this.markUnconfirmed(sessionUuids.filter((id) => !this.recoveredSessions.has(id)));
    }
    const assignments: SlotAssignmentRecord[] = [];
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
          logger.debug(`[ManagedSlots] Recovery of ${sessionUuid} failed before re-owning`, error);
        }
        this.recovering.delete(sessionUuid);
        this.isPresent(sessionUuid);
      },
    );
  }

  ownershipState(sessionUuid: string): OwnershipState | undefined {
    return this.isPresent(sessionUuid) ? this.ownership.get(sessionUuid) : undefined;
  }

  /** A hold ends at proof or its cap; unresolved ownership keeps retrying while the object exists. */
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
      `[ManagedSlots] Session ${id} on device ${device}: saved device state was dropped because ownership could not be confirmed.`,
    );
  }

  private episode(id: string) {
    let episode = this.episodes.get(id);
    if (!episode) {
      episode = {
        attempts: 0,
        warned: false,
        sinceMs: (this.deps.timer ?? defaultTimer).now(),
        stop: new AbortController(),
      };
      this.episodes.set(id, episode);
    }
    return episode;
  }

  private logUnconfirmed(id: string, message: string, error?: unknown): void {
    if (this.closed) {
      return;
    }
    const episode = this.episode(id);
    // Busy writes and unready slots are expected while the retained session recovers.
    logger.debug(message, error);
    const ageMs = (this.deps.timer ?? defaultTimer).now() - episode.sinceMs;
    if (
      this.ownership.get(id) === "unconfirmed" &&
      !episode.warned &&
      ageMs > MANAGED_EXECUTION_REOWN_WARN_AFTER_MS
    ) {
      episode.warned = true;
      logger.warn(
        `[ManagedSlots] Session ${id} ownership unconfirmed for ${ageMs} ms (${episode.attempts} attempts): ${errorMessage(error)}; retries continue`,
        error,
      );
    }
  }

  private markUnconfirmed(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.isPresent(id) && !this.ownership.has(id)) {
        this.ownership.set(id, "unconfirmed");
        this.episode(id).sinceMs = (this.deps.timer ?? defaultTimer).now();
      }
    }
  }

  private async reownInline(id: string): Promise<SlotAssignmentRecord[]> {
    if (!this.canAttempt(id) || this.ownership.get(id) === "lost") {
      return [];
    }
    const episode = this.episode(id);
    try {
      const attempt = await this.attempt(id);
      if (!this.canAttempt(id, episode.stop.signal)) {
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
            `[ManagedSlots] Re-owning managed execution ${id} failed after resolution`,
            error,
          );
        }
        return [];
      }
      this.logUnconfirmed(
        id,
        `[ManagedSlots] Re-owning managed execution ${id} failed: ${errorMessage(error)}`,
        error,
      );
      this.retryInBackground(id);
      return [];
    }
  }

  private canAttempt(id: string, stopped?: AbortSignal): boolean {
    return !this.closed && !stopped?.aborted && !this.recovering.has(id) && this.isHeld(id);
  }

  /** Synchronous O(1) automation admission for sessions marked by rehydration or foreign-owner evidence. */
  automationRefusal(sessionUuid: string): ActionableError | undefined {
    switch (this.ownershipState(sessionUuid)) {
      case "unconfirmed":
        return new ManagedSlotOwnershipUnconfirmedError(sessionUuid);
      case "lost":
        return new ManagedSlotOwnershipLostError(sessionUuid);
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
    for (const episode of this.episodes.values()) {
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

  /** Admission is live, except ownership recovery must outlive a release's hold cap. */
  private isHeld(id: string): boolean {
    return (
      this.isPresent(id) &&
      (this.releaseHolds.has(id) ||
        this.deps.isSessionHeld?.(id) !== false ||
        (this.deps.isSessionPresent !== undefined && this.ownership.get(id) === "unconfirmed"))
    );
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
    if (this.closed || !this.isPresent(id) || this.ownership.get(id) !== "unconfirmed") {
      return;
    }
    if (outcome === "confirmed") {
      this.forgetRegistrySteps(id);
      this.ownership.delete(id);
      logger.info(
        `[ManagedSlots] Session ${id} ownership confirmed after ${(this.deps.timer ?? defaultTimer).now() - this.episode(id).sinceMs} ms (${this.episode(id).attempts} attempts); re-owned by daemon ${this.deps.owner().daemonId}.`,
      );
      this.resolveHold(id, "teardown");
      this.episodes.get(id)?.stop.abort();
      this.episodes.delete(id);
      this.notifyOwnership(id, "confirmed");
    }
    if (outcome === "lost") {
      this.forgetRegistrySteps(id);
      this.ownership.set(id, "lost");
      logger.warn(
        `[ManagedSlots] Session '${id}' no longer owns its managed slot; acquire a new session.`,
      );
      this.resolveHold(id, "skip-device-writes");
      this.episodes.get(id)?.stop.abort();
      this.notifyOwnership(id, "lost");
    }
  }

  private notifyOwnership(id: string, outcome: "confirmed" | "lost"): void {
    const hook =
      outcome === "confirmed" ? this.deps.onOwnershipConfirmed : this.deps.onOwnershipLost;
    try {
      hook?.(id);
    } catch (error) {
      logger.warn(`[ManagedSlots] Ownership-${outcome} hook failed for ${id}`, error);
    }
  }

  private needsRetry(id: string): boolean {
    return this.canAttempt(id) && this.ownership.get(id) === "unconfirmed";
  }

  private logRetry(
    id: string,
    failure: unknown = new Error("managed slot ownership unconfirmed"),
  ): void {
    this.logUnconfirmed(
      id,
      `[ManagedSlots] Re-owning managed execution ${id} failed; retrying: ${errorMessage(failure)}`,
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
        if (!this.canAttempt(id, stopped)) {
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
            `[ManagedSlots] Re-own retry no longer admitted for ${id}: ${errorMessage(error)}`,
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
          episode.attempts++;
          return await this.boundedAttempt(id, episode.stop.signal);
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
  ): Promise<SlotAssignmentRecord[]> {
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
          `[ManagedSlots] Session ${sessionUuid} retained claim completed (${claimed.kind}); checking current ownership`,
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
          `[ManagedSlots] Session ${sessionUuid} retained ownership read completed; checking current ownership`,
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
    if (!this.canAttempt(sessionUuid, stopped)) {
      return result;
    }
    const found = await this.readCurrentAssignments(sessionUuid, registry, stopped);
    if (!this.canAttempt(sessionUuid, stopped)) {
      return result;
    }
    result.outcome = "confirmed";
    if (found.length === 0) {
      result.outcome = "lost";
    }
    const owner = this.deps.owner();
    for (const assignment of found) {
      if (!this.canAttempt(sessionUuid, stopped)) {
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
              { scopeKey: assignment.scopeKey, slotIndex: assignment.slotIndex },
              { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
              { ...owner, sessionUuid },
              { supersedesSessionUuid: sessionUuid },
            ),
          stopped,
        );
      } catch (error) {
        // The read proved a foreign owner, and a failed write cannot confirm this daemon's fence.
        if (this.canAttempt(sessionUuid, episodeStop)) {
          this.markUnconfirmed([sessionUuid]);
        }
        throw error;
      }
      if (!this.canAttempt(sessionUuid, stopped)) {
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
    kind: string,
    assignment: SlotAssignmentRecord,
    sessionUuid: string,
  ): void {
    if (kind === "slot_in_use") {
      result.outcome = "lost";
      // A marked session gets one permanent-loss warning from settleOwnership.
      if (this.ownership.has(sessionUuid)) {
        return;
      }
    }
    if (kind !== "slot_in_use" && result.outcome !== "lost") {
      result.outcome = "retry";
    }
    result.error = new Error(
      `Slot ${assignment.slotIndex} of ${assignment.scopeKey} was not re-owned for session ${sessionUuid}: ${kind}`,
    );
  }
}
