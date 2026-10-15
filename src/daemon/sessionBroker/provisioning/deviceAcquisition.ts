/**
 * The broker's native-device acquisition (epic #11172, #11173 part b).
 *
 * A stdio proxy launched with a binding config calls this before it answers `initialize`. One
 * acquisition:
 *
 * 1. Admits the runner scope. A new incarnation of a known `(host, namespace)` transitions
 *    implicitly (owner decision Q2): the old scope is moved to `invalidating`, and completed once
 *    its live owners and pending cleanup have settled; until then the acquisition fails retryable
 *    `scope_transition_pending`. An abandoned scope whose incarnation returns is revived by the
 *    registry. A reset incarnation fails `scope_invalidated` for good.
 * 2. Reconciles every requested binding to its spec, claiming the binding for this daemon's execution
 *    atomically with the outcome (reused / adopted / created / replaced).
 * 3. Hands each binding's fresh session to the caller: liveness ownership is claimed for the caller's
 *    owner token at once (so nothing can take it before the proxy's first heartbeat), and the
 *    session goes on the `managed-execution` policy with the config's idle window (owner decision
 *    Q1: configurable, 2-minute default).
 *
 * Any failure after a session was handed out backs that session out again (binding execution owner
 * cleared, session released, the binding keeps its device). Unfinished cleanup is retained and retried
 * in the background at 25 ms doubling to 1 s, with shared quiet time after a blocked attempt
 * (up to 5 s), until it lands or the daemon closes; a failed
 * acquisition never waits for these retries.
 */

import { classifySqliteError } from "../../../db/databaseFailureClassification";
import { BindingDiscoveryIncompleteError, BindingRegistrySchemaUnsupportedError } from "./refusal";
import { failure as reconcileFailure } from "./reconciler";
import {
  MANAGED_EXECUTION_LIVENESS_POLICY,
  resolveManagedExecutionIdleTimeoutMs,
} from "./executionLiveness";
import type { BrokerProvisionRequest, BrokerDeviceRequest } from "./provisionRequest";
import type {
  BindingResultEntry,
  BindingsFailure,
  BrokerDeviceAcquisitionOwnFailureCode,
  BindingsResult,
} from "./acquisitionResult";
import { DEFAULT_PROVISION_DEVICE_TIMEOUT_MS } from "../../../utils/deviceTimeouts";
import type { BackoffPolicy } from "../../../utils/Backoff";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { Timer } from "../../../utils/SystemTimer";
import {
  RegistryRetryPacing,
  REGISTRY_RETRY_INITIAL_DELAY_MS,
  REGISTRY_RETRY_MAX_DELAY_MS,
  REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS,
} from "../registry/registryRetryPacing";
import { MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS } from "./executionRelease";
import type {
  BindingReconcileRequest,
  BindingReconcileResult,
  BindingRequestedSpec,
} from "./reconciler";
import {
  computeBindingScopeKey,
  type BindingKey,
  type BindingExecOwner,
  type BindingProcessIdentity,
  type BindingRegistry,
  type BindingScopeIdentity,
  type BindingScopeRecord,
} from "../registry/bindingRegistry";
import {
  BINDING_SCOPE_RESET_DEFAULT_WAIT_MS,
  type BindingScopeResetScopeResult,
} from "./scopeReset";

export interface BrokerDeviceAcquisitionSessions {
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
  /** Release a session this acquisition handed out but could not complete (device kept by binding). */
  releaseSession(sessionId: string): Promise<void>;
}

export interface BrokerDeviceAcquisitionDependencies {
  registry: () => Promise<BindingRegistry>;
  /** The reconciler bound to the same registry (production: real inventory/provision/delete). */
  reconcile: (
    registry: BindingRegistry,
    request: BindingReconcileRequest,
  ) => Promise<BindingReconcileResult>;
  sessions: BrokerDeviceAcquisitionSessions;
  /** This daemon, recorded as the bindings' execution owner. */
  owner: () => BindingProcessIdentity;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  backOutRetryBackoff?: BackoffPolicy;
  /**
   * The implicit reset of a superseded incarnation (`BindingScopeReset.resetSupersededScope`, #11174):
   * waits up to `waitMs` for the old scope's owners and cleanup to settle. Absent, or returning
   * undefined (no reset wired), the acquisition checks the old scope once without waiting.
   */
  resetSupersededScope?: (
    scope: BindingScopeRecord,
    waitMs: number,
  ) => Promise<Pick<BindingScopeResetScopeResult, "outcome" | "pending">> | undefined;
}

