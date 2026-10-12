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
import { DefaultRetryExecutor } from "../../utils/retry/RetryExecutor";
import type { Timer } from "../../utils/SystemTimer";
import { MANAGED_EXECUTION_REGISTRY_RETRY_BACKOFF } from "./managedExecutionRelease";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  journalOwnersEqual,
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
  /** Absent: keep marked sessions. */
  isSessionHeld?: (sessionUuid: string) => boolean;
}

type OwnershipState = "unconfirmed" | "lost";
type ReownAttempt = {
  assignments: SlotAssignmentRecord[];
  outcome: "confirmed" | "retry" | "lost";
};

export class ManagedExecutionReowner {
  private readonly ownership = new Map<string, OwnershipState>();
  private readonly attempts = new Map<string, Promise<ReownAttempt>>();
  private readonly background = new Map<string, Promise<void>>();
  private readonly closing = new AbortController();
  private readonly retry: DefaultRetryExecutor;
  private readonly backoff: BackoffPolicy;
  private closed = false;

  constructor(private readonly deps: ManagedExecutionReownerDependencies) {
    this.retry = new DefaultRetryExecutor(deps.timer);
    this.backoff = deps.retryBackoff ?? MANAGED_EXECUTION_REGISTRY_RETRY_BACKOFF;
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
      this.markRehydrated(sessionUuids);
    }
    const assignments: SlotAssignmentRecord[] = [];
    for (const id of sessionUuids) {
      assignments.push(...(await this.reownInline(id)));
    }
    return assignments;
  }

  private markRehydrated(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.isHeld(id) && !this.ownership.has(id)) {
        this.ownership.set(id, "unconfirmed");
      }
    }
  }

  private async reownInline(id: string): Promise<SlotAssignmentRecord[]> {
    if (!this.canAttempt(id) || this.ownership.get(id) === "lost") {
      return [];
    }
    try {
      const attempt = await this.attempt(id);
      this.settleOwnership(id, attempt.outcome);
      if (attempt.outcome === "retry") {
        this.retryInBackground(id, new Error("stale_binding"));
      }
      return attempt.assignments;
    } catch (error) {
      if (!this.closed) {
        logger.warn(
          `[ManagedSlots] Re-owning managed execution ${id} failed: ${errorMessage(error)}`,
          error,
        );
        this.retryInBackground(id, error);
      }
      return [];
    }
  }

  private canAttempt(id: string): boolean {
    return !this.closed && this.isHeld(id);
  }

  /** Synchronous O(1) automation admission; sessions never marked by rehydration are unaffected. */
  automationRefusal(sessionUuid: string): string | undefined {
    if (!this.isHeld(sessionUuid)) {
      return undefined;
    }
    switch (this.ownership.get(sessionUuid)) {
      case "unconfirmed":
        return `Session '${sessionUuid}' slot ownership is not recorded for this daemon yet; the managed slot registry is busy. Retry shortly.`;
      case "lost":
        return `Session '${sessionUuid}' no longer owns its managed slot; acquire a new session.`;
      default:
        return undefined;
    }
  }

  /** Stop registry work and abort waits, retaining the gate while this process still holds it. */
  close(): void {
    this.closed = true;
    this.closing.abort();
  }

  async whenIdle(): Promise<void> {
    while (this.background.size > 0 || this.attempts.size > 0) {
      await Promise.allSettled([...this.background.values(), ...this.attempts.values()]);
    }
  }

  private isHeld(id: string): boolean {
    if (this.deps.isSessionHeld?.(id) !== false) {
      return true;
    }
    this.ownership.delete(id);
    return false;
  }

  private pruneReleasedSessions(): void {
    for (const id of this.ownership.keys()) {
      this.isHeld(id);
    }
  }

  private settleOwnership(id: string, outcome: ReownAttempt["outcome"]): void {
    if (this.closed || !this.isHeld(id) || this.ownership.get(id) !== "unconfirmed") {
      return;
    }
    if (outcome === "confirmed") {
      this.ownership.delete(id);
    }
    if (outcome === "lost") {
      this.ownership.set(id, "lost");
      logger.warn(
        `[ManagedSlots] Session '${id}' no longer owns its managed slot; acquire a new session.`,
      );
    }
  }

  private needsRetry(id: string): boolean {
    return !this.closed && this.isHeld(id) && this.ownership.get(id) === "unconfirmed";
  }

  private retryInBackground(id: string, initialFailure: unknown): void {
    if (!this.needsRetry(id) || this.background.has(id)) {
      return;
    }
    const work = this.retry
      .execute(
        async (attempt) => {
          if (!this.needsRetry(id)) {
            return;
          }
          // The inline attempt already failed: feed it to the executor to wait before the next call.
          if (attempt === 1) {
            throw initialFailure;
          }
          const result = await this.attempt(id);
          this.settleOwnership(id, result.outcome);
          if (result.outcome === "retry") {
            throw new Error("stale_binding");
          }
        },
        {
          maxAttempts: Number.MAX_SAFE_INTEGER,
          signal: this.closing.signal,
          shouldRetry: () => this.needsRetry(id),
          delays: this.backoff,
          onRetry: (error, attempt) => {
            if (attempt > 1 && !this.closed) {
              logger.warn(
                `[ManagedSlots] Re-owning managed execution ${id} failed; retrying: ${error.message}`,
                error,
              );
            }
          },
          expectedFailure: {
            reason: "the re-owner stopped or no longer holds an unconfirmed session",
          },
        },
      )
      .then(() => {
        this.pruneReleasedSessions();
      })
      .finally(() => {
        this.background.delete(id);
      });
    this.background.set(id, work);
  }

  private attempt(id: string): Promise<ReownAttempt> {
    const pending = this.attempts.get(id);
    if (pending) {
      return pending;
    }
    const work = this.reownSession(id).finally(() => {
      this.attempts.delete(id);
    });
    this.attempts.set(id, work);
    return work;
  }

  private async reownSession(sessionUuid: string): Promise<ReownAttempt> {
    const result: ReownAttempt = { assignments: [], outcome: "confirmed" };
    if (!this.canAttempt(sessionUuid)) {
      return result;
    }
    const registry = await this.deps.registry();
    if (!this.canAttempt(sessionUuid)) {
      return result;
    }
    const found = await registry.findExecutionAssignments(sessionUuid);
    if (found.length === 0) {
      result.outcome = "lost";
    }
    const owner = this.deps.owner();
    for (const assignment of found) {
      if (!this.canAttempt(sessionUuid)) {
        break;
      }
      if (assignment.execOwner && journalOwnersEqual(assignment.execOwner, owner)) {
        continue;
      }
      const claimed = await registry.claimExecution(
        { scopeKey: assignment.scopeKey, slotIndex: assignment.slotIndex },
        { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
        { ...owner, sessionUuid },
        { supersedesSessionUuid: sessionUuid },
      );
      if (!this.canAttempt(sessionUuid)) {
        break;
      }
      if (claimed.kind === "claimed") {
        logger.info(
          `[ManagedSlots] Slot ${assignment.slotIndex} of ${assignment.scopeKey} re-owned by daemon ` +
            `${owner.daemonId} (pid ${owner.pid}) for live session ${sessionUuid}`,
        );
        result.assignments.push(claimed.assignment);
      } else {
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
    if (kind === "stale_binding" && result.outcome !== "lost") {
      result.outcome = "retry";
    }
    logger.warn(
      `[ManagedSlots] Slot ${assignment.slotIndex} of ${assignment.scopeKey} was not re-owned ` +
        `for session ${sessionUuid}: ${kind}`,
    );
  }
}
