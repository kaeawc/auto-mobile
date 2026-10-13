/**
 * The daemon side of `daemon/acquireManagedSlots` (epic #11172, #11173 part b).
 *
 * A stdio proxy launched with a managed slot config calls this before it answers `initialize`. One
 * acquisition:
 *
 * 1. Admits the runner scope. A new incarnation of a known `(host, namespace)` transitions
 *    implicitly (owner decision Q2): the old scope is moved to `invalidating`, and completed once
 *    its live owners and pending cleanup have settled; until then the acquisition fails retryable
 *    `scope_transition_pending`. An abandoned scope whose incarnation returns is revived by the
 *    registry. A reset incarnation fails `scope_invalidated` for good.
 * 2. Reconciles every requested slot to its spec, claiming the slot for this daemon's execution
 *    atomically with the outcome (reused / adopted / created / replaced).
 * 3. Hands each slot's fresh session to the caller: liveness ownership is claimed for the caller's
 *    owner token at once (so nothing can take it before the proxy's first heartbeat), and the
 *    session goes on the `managed-execution` policy with the config's idle window (owner decision
 *    Q1: configurable, 2-minute default).
 *
 * Any failure after a session was handed out backs that session out again (slot execution owner
 * cleared, session released, the slot keeps its device). Unfinished cleanup is retained and retried
 * in the background; a failed acquisition never waits for these retries.
 */