export interface BrokerDeviceAcquireOptions {
  /** The proxy's liveness owner token; the binding sessions are claimed for it. */
  livenessOwnerToken: string;
  signal?: AbortSignal;
}

const ACQUISITION_NEXT_ACTION: Readonly<Record<string, string>> = {
  registry_schema_unsupported:
    "Upgrade this daemon and every daemon sharing the registry to the build that migrated it, restarting older daemons; nothing was changed.",
  scope_invalidated:
    "This runner incarnation was reset; launch with the current runnerIncarnation.",
  scope_transition_pending:
    "Wait for the previous runner incarnation's executions and cleanup to settle, then retry.",
  execution_policy_failed: "Retry; the session could not be held for the execution.",
  liveness_owner_conflict: "Retry; another owner claimed the binding's session.",
  timeout: "Retry with a longer preparationTimeoutMs.",
  cancelled: "The preparation was cancelled; retry when needed.",
};

export function acquisitionFailure(
  code: BrokerDeviceAcquisitionOwnFailureCode,
  message: string,
  retryable: boolean,
): BindingsFailure {
  return {
    code,
    retryable,
    message,
    nextAction: ACQUISITION_NEXT_ACTION[code] ?? "Retry.",
  };
}

interface BindingPreparationOptions {
  deadlineMs: number;
  idleTimeoutMs: number;
  livenessOwnerToken: string;
  signal?: AbortSignal;
}

type ScopeAdmission =
  | { kind: "ready"; scopeKey: string; revived: boolean }
  | { kind: "failed"; failure: BindingsFailure };

export const BINDING_BACK_OUT_RETRY_INITIAL_DELAY_MS = REGISTRY_RETRY_INITIAL_DELAY_MS;
export const BINDING_BACK_OUT_RETRY_MAX_DELAY_MS = REGISTRY_RETRY_MAX_DELAY_MS;
/** The longest wait after an attempt that itself blocked. */
export const BINDING_BACK_OUT_RETRY_MAX_BLOCKED_WAIT_MS = REGISTRY_RETRY_MAX_BLOCKED_WAIT_MS;
/** A cleanup owed longer than this is warned about once: the registry has been unwritable that long. */
export const BINDING_BACK_OUT_OWED_WARN_AFTER_MS = 5_000;

/** Owed cleanup, retried until it lands or the daemon closes. */
export interface BindingBackOutCleanup {
  key: BindingKey;
  sessionUuid: string;
  /** Background retries made so far (the inline attempt is not counted). */
  attempts: number;
  /** `timer.now()` when the inline attempt failed. */
  owedSinceMs: number;
  /** `timer.now() - owedSinceMs` at the time of the `pendingBackOutCleanups()` call. */
  ageMs: number;
  ownerClearOwed: boolean;
  sessionReleaseOwed: boolean;
  lastError: string;
}

export class BrokerDeviceAcquisition {
  private closed = false;
  private readonly closeController = new AbortController();
  private readonly backOutSessionReleases = new WeakMap<BindingBackOutCleanup, Promise<void>>();
  private readonly backOutOwnerReads = new WeakMap<
    BindingBackOutCleanup,
    ReturnType<BindingRegistry["getAssignment"]>
  >();
  private readonly backOutOwnerClears = new WeakMap<
    BindingBackOutCleanup,
    ReturnType<BindingRegistry["releaseExecution"]>
  >();
  private readonly pacing: RegistryRetryPacing;
  private readonly backOutCleanups = new Map<
    string,
    { registry: BindingRegistry; cleanup: BindingBackOutCleanup }
  >();
  private readonly background = new Set<Promise<void>>();
  private readonly warnedBackOutCleanups = new WeakSet<BindingBackOutCleanup>();
  constructor(private readonly deps: BrokerDeviceAcquisitionDependencies) {
    this.pacing = new RegistryRetryPacing({
      timer: deps.timer,
      backoff: deps.backOutRetryBackoff,
    });
  }

  /** Stop waits immediately; outstanding owner rows become dead when this process exits. */
  close(): void {
    this.closed = true;
    this.closeController.abort();
    this.pacing.close();
  }

  /** Wait until no background task runs; owed cleanup ends on landing or close. */
  async whenIdle(): Promise<void> {
    while (this.background.size > 0) {
      await Promise.allSettled([...this.background]);
    }
  }

  pendingBackOutCleanups(): readonly BindingBackOutCleanup[] {
    return [...this.backOutCleanups.values()].map(({ cleanup }) => ({
      ...cleanup,
      key: { ...cleanup.key },
      ageMs: this.deps.timer.now() - cleanup.owedSinceMs,
    }));
  }

