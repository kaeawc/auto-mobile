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
 * cleared, session released, the slot keeps its device), so a failed acquisition holds nothing.
 */

import {
  MANAGED_EXECUTION_LIVENESS_POLICY,
  resolveManagedExecutionIdleTimeoutMs,
} from "../managedExecutionLiveness";
import type { ManagedSlotConfig, ManagedSlotRequest } from "../../models/managedSlotConfig";
import type {
  ManagedSlotResultEntry,
  ManagedSlotsFailure,
  ManagedSlotsResult,
} from "../../models/managedSlotsResult";
import { DEFAULT_PROVISION_DEVICE_TIMEOUT_MS } from "../../utils/deviceTimeouts";
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
  type SlotProcessIdentity,
  type SlotRegistry,
  type SlotScopeIdentity,
} from "./slotRegistry";

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
  timer: Pick<Timer, "now">;
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

function acquisitionFailure(
  code: string,
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

export class ManagedSlotAcquisition {
  constructor(private readonly deps: ManagedSlotAcquisitionDependencies) {}

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
    const registry = await this.deps.registry();
    const admission = await this.admitScope(registry, identity);
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
  ): Promise<ScopeAdmission> {
    let ensured = await registry.ensureScope(identity);
    if (ensured.kind === "incarnation_conflict") {
      const previous = ensured.current;
      await registry.beginScopeInvalidation(previous.scopeKey, "incarnation_reset");
      const completed = await registry.completeScopeInvalidation(previous.scopeKey);
      if (completed.kind === "pending") {
        return {
          kind: "failed",
          failure: acquisitionFailure(
            "scope_transition_pending",
            `Runner incarnation '${previous.runnerIncarnation}' of namespace ` +
              `'${previous.runnerNamespace}' still has ${completed.liveOwners.length} live ` +
              `execution(s), ${completed.settling.length} settling and ` +
              `${completed.cleanupPending.length} cleanup-pending slot(s).`,
            true,
          ),
        };
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
    try {
      await registry.releaseExecution(key, sessionUuid);
    } catch (error) {
      // The owner names this daemon's PID and the released session, so the slot frees once the
      // session is gone or this daemon exits; log it so a stuck slot has a trace.
      logger.warn(
        `[ManagedSlots] Clearing slot ${key.slotIndex}'s owner ${sessionUuid} failed: ${errorMessage(error)}`,
        error,
      );
    }
    try {
      await this.deps.sessions.releaseSession(sessionUuid);
    } catch (error) {
      logger.warn(
        `[ManagedSlots] Releasing backed-out session ${sessionUuid} failed: ${errorMessage(error)}`,
        error,
      );
    }
  }
}