import { classifySqliteError } from "../../db/databaseFailureClassification";
import { ManagedSlotDiscoveryIncompleteError } from "./managedSlotRefusal";
import { failure as reconcileFailure } from "./reconciler";
import {
  MANAGED_EXECUTION_LIVENESS_POLICY,
  resolveManagedExecutionIdleTimeoutMs,
} from "../managedExecutionLiveness";
import type { ManagedSlotConfig, ManagedSlotRequest } from "../../models/managedSlotConfig";
import type {
  ManagedSlotResultEntry,
  ManagedSlotsFailure,
  ManagedSlotAcquisitionOwnFailureCode,
  ManagedSlotsResult,
} from "../../models/managedSlotsResult";
import { DEFAULT_PROVISION_DEVICE_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import { exponentialBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type {
  ManagedSlotReconcileRequest,
  ManagedSlotReconcileResult,
  ManagedSlotRequestedSpec,
} from "./reconciler";
import {
  computeSlotScopeKey,
  type SlotKey,
  type SlotExecOwner,
  type SlotProcessIdentity,
  type SlotRegistry,
  type SlotScopeIdentity,
  type SlotScopeRecord,
} from "./slotRegistry";
import { MANAGED_EXECUTION_SETTLEMENT_SLOW_POLL_MS } from "./managedExecutionRelease";
import { SLOT_SCOPE_RESET_DEFAULT_WAIT_MS, type SlotScopeResetScopeResult } from "./slotScopeReset";

export interface ManagedSlotAcquisitionSessions {
  /** Claim the session's liveness for the caller's owner token. */
  claimLivenessOwnership(
    sessionId: string,
    ownerToken: string,
  ): Promise<"claimed" | "conflict" | "superseded" | "not-found">;
  /** Put the session on the `managed-execution` policy with its idle window. */
  adoptManagedExecutionLivenessPolicy(
    sessionId: string,
    options: { idleTimeoutMs?: number },
  ): Promise<unknown>;
  /** Release a session this acquisition handed out but could not complete (device kept by slot). */
  releaseSession(sessionId: string): Promise<void>;
}

export interface ManagedSlotAcquisitionDependencies {
  registry: () => Promise<SlotRegistry>;
  /** The reconciler bound to the same registry (production: real inventory/provision/delete). */
  reconcile: (
    registry: SlotRegistry,
    request: ManagedSlotReconcileRequest,
  ) => Promise<ManagedSlotReconcileResult>;
  sessions: ManagedSlotAcquisitionSessions;
  /** This daemon, recorded as the slots' execution owner. */
  owner: () => SlotProcessIdentity;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  backOutRetryBackoff?: BackoffPolicy;
  backOutRetryMaxAttempts?: number;
  backOutRetrySlowPollMs?: number;
  /**
   * The implicit reset of a superseded incarnation (`SlotScopeReset.resetSupersededScope`, #11174):
   * waits up to `waitMs` for the old scope's owners and cleanup to settle. Absent, or returning
   * undefined (no reset wired), the acquisition checks the old scope once without waiting.
   */
  resetSupersededScope?: (
    scope: SlotScopeRecord,
    waitMs: number,
  ) => Promise<Pick<SlotScopeResetScopeResult, "outcome" | "pending">> | undefined;
}

export interface ManagedSlotAcquireOptions {
  /** The proxy's liveness owner token; the slot sessions are claimed for it. */
  livenessOwnerToken: string;
  signal?: AbortSignal;
}

const ACQUISITION_NEXT_ACTION: Readonly<Record<string, string>> = {
  scope_invalidated:
    "This runner incarnation was reset; launch with the current runnerIncarnation.",
  scope_transition_pending:
    "Wait for the previous runner incarnation's executions and cleanup to settle, then retry.",
  execution_policy_failed: "Retry; the session could not be held for the execution.",
  liveness_owner_conflict: "Retry; another owner claimed the slot's session.",
  timeout: "Retry with a longer preparationTimeoutMs.",
  cancelled: "The preparation was cancelled; retry when needed.",
};

export function acquisitionFailure(
  code: ManagedSlotAcquisitionOwnFailureCode,
  message: string,
  retryable: boolean,
): ManagedSlotsFailure {
  return {
    code,
    retryable,
    message,
    nextAction: ACQUISITION_NEXT_ACTION[code] ?? "Retry.",
  };
}

interface SlotAcquireOptions {
  deadlineMs: number;
  idleTimeoutMs: number;
  livenessOwnerToken: string;
  signal?: AbortSignal;
}

type ScopeAdmission =
  | { kind: "ready"; scopeKey: string; revived: boolean }
  | { kind: "failed"; failure: ManagedSlotsFailure };

export const MANAGED_SLOT_BACK_OUT_RETRY_INITIAL_DELAY_MS = 250;
export const MANAGED_SLOT_BACK_OUT_RETRY_MAX_DELAY_MS = 5_000;
export const MANAGED_SLOT_BACK_OUT_RETRY_MAX_ATTEMPTS = 8;

/** Owed cleanup; gave_up means the bounded round ended, with attempts still counted slowly. */
export interface ManagedSlotBackOutCleanup {
  key: SlotKey;
  sessionUuid: string;
  state: "retrying" | "gave_up";
  attempts: number;
  ownerClearOwed: boolean;
  sessionReleaseOwed: boolean;
  lastError: string;
}

export class ManagedSlotAcquisition {
  private closed = false;
  private readonly backOutCleanups = new Map<
    string,
    { registry: SlotRegistry; cleanup: ManagedSlotBackOutCleanup }
  >();
  private readonly background = new Set<Promise<void>>();
  private readonly retryWaits = new Set<() => void>();
  private readonly retryBackoff = exponentialBackoff({
    initialDelayMs: MANAGED_SLOT_BACK_OUT_RETRY_INITIAL_DELAY_MS,
    maxDelayMs: MANAGED_SLOT_BACK_OUT_RETRY_MAX_DELAY_MS,
  });

  constructor(private readonly deps: ManagedSlotAcquisitionDependencies) {}

  /** Stop waits immediately; outstanding owner rows become dead when this process exits. */
  close(): void {
    this.closed = true;
    for (const cancel of this.retryWaits) {
      cancel();
    }
  }

  /** Wait until no background task runs, including slow retries, which end on cleanup or close. */
  async whenIdle(): Promise<void> {
    while (this.background.size > 0) {
      await Promise.allSettled([...this.background]);
    }
  }

  pendingBackOutCleanups(): readonly ManagedSlotBackOutCleanup[] {
    return [...this.backOutCleanups.values()].map(({ cleanup }) => ({
      ...cleanup,
      key: { ...cleanup.key },
    }));
  }

  async acquire(
    config: ManagedSlotConfig,
    options: ManagedSlotAcquireOptions,
  ): Promise<ManagedSlotsResult> {
    const identity: SlotScopeIdentity = {
      managedHostScope: config.managedHostScope,
      runnerNamespace: config.runnerNamespace,
      runnerIncarnation: config.runnerIncarnation,
    };
    const base = (
      scopeKey: string | null,
      revived?: boolean,
    ): Omit<ManagedSlotsResult, "outcome" | "slots"> => ({
      contractVersion: 1,
      scope: { ...identity, scopeKey, ...(revived ? { revived } : {}) },
    });
    let idleTimeoutMs: number;
    try {
      idleTimeoutMs = resolveManagedExecutionIdleTimeoutMs(config.idleTimeoutMs);
    } catch (error) {
      return {
        ...base(null),
        outcome: "failed",
        slots: [],
        failure: acquisitionFailure("managed_slot_config_invalid", errorMessage(error), false),
      };
    }
    const deadlineMs =
      this.deps.timer.now() + (config.preparationTimeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS);
    let registry: SlotRegistry;
    let admission: ScopeAdmission;
    try {
      registry = await this.deps.registry();
      admission = await this.admitScope(registry, identity, deadlineMs);
    } catch (error) {
      if (
        classifySqliteError(error) !== "retryable" &&
        !(error instanceof ManagedSlotDiscoveryIncompleteError)
      ) {
        throw error;
      }
      // Nothing has been handed out yet; the client can retry the whole scope admission.
      return {
        ...base(computeSlotScopeKey(identity)),
        outcome: "failed",
        slots: [],
        failure: reconcileFailure("discovery_incomplete", errorMessage(error)),
      };
    }
    if (admission.kind === "failed") {
      return {
        ...base(computeSlotScopeKey(identity)),
        outcome: "failed",
        slots: [],
        failure: admission.failure,
      };
    }
    const { slots, failure } = await this.acquireSlots(
      registry,
      admission.scopeKey,
      config.requests,
      {
        deadlineMs,
        idleTimeoutMs,
        livenessOwnerToken: options.livenessOwnerToken,
        signal: options.signal,
      },
    );
    return {
      ...base(admission.scopeKey, admission.revived),
      outcome: failure ? "failed" : "ready",
      idleTimeoutMs,
      slots,
      ...(failure ? { failure } : {}),
    };
  }

  /** Acquire every slot, all or nothing: a partially acquired group holds no session. */
  private async acquireSlots(
    registry: SlotRegistry,
    scopeKey: string,
    requests: readonly ManagedSlotRequest[],
    options: SlotAcquireOptions,
  ): Promise<{ slots: ManagedSlotResultEntry[]; failure: ManagedSlotsFailure | undefined }> {
    const slots: ManagedSlotResultEntry[] = [];
    const handedOut: { key: SlotKey; sessionUuid: string }[] = [];
    let failure: ManagedSlotsFailure | undefined;
    for (const request of requests) {
      const key: SlotKey = { scopeKey, slotIndex: request.slotIndex };
      const entry = await this.acquireSlot(registry, key, request, options);
      slots.push(entry);
      if (entry.failure) {
        failure = entry.failure;
        break;
      }
      handedOut.push({ key, sessionUuid: entry.sessionUuid! });
    }
    if (!failure && options.signal?.aborted) {
      // The caller went away while the last slot was prepared: nobody will hold these sessions.
      failure = acquisitionFailure(
        "cancelled",
        "The managed slot acquisition was cancelled.",
        true,
      );
    }
    if (failure) {
      await Promise.all(
        handedOut.map(({ key, sessionUuid }) => this.backOut(registry, key, sessionUuid)),
      );
      for (const slot of slots) {
        if (!slot.failure) {
          slot.sessionUuid = null;
        }
      }
    }
    return { slots, failure };
  }

  /**
   * Admit the scope, transitioning implicitly from an older incarnation of the same namespace once
   * that incarnation has settled (owner decision Q2).
   */
  private async admitScope(
    registry: SlotRegistry,
    identity: SlotScopeIdentity,
    deadlineMs: number,
  ): Promise<ScopeAdmission> {
    let ensured = await registry.ensureScope(identity);
    if (ensured.kind === "incarnation_conflict") {
      const pending = await this.retireSupersededScope(registry, ensured.current, deadlineMs);
      if (pending) {
        return { kind: "failed", failure: pending };
      }
      ensured = await registry.ensureScope(identity);
    }
    switch (ensured.kind) {
      case "ready":
        if (ensured.revived) {
          logger.info(
            `[ManagedSlots] Revived abandoned scope ${ensured.scope.scopeKey} ` +
              `(${identity.runnerNamespace}/${identity.runnerIncarnation})`,
          );
        }
        return { kind: "ready", scopeKey: ensured.scope.scopeKey, revived: ensured.revived };
      case "scope_invalidated":
        return {
          kind: "failed",
          failure: acquisitionFailure(
            "scope_invalidated",
            `Runner incarnation '${identity.runnerIncarnation}' of namespace ` +
              `'${identity.runnerNamespace}' was reset and no longer accepts work.`,
            false,
          ),
        };
      case "incarnation_conflict":
        return {
          kind: "failed",
          failure: acquisitionFailure(
            "scope_transition_pending",
            `Runner incarnation '${ensured.current.runnerIncarnation}' is still being retired.`,
            true,
          ),
        };
    }
  }

  /**
   * Retire the superseded incarnation through the settle-waiting reset when one is wired (bounded by
   * the preparation deadline), else with one settle check. Returns the `scope_transition_pending`
   * failure while the old scope is unsettled, undefined once it is invalidated.
   */
  private async retireSupersededScope(
    registry: SlotRegistry,
    previous: SlotScopeRecord,
    deadlineMs: number,
  ): Promise<ManagedSlotsFailure | undefined> {
    const waitMs = Math.max(
      0,
      Math.min(SLOT_SCOPE_RESET_DEFAULT_WAIT_MS, deadlineMs - this.deps.timer.now()),
    );
    const reset = await this.deps.resetSupersededScope?.(previous, waitMs);
    let waiting: { liveOwners: number; settling: number; cleanupPending: number } | undefined;
    if (reset) {
      waiting =
        reset.outcome === "pending"
          ? {
              liveOwners: reset.pending?.liveOwners.length ?? 0,
              settling: reset.pending?.settling.length ?? 0,
              cleanupPending: reset.pending?.cleanupPending.length ?? 0,
            }
          : undefined;
    } else {
      await registry.beginScopeInvalidation(previous.scopeKey, "incarnation_reset");
      const completed = await registry.completeScopeInvalidation(previous.scopeKey);
      waiting =
        completed.kind === "pending"
          ? {
              liveOwners: completed.liveOwners.length,
              settling: completed.settling.length,
              cleanupPending: completed.cleanupPending.length,
            }
          : undefined;
    }
    if (!waiting) {
      return undefined;
    }
    return acquisitionFailure(
      "scope_transition_pending",
      `Runner incarnation '${previous.runnerIncarnation}' of namespace ` +
        `'${previous.runnerNamespace}' still has ${waiting.liveOwners} live ` +
        `execution(s), ${waiting.settling} settling and ` +
        `${waiting.cleanupPending} cleanup-pending slot(s).`,
      true,
    );
  }

  private async acquireSlot(
    registry: SlotRegistry,
    key: SlotKey,
    request: ManagedSlotRequest,
    options: SlotAcquireOptions,
  ): Promise<ManagedSlotResultEntry> {
    const result = await this.deps.reconcile(registry, {
      key,
      role: request.role,
      platform: request.platform,
      requestedSpec: request.requestedSpec as ManagedSlotRequestedSpec,
      ...(request.priorDeviceHint ? { priorDeviceHint: request.priorDeviceHint } : {}),
      deadlineMs: options.deadlineMs,
      signal: options.signal,
      owner: this.deps.owner(),
    });
    if (result.outcome === "failed") {
      return {
        slotIndex: request.slotIndex,
        role: request.role,
        platform: request.platform,
        assignmentGeneration: result.assignment?.generation ?? null,
        device: null,
        sessionUuid: null,
        requestedSpec: request.requestedSpec,
        resolvedSpec: result.assignment?.resolvedSpec ?? null,
        specFingerprint: null,
        disposition: null,
        readiness: null,
        lifecycle: { evidence: result.evidence },
        failure: {
          code: result.failure.code,
          retryable: result.failure.retryable,
          message: result.failure.message,
          nextAction: result.failure.nextAction,
          ...(result.failure.capacity ? { capacity: result.failure.capacity } : {}),
          ...(result.failure.budget ? { budget: result.failure.budget } : {}),
        },
      };
    }
    const ready: ManagedSlotResultEntry = {
      slotIndex: request.slotIndex,
      role: request.role,
      platform: request.platform,
      assignmentGeneration: result.assignment.generation,
      device: result.device,
      sessionUuid: result.sessionUuid,
      requestedSpec: result.requestedSpec,
      resolvedSpec: result.resolvedSpec,
      specFingerprint: result.specFingerprint,
      disposition: result.disposition,
      readiness: result.readiness,
      lifecycle: {
        ...(result.lifecycle !== undefined ? { provision: result.lifecycle } : {}),
        evidence: result.evidence,
      },
    };
    const handOff = await this.handOff(result.sessionUuid, options);
    if (handOff) {
      await this.backOut(registry, key, result.sessionUuid);
      return { ...ready, sessionUuid: null, failure: handOff };
    }
    return ready;
  }

  /** Claim the session for the caller's token and hold it for the execution; a failure or null. */
  private async handOff(
    sessionUuid: string,
    options: { idleTimeoutMs: number; livenessOwnerToken: string },
  ): Promise<ManagedSlotsFailure | undefined> {
    try {
      const claim = await this.deps.sessions.claimLivenessOwnership(
        sessionUuid,
        options.livenessOwnerToken,
      );
      if (claim !== "claimed") {
        return acquisitionFailure(
          "liveness_owner_conflict",
          `Session ${sessionUuid} could not be claimed for this execution (${claim}).`,
          true,
        );
      }
      await this.deps.sessions.adoptManagedExecutionLivenessPolicy(sessionUuid, {
        idleTimeoutMs: options.idleTimeoutMs,
      });
      return undefined;
    } catch (error) {
      logger.warn(
        `[ManagedSlots] Holding session ${sessionUuid} on the ${MANAGED_EXECUTION_LIVENESS_POLICY} ` +
          `policy failed: ${errorMessage(error)}`,
        error,
      );
      return acquisitionFailure("execution_policy_failed", errorMessage(error), true);
    }
  }

  /** Undo a handed-out session: clear the slot's execution owner and release the session. */
  private async backOut(registry: SlotRegistry, key: SlotKey, sessionUuid: string): Promise<void> {
    const cleanup: ManagedSlotBackOutCleanup = {
      key: { ...key },
      sessionUuid,
      state: "retrying",
      attempts: 0,
      ownerClearOwed: false,
      sessionReleaseOwed: false,
      lastError: "",
    };
    try {
      await registry.releaseExecution(key, sessionUuid);
    } catch (error) {
      cleanup.ownerClearOwed = true;
      cleanup.lastError = errorMessage(error);
      if (!this.closed) {
        logger.warn(
          `[ManagedSlots] Clearing slot ${key.scopeKey}/${key.slotIndex}'s owner ${sessionUuid} failed: ${cleanup.lastError}`,
          error,
        );
      }
    }
    try {
      await this.deps.sessions.releaseSession(sessionUuid);
    } catch (error) {
      cleanup.sessionReleaseOwed = true;
      cleanup.lastError = errorMessage(error);
      if (!this.closed) {
        logger.warn(
          `[ManagedSlots] Releasing backed-out session ${sessionUuid} for slot ${key.scopeKey}/${key.slotIndex} failed: ${cleanup.lastError}`,
          error,
        );
      }
    }
    if (cleanup.ownerClearOwed || cleanup.sessionReleaseOwed) {
      this.retainBackOutCleanup(registry, cleanup);
    }
  }

  /**
   * The owner row is the durable record: it names this process, so all daemons read it dead once
   * this process exits. While it runs, keep owed cleanup here, including after a bounded round
   * gives up: the same task continues slowly, keeping gave_up state and counting attempts.
   * A slow timer failure leaves an inspectable gave_up entry with no task; its row dies with
   * the process. No acquisition re-arms it.
   */
  private retainBackOutCleanup(registry: SlotRegistry, cleanup: ManagedSlotBackOutCleanup): void {
    const id = JSON.stringify([cleanup.key.scopeKey, cleanup.key.slotIndex, cleanup.sessionUuid]);
    if (this.closed) {
      return;
    }
    const existing = this.backOutCleanups.get(id);
    if (existing) {
      existing.cleanup.ownerClearOwed ||= cleanup.ownerClearOwed;
      existing.cleanup.sessionReleaseOwed ||= cleanup.sessionReleaseOwed;
      existing.cleanup.lastError = cleanup.lastError;
      return;
    }
    this.backOutCleanups.set(id, { registry, cleanup });
    this.startBackOutRetry(id, registry, cleanup);
  }

  private startBackOutRetry(
    id: string,
    registry: SlotRegistry,
    cleanup: ManagedSlotBackOutCleanup,
  ): void {
    const round: Promise<void> = this.retryBackOutCleanup(id, registry, cleanup)
      .catch((error: unknown) => {
        // A bounded policy/timer failure gives up once, then the same task continues slowly.
        this.giveUpBackOutCleanup(cleanup, errorMessage(error));
      })
      .then(async () => {
        if (!this.closed && cleanup.state === "gave_up") {
          await this.retryBackOutSlowly(id, registry, cleanup);
        }
      })
      .catch((error: unknown) => {
        // A broken slow timer cannot be redriven safely; keep the row until process exit.
        if (!this.closed) {
          cleanup.lastError = errorMessage(error);
          logger.warn(
            `${this.backOutCleanupLabel(cleanup)} slow retry stopped; no task remains: ${cleanup.lastError}`,
            error,
          );
        }
      })
      .finally(() => this.background.delete(round));
    this.background.add(round);
  }

  private async retryBackOutCleanup(
    id: string,
    registry: SlotRegistry,
    cleanup: ManagedSlotBackOutCleanup,
  ): Promise<void> {
    const backoff = this.deps.backOutRetryBackoff ?? this.retryBackoff;
    const maxAttempts =
      this.deps.backOutRetryMaxAttempts ?? MANAGED_SLOT_BACK_OUT_RETRY_MAX_ATTEMPTS;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.waitForBackOutRetry(backoff.delayForAttempt(attempt));
      if (this.closed) {
        return;
      }
      cleanup.attempts = attempt;
      if (await this.retryBackOutOnce(registry, cleanup)) {
        this.backOutCleanups.delete(id);
        return;
      }
      if (this.closed) {
        return;
      }
    }
    this.giveUpBackOutCleanup(cleanup, cleanup.lastError);
  }

  private async retryBackOutSlowly(
    id: string,
    registry: SlotRegistry,
    cleanup: ManagedSlotBackOutCleanup,
  ): Promise<void> {
    const delayMs = this.deps.backOutRetrySlowPollMs ?? MANAGED_EXECUTION_SETTLEMENT_SLOW_POLL_MS;
    while (!this.closed) {
      await this.waitForBackOutRetry(delayMs);
      if (this.closed) {
        return;
      }
      cleanup.attempts++;
      if (await this.retryBackOutOnce(registry, cleanup)) {
        this.backOutCleanups.delete(id);
        return;
      }
    }
  }

  private waitForBackOutRetry(delayMs: number): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const finish = () => {
        this.deps.timer.clearTimeout(handle);
        this.retryWaits.delete(finish);
        resolve();
      };
      const handle = this.deps.timer.setTimeout(finish, delayMs);
      this.retryWaits.add(finish);
      if (this.closed) {
        finish();
      }
    });
  }

  private async retryBackOutOnce(
    registry: SlotRegistry,
    cleanup: ManagedSlotBackOutCleanup,
  ): Promise<boolean> {
    try {
      if (cleanup.sessionReleaseOwed) {
        await this.deps.sessions.releaseSession(cleanup.sessionUuid);
        if (this.closed) {
          return false;
        }
        cleanup.sessionReleaseOwed = false;
      }
      if (cleanup.ownerClearOwed) {
        const owner = (await registry.getAssignment(cleanup.key))?.execOwner;
        if (this.closed) {
          return false;
        }
        if (owner && this.isBackedOutOwner(owner, cleanup.sessionUuid)) {
          await registry.releaseExecution(cleanup.key, cleanup.sessionUuid);
        }
        if (this.closed) {
          return false;
        }
        cleanup.ownerClearOwed = false;
      }
      return true;
    } catch (error) {
      if (!this.closed) {
        cleanup.lastError = errorMessage(error);
        this.logBackOutRetryFailure(cleanup, error);
      }
      return false;
    }
  }

  private logBackOutRetryFailure(cleanup: ManagedSlotBackOutCleanup, error: unknown): void {
    const message = `${this.backOutCleanupLabel(cleanup)} retry failed: ${cleanup.lastError}`;
    if (cleanup.state === "retrying" && cleanup.attempts === 1) {
      logger.warn(message, error);
    } else {
      // Contention is already warned once; owed work continues in this task.
      logger.debug(message, error);
    }
  }

  private isBackedOutOwner(owner: SlotExecOwner, sessionUuid: string): boolean {
    const current = this.deps.owner();
    const recordedToken = owner.processGenerationToken ?? undefined;
    const currentToken = current.processGenerationToken ?? undefined;
    return (
      owner.sessionUuid === sessionUuid &&
      owner.pid === current.pid &&
      (recordedToken === undefined || currentToken === undefined || recordedToken === currentToken)
    );
  }

  private backOutCleanupLabel(cleanup: ManagedSlotBackOutCleanup): string {
    return `[ManagedSlots] Back-out cleanup for slot ${cleanup.key.scopeKey}/${cleanup.key.slotIndex} session ${cleanup.sessionUuid}`;
  }

  private giveUpBackOutCleanup(cleanup: ManagedSlotBackOutCleanup, lastError: string): void {
    if (!this.closed) {
      cleanup.lastError = lastError;
      cleanup.state = "gave_up";
      logger.warn(
        `${this.backOutCleanupLabel(cleanup)} gave up after ${cleanup.attempts} attempts: ${lastError}; ` +
          `cleanup continues every ${(this.deps.backOutRetrySlowPollMs ?? MANAGED_EXECUTION_SETTLEMENT_SLOW_POLL_MS) / 1_000} s until it lands or the daemon closes`,
      );
    }
  }
}