  async acquire(
    config: BrokerProvisionRequest,
    options: BrokerDeviceAcquireOptions,
  ): Promise<BindingsResult> {
    const identity: BindingScopeIdentity = {
      managedHostScope: config.managedHostScope,
      runnerNamespace: config.runnerNamespace,
      runnerIncarnation: config.runnerIncarnation,
    };
    const base = (
      scopeKey: string | null,
      revived?: boolean,
    ): Omit<BindingsResult, "outcome" | "bindings"> => ({
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
        bindings: [],
        failure: acquisitionFailure("binding_config_invalid", errorMessage(error), false),
      };
    }
    const deadlineMs =
      this.deps.timer.now() + (config.preparationTimeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS);
    let registry: BindingRegistry;
    let admission: ScopeAdmission;
    try {
      registry = await this.deps.registry();
      admission = await this.admitScope(registry, identity, deadlineMs);
    } catch (error) {
      if (error instanceof BindingRegistrySchemaUnsupportedError) {
        logger.warn(`[Bindings] Registry schema unsupported: ${errorMessage(error)}`, error);
        return {
          ...base(null),
          outcome: "failed",
          bindings: [],
          failure: acquisitionFailure(error.code, errorMessage(error), error.retryable),
        };
      }
      if (
        classifySqliteError(error) !== "retryable" &&
        !(error instanceof BindingDiscoveryIncompleteError)
      ) {
        throw error;
      }
      // Nothing has been handed out yet; the client can retry the whole scope admission.
      return {
        ...base(computeBindingScopeKey(identity)),
        outcome: "failed",
        bindings: [],
        failure: reconcileFailure("discovery_incomplete", errorMessage(error)),
      };
    }
    if (admission.kind === "failed") {
      return {
        ...base(computeBindingScopeKey(identity)),
        outcome: "failed",
        bindings: [],
        failure: admission.failure,
      };
    }
    const { bindings, failure } = await this.acquireBindings(
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
      bindings,
      ...(failure ? { failure } : {}),
    };
  }

  /** Acquire every binding, all or nothing: a partially acquired group holds no session. */
  private async acquireBindings(
    registry: BindingRegistry,
    scopeKey: string,
    requests: readonly BrokerDeviceRequest[],
    options: BindingPreparationOptions,
  ): Promise<{ bindings: BindingResultEntry[]; failure: BindingsFailure | undefined }> {
    const bindings: BindingResultEntry[] = [];
    const handedOut: { key: BindingKey; sessionUuid: string }[] = [];
    let failure: BindingsFailure | undefined;
    for (const request of requests) {
      const key: BindingKey = { scopeKey, bindingIndex: request.bindingIndex };
      const entry = await this.acquireBinding(registry, key, request, options);
      bindings.push(entry);
      if (entry.failure) {
        failure = entry.failure;
        break;
      }
      handedOut.push({ key, sessionUuid: entry.sessionUuid! });
    }
    if (!failure && options.signal?.aborted) {
      // The caller went away while the last binding was prepared: nobody will hold these sessions.
      failure = acquisitionFailure("cancelled", "The binding acquisition was cancelled.", true);
    }
    if (failure) {
      await Promise.all(
        handedOut.map(({ key, sessionUuid }) => this.backOut(registry, key, sessionUuid)),
      );
      for (const binding of bindings) {
        if (!binding.failure) {
          binding.sessionUuid = null;
        }
      }
    }
    return { bindings, failure };
  }

  /**
   * Admit the scope, transitioning implicitly from an older incarnation of the same namespace once
   * that incarnation has settled (owner decision Q2).
   */
  private async admitScope(
    registry: BindingRegistry,
    identity: BindingScopeIdentity,
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
            `[Bindings] Revived abandoned scope ${ensured.scope.scopeKey} ` +
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
    registry: BindingRegistry,
    previous: BindingScopeRecord,
    deadlineMs: number,
  ): Promise<BindingsFailure | undefined> {
    const waitMs = Math.max(
      0,
      Math.min(BINDING_SCOPE_RESET_DEFAULT_WAIT_MS, deadlineMs - this.deps.timer.now()),
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
        `${waiting.cleanupPending} cleanup-pending binding(s).`,
      true,
    );
  }

  private async acquireBinding(
    registry: BindingRegistry,
    key: BindingKey,
    request: BrokerDeviceRequest,
    options: BindingPreparationOptions,
  ): Promise<BindingResultEntry> {
    const result = await this.deps.reconcile(registry, {
      key,
      role: request.role,
      platform: request.platform,
      requestedSpec: request.requestedSpec as BindingRequestedSpec,
      ...(request.priorDeviceHint ? { priorDeviceHint: request.priorDeviceHint } : {}),
      deadlineMs: options.deadlineMs,
      signal: options.signal,
      owner: this.deps.owner(),
    });
    if (result.outcome === "failed") {
      return {
        bindingIndex: request.bindingIndex,
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
    const ready: BindingResultEntry = {
      bindingIndex: request.bindingIndex,
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
  ): Promise<BindingsFailure | undefined> {
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
        `[Bindings] Holding session ${sessionUuid} on the ${MANAGED_EXECUTION_LIVENESS_POLICY} ` +
          `policy failed: ${errorMessage(error)}`,
        error,
      );
      return acquisitionFailure("execution_policy_failed", errorMessage(error), true);
    }
  }

  /** Undo a handed-out session: clear the binding's execution owner and release the session. */
  private async backOut(
    registry: BindingRegistry,
    key: BindingKey,
    sessionUuid: string,
  ): Promise<void> {
    const startedMs = this.deps.timer.now();
    const cleanup: BindingBackOutCleanup = {
      key: { ...key },
      sessionUuid,
      attempts: 0,
      owedSinceMs: this.deps.timer.now(),
      ageMs: 0,
      ownerClearOwed: false,
      sessionReleaseOwed: false,
      lastError: "",
    };
    try {
      await registry.releaseExecution(key, sessionUuid);
    } catch (error) {
      cleanup.owedSinceMs = this.deps.timer.now();
      cleanup.ownerClearOwed = true;
      cleanup.lastError = errorMessage(error);
      if (!this.closed) {
        logger.info(
          `[Bindings] Clearing binding ${key.scopeKey}/${key.bindingIndex}'s owner ${sessionUuid} failed: ${cleanup.lastError}; cleanup continues in the background`,
          error,
        );
      }
    }
    try {
      await this.deps.sessions.releaseSession(sessionUuid);
    } catch (error) {
      if (!cleanup.ownerClearOwed) {
        cleanup.owedSinceMs = this.deps.timer.now();
      }
      cleanup.sessionReleaseOwed = true;
      cleanup.lastError = errorMessage(error);
      if (!this.closed) {
        logger.info(
          `[Bindings] Releasing backed-out session ${sessionUuid} for binding ${key.scopeKey}/${key.bindingIndex} failed: ${cleanup.lastError}; cleanup continues in the background`,
          error,
        );
      }
    }
    if (cleanup.ownerClearOwed || cleanup.sessionReleaseOwed) {
      this.retainBackOutCleanup(registry, cleanup);
      this.pacing.noteBlocked(startedMs);
    }
  }

  /**
   * Keep each owed cleanup in one task, sharing quiet time after blocked attempts, capped at 5 s.
   * A timer failure leaves an inspectable entry with no task; no acquisition re-arms it.
   * The owner row names this process and becomes dead when the process exits.
   */
  private retainBackOutCleanup(registry: BindingRegistry, cleanup: BindingBackOutCleanup): void {
    const id = JSON.stringify([
      cleanup.key.scopeKey,
      cleanup.key.bindingIndex,
      cleanup.sessionUuid,
    ]);
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
    registry: BindingRegistry,
    cleanup: BindingBackOutCleanup,
  ): void {
    const round: Promise<void> = this.retryBackOutCleanup(id, registry, cleanup)
      .catch((error: unknown) => {
        // A broken timer cannot be redriven safely; keep the row until process exit.
        if (!this.closed) {
          cleanup.lastError = errorMessage(error);
          logger.warn(
            `${this.backOutCleanupLabel(cleanup)} retry stopped; no task remains: ${cleanup.lastError}`,
            error,
          );
        }
      })
      .finally(() => this.background.delete(round));
    this.background.add(round);
  }

  private async retryBackOutCleanup(
    id: string,
    registry: BindingRegistry,
    cleanup: BindingBackOutCleanup,
  ): Promise<void> {
    for (let attempt = 1; !this.closed; attempt++) {
      await this.pacing.wait(this.pacing.delay(attempt));
      if (this.closed) {
        return;
      }
      const landed = await this.pacing.run(
        () => {
          cleanup.attempts = attempt;
          return this.retryBackOutOnce(registry, cleanup);
        },
        (result) => result,
      );
      if (landed) {
        this.backOutCleanups.delete(id);
        if (!this.closed) {
          logger.info(
            `${this.backOutCleanupLabel(cleanup)} landed after ${this.deps.timer.now() - cleanup.owedSinceMs} ms (${cleanup.attempts} retries)`,
          );
        }
        return;
      }
      if (this.closed) {
        return;
      }
    }
  }

  private async retryBackOutOnce(
    registry: BindingRegistry,
    cleanup: BindingBackOutCleanup,
  ): Promise<boolean> {
    const deadlineMs = this.deps.timer.now() + MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS;
    try {
      if (cleanup.sessionReleaseOwed) {
        await this.retryBackOutStep(
          cleanup,
          this.backOutSessionReleases,
          () => this.deps.sessions.releaseSession(cleanup.sessionUuid),
          "session release",
          deadlineMs,
        );
        if (this.closed) {
          return false;
        }
        cleanup.sessionReleaseOwed = false;
      }
      if (cleanup.ownerClearOwed) {
        await this.retryBackOutOwnerClear(registry, cleanup, deadlineMs);
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

  private async retryBackOutStep<T>(
    cleanup: BindingBackOutCleanup,
    inFlight: WeakMap<BindingBackOutCleanup, Promise<T>>,
    start: () => Promise<T>,
    step: string,
    deadlineMs: number,
  ): Promise<T> {
    const remainingMs = deadlineMs - this.deps.timer.now();
    if (remainingMs <= 0) {
      throw new Error(`${this.backOutCleanupLabel(cleanup)} ${step} attempt deadline reached`);
    }
    const result = await raceWithDeadline(
      () => {
        let operation = inFlight.get(cleanup);
        if (!operation) {
          operation = start().then(undefined, (error: unknown) => {
            // Propagate to the deadline race, which also observes late rejections.
            inFlight.delete(cleanup);
            throw error;
          });
          inFlight.set(cleanup, operation);
        }
        return operation;
      },
      {
        timer: this.deps.timer,
        timeoutMs: remainingMs,
        signal: this.closeController.signal,
        label: `${this.backOutCleanupLabel(cleanup)} ${step}`,
      },
    );
    inFlight.delete(cleanup);
    return result;
  }

  private async retryBackOutOwnerClear(
    registry: BindingRegistry,
    cleanup: BindingBackOutCleanup,
    deadlineMs: number,
  ): Promise<void> {
    const clear = () =>
      this.retryBackOutStep(
        cleanup,
        this.backOutOwnerClears,
        () => registry.releaseExecution(cleanup.key, cleanup.sessionUuid),
        "owner clear",
        deadlineMs,
      );
    if (this.backOutOwnerClears.has(cleanup)) {
      await clear();
      return;
    }
    const read = () =>
      this.retryBackOutStep(
        cleanup,
        this.backOutOwnerReads,
        () => registry.getAssignment(cleanup.key),
        "ownership read",
        deadlineMs,
      );
    if (this.backOutOwnerReads.has(cleanup)) {
      // An abandoned read may describe an older owner; consume it without using its result.
      await read();
    }
    const owner = (await read())?.execOwner;
    if (!this.closed && owner && this.isBackedOutOwner(owner, cleanup.sessionUuid)) {
      await clear();
    }
  }

  private logBackOutRetryFailure(cleanup: BindingBackOutCleanup, error: unknown): void {
    const message = `${this.backOutCleanupLabel(cleanup)} retry failed: ${cleanup.lastError}`;
    // Shared-registry contention is expected; the task keeps the owed cleanup and retries it.
    logger.debug(message, error);
    const ageMs = this.deps.timer.now() - cleanup.owedSinceMs;
    if (ageMs > BINDING_BACK_OUT_OWED_WARN_AFTER_MS && !this.warnedBackOutCleanups.has(cleanup)) {
      this.warnedBackOutCleanups.add(cleanup);
      logger.warn(
        `${this.backOutCleanupLabel(cleanup)} owed for ${ageMs} ms (${cleanup.attempts} retries): ${cleanup.lastError}; retries continue with waits capped at 5 s`,
        error,
      );
    }
  }

  private isBackedOutOwner(owner: BindingExecOwner, sessionUuid: string): boolean {
    const current = this.deps.owner();
    const recordedToken = owner.processGenerationToken ?? undefined;
    const currentToken = current.processGenerationToken ?? undefined;
    return (
      owner.sessionUuid === sessionUuid &&
      owner.pid === current.pid &&
      (recordedToken === undefined || currentToken === undefined || recordedToken === currentToken)
    );
  }

  private backOutCleanupLabel(cleanup: BindingBackOutCleanup): string {
    return `[Bindings] Back-out cleanup for binding ${cleanup.key.scopeKey}/${cleanup.key.bindingIndex} session ${cleanup.sessionUuid}`;
  }
}
