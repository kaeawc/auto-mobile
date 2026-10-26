import { poolMatcher } from "./brokerPoolMatch";
import { RecoveryCleanup, type RecoveryCleanupItem } from "./RecoveryCleanup";
import {
  abortedByBrokerStop,
  failedResult,
  failureFor,
  preparationFailureError,
  sameProcess,
  storedBrokerFailure,
  unwrap,
} from "./brokerSupport";
import { CommittedReceiptReadError } from "./CommittedReceiptReadError";
import { classifyCleanReleaseError } from "./cleanReleaseFailure";
import { SessionBrokerStoppingError } from "./SessionBrokerStoppingError";
import {
  normalizeSessionDeviceRequirement,
  resolveSessionDeviceProfile,
} from "../../devices/sessionRequirements";
import { ActionableError } from "../../models/ActionableError";
import type { SessionConfig } from "../../devices/sessionConfig";
import {
  SESSION_OWNER_EXITED_CODE,
  SESSION_OWNER_EXITED_MESSAGE,
  type SessionBrokerFailure,
  type SessionBrokerReleaseReason,
  type SessionBrokerReleaseResult,
  type SessionBrokerResult,
  type SessionBrokerStats,
} from "../../devices/sessionBrokerResult";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { defaultTimer } from "../../utils/SystemTimer";
import { readBrokerTimingStats } from "./timingStats";
import { RECEIPT_RETENTION_MS } from "./retention";
import { BrokerTimingRecorder } from "./timingRecorder";
import { BrokerResetRelease } from "./resetRelease";
import { ResetReadiness } from "./resetReadiness";
import { SessionBrokerFailureError } from "./devicePort";
import { assertDeviceProfileEmulatable, requestedDeviceProfile } from "./deviceProfile";
import type { SessionBrokerOptions } from "./brokerOptions";
import { nativeProfile } from "./profile";
import { boundedReleaseReply, trackRelease, type TrackedRelease } from "./releaseReply";
import { SESSION_REQUEST_ABANDONED_CODE, sessionRequestFingerprint } from "./requestIdentity";
import {
  destructionTicket,
  EXPORT_RETENTION_MS,
  SessionExportIdentityMismatchError,
  type BrokerExportIdentity,
  type BrokerAdmission,
  type BrokerAdmissionInput,
  type BrokerRequestRecord,
  type BrokerResourceRecord,
  type DestructionTicket,
} from "./store";

export type { SessionBrokerOptions } from "./brokerOptions";

export { EXPORT_RETENTION_MS } from "./store";
export { SESSION_BROKER_RELEASE_REPLY_BUDGET_MS } from "./releaseReply";

export { RECEIPT_RETENTION_MS } from "./retention";
/** Rows deleted per retention call, so one pass never holds the write lock for long. */
export const RECEIPT_PRUNE_BATCH = 500;

/**
 * Owns one acquisition-to-release lifecycle behind the consumer's fresh session UUID.
 * Requests are reserved before native work. Every unsuccessful acquisition becomes terminal and
 * leaves durable cleanup; no retry or restart silently gives its identity a different session.
 *
 * The service explicitly drives recovery. Native items that outlive a bounded pass retain
 * broker ownership until they settle; close aborts/joins them through the native journal seam.
 */
export class SessionBroker {
  private readonly releases = new Map<string, TrackedRelease>();
  private readonly preparations = new Map<string, number>();
  private readonly preparationOwners = new Map<
    Promise<SessionBrokerResult>,
    { controller: AbortController; requestId: string }
  >();
  private stopping = false;

  private readonly cleanup: RecoveryCleanup;
  private readonly destroys = new Map<string, Promise<void>>();
  /** A stop leaves them durable for the successor. */
  private readonly queuedRecoveryReleases = new Set<string>();
  private readonly timing: BrokerTimingRecorder;
  private readonly resetRelease: BrokerResetRelease;
  private readonly resetReadiness: ResetReadiness;

  constructor(private readonly options: SessionBrokerOptions) {
    this.cleanup = new RecoveryCleanup(
      options.cleanupConcurrency,
      options.cleanupWaitMs,
      options.timer,
    );
    this.timing = new BrokerTimingRecorder(options.store, { now: () => this.now() });
    this.resetReadiness = new ResetReadiness(options.store, {
      now: () => this.now(),
      setTimeout: (callback, ms) => (options.timer ?? defaultTimer).setTimeout(callback, ms),
      clearTimeout: (handle) => (options.timer ?? defaultTimer).clearTimeout(handle),
    });
    this.resetRelease = new BrokerResetRelease(
      options,
      this.timing,
      () => this.now(),
      (ticket, signal) => this.tryCleanup(ticket, signal),
      (resourceId) => this.resetReadiness.notify(resourceId),
      (resourceId, active) => this.resetReadiness.setResetActive(resourceId, active),
    );
  }

  private now(): number {
    return this.options.timer?.now?.() ?? defaultTimer.now();
  }

  stats(windowMs = 24 * 60 * 60 * 1000, limit = 5000): Promise<SessionBrokerStats> {
    return readBrokerTimingStats(this.options.store, () => this.now(), windowMs, limit);
  }

  prepare(
    config: SessionConfig,
    livenessOwnerToken: string,
    signal?: AbortSignal,
    exportIdentity?: BrokerExportIdentity,
  ): Promise<SessionBrokerResult> {
    if (this.stopping) {
      // Refuse before prepareOnce/failureFor: no terminal receipt prevents a successor retry.
      return Promise.reject(new SessionBrokerStoppingError());
    }
    const controller = new AbortController();
    const ownedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const pending = this.prepareOnce(config, livenessOwnerToken, ownedSignal, exportIdentity);
    this.preparationOwners.set(pending, { controller, requestId: config.requestId });
    void pending.then(
      () => this.preparationOwners.delete(pending),
      () => this.preparationOwners.delete(pending),
    );
    return pending;
  }

  private async prepareOnce(
    config: SessionConfig,
    livenessOwnerToken: string,
    signal: AbortSignal,
    exportIdentity?: BrokerExportIdentity,
  ): Promise<SessionBrokerResult> {
    let admitted = false;
    const startedAtMs = this.now();
    const fingerprint = sessionRequestFingerprint(config, livenessOwnerToken);
    this.preparations.set(config.requestId, (this.preparations.get(config.requestId) ?? 0) + 1);
    try {
      const previous = await this.options.store.getRequest(config.requestId);
      if (previous) {
        return this.replay(previous, {
          config,
          fingerprint,
          livenessOwnerToken,
          signal,
          exportIdentity,
        });
      }
      const input = await this.admissionInput(config, fingerprint, signal, exportIdentity);
      input.timingStartedAtMs = startedAtMs;
      if (this.options.reuseCleanDevices && config.device.platform === "ios") {
        input.resetReadiness = await this.resetReadiness.snapshot(input.matches);
      }
      const admission = await this.options.store.admit(input);
      if (admission.kind === "existing" || admission.kind === "refused") {
        return this.resultUnlessAborted(admission.request, signal);
      }
      admitted = true;
      return await this.prepareAdmission(admission, input, config, livenessOwnerToken, signal);
    } catch (error) {
      if (error instanceof SessionExportIdentityMismatchError) {
        throw error;
      }
      if (error instanceof CommittedReceiptReadError) {
        logger.warn(error.message, error.cause);
        throw error;
      }
      if (!admitted && abortedByBrokerStop(signal)) {
        // Shutdown before admission is expected and leaves the identity free for a successor.
        logger.debug(`Session request ${config.requestId} refused while stopping`, error);
        throw new SessionBrokerStoppingError();
      }
      logger.warn(
        `Session request ${config.requestId} preparation failed: ${errorMessage(error)}`,
        error,
      );
      return this.handlePreparationFailure(
        config,
        livenessOwnerToken,
        fingerprint,
        admitted,
        preparationFailureError(error, signal),
        exportIdentity,
      );
    } finally {
      this.finishPreparation(config.requestId);
    }
  }

  private async handlePreparationFailure(
    config: SessionConfig,
    livenessOwnerToken: string,
    fingerprint: string,
    admitted: boolean,
    error: unknown,
    exportIdentity?: BrokerExportIdentity,
  ): Promise<SessionBrokerResult> {
    const failure = failureFor(error);
    if (admitted) {
      return this.failAdmittedPreparation(config, failure);
    }
    // Retain pre-admission failures: a catalog change must not give replay a new acquisition.
    // An independently committed receipt wins; never overwrite an acquisition from a sibling
    // caller. A persistence failure is an RPC error, not a claimed durable terminal result.
    const independentlyCommitted = await this.options.store.getRequest(config.requestId);
    if (
      independentlyCommitted?.errorCode === SESSION_REQUEST_ABANDONED_CODE &&
      this.consumerOwns(independentlyCommitted, livenessOwnerToken)
    ) {
      if (exportIdentity) {
        await this.options.store.linkRequestExport(
          config.requestId,
          independentlyCommitted.fingerprint,
          exportIdentity,
        );
      }
      return this.result(independentlyCommitted);
    }
    const receipt = await this.options.store.recordPreAdmissionFailure(
      {
        requestId: config.requestId,
        fingerprint,
        parameters: config,
        owner: this.options.owner,
        export: exportIdentity,
      },
      failure,
    );
    return this.result(receipt);
  }

  private async failAdmittedPreparation(
    config: SessionConfig,
    failure: SessionBrokerFailure,
  ): Promise<SessionBrokerResult> {
    const ticket = await this.options.store.fail(
      config.requestId,
      this.options.owner,
      failure.message,
      failure.code,
      failure.retryable,
    );
    if (ticket) {
      await this.tryCleanup(ticket);
    }
    const request = await this.options.store.getRequest(config.requestId);
    if (!request) {
      throw new ActionableError(
        "Admitted session request lost its durable receipt; cleanup cannot be acknowledged",
      );
    }
    await this.timing.recordFailedAcquisition(request);
    const result = await this.result(request);
    return request.errorCode === SESSION_REQUEST_ABANDONED_CODE
      ? result
      : {
          ...result,
          failure: {
            ...failure,
            retryable: Boolean(result.failure?.retryable),
            // The stored receipt owns retry guidance, so the first reply matches every replay.
            ...(result.failure?.retryAfterMs !== undefined
              ? { retryAfterMs: result.failure.retryAfterMs }
              : {}),
            ...(result.failure?.retryRequires
              ? { retryRequires: result.failure.retryRequires }
              : {}),
          },
        };
  }

  private finishPreparation(requestId: string): void {
    const remaining = (this.preparations.get(requestId) ?? 1) - 1;
    if (remaining === 0) {
      this.resetReadiness.releaseWait(requestId);
      this.preparations.delete(requestId);
    } else {
      this.preparations.set(requestId, remaining);
    }
  }

  /** Receipt replay does not depend on today's runtime catalog or default configuration. */
  private async replay(
    previous: BrokerRequestRecord,
    context: {
      config: SessionConfig;
      fingerprint: string;
      livenessOwnerToken: string;
      signal: AbortSignal;
      exportIdentity?: BrokerExportIdentity;
    },
  ): Promise<SessionBrokerResult> {
    const { config, fingerprint, livenessOwnerToken, signal, exportIdentity } = context;
    const ownedAbandonment =
      previous.errorCode === SESSION_REQUEST_ABANDONED_CODE &&
      this.consumerOwns(previous, livenessOwnerToken);
    if (previous.fingerprint !== fingerprint && !ownedAbandonment) {
      return failedResult(
        config,
        failureFor(
          new ActionableError(
            "Session request identity was already used with different parameters",
          ),
        ),
      );
    }
    if (exportIdentity) {
      await this.options.store.linkRequestExport(
        previous.requestId,
        previous.fingerprint,
        exportIdentity,
      );
    }
    return this.resultUnlessAborted(previous, signal);
  }

  private async admissionInput(
    config: SessionConfig,
    fingerprint: string,
    signal: AbortSignal,
    exportIdentity?: BrokerExportIdentity,
  ): Promise<BrokerAdmissionInput> {
    signal.throwIfAborted();
    const catalog = await this.options.catalog(config.device.platform, signal);
    const defaults = this.options.defaults(config.device.platform);
    const capabilities = this.options.capabilities ?? {};
    const requirement = unwrap(
      normalizeSessionDeviceRequirement(config.device, defaults, catalog, capabilities),
    );
    assertDeviceProfileEmulatable(requestedDeviceProfile(config));
    return {
      requestId: config.requestId,
      fingerprint,
      parameters: config,
      owner: this.options.owner,
      export: exportIdentity,
      limits: this.options.limits,
      matches: poolMatcher(requirement, defaults),
      resolveCreation: () =>
        unwrap(resolveSessionDeviceProfile(requirement, defaults, catalog, capabilities)),
    };
  }

  private async prepareAdmission(
    initial: BrokerAdmission,
    input: BrokerAdmissionInput,
    config: SessionConfig,
    livenessOwnerToken: string,
    signal: AbortSignal,
  ): Promise<SessionBrokerResult> {
    const waited = await this.resetReadiness.continueAfterWait(
      initial,
      input,
      config.preparationTimeoutMs,
      signal,
    );
    let admission = waited.admission;
    const preparationTimeoutMs = waited.preparationTimeoutMs;
    // Each eviction removes a distinct idle resource. No creation reservation is made until
    // the existing journal confirms that device's absence.
    while (admission.kind === "evict") {
      const destroyed = await this.destroy(admission.resource).catch((error: unknown) => {
        if (classifyCleanReleaseError(error) !== "retryable") {
          throw error;
        }
        // The durable destroying row retains capacity until recovery confirms absence.
        logger.warn(`Device eviction remains pending: ${errorMessage(error)}`, error);
        return false;
      });
      if (!destroyed) {
        // A new request ID may evict the next idle device during this destroy, bounded by pool size.
        throw new SessionBrokerFailureError({
          code: "eviction_pending",
          message: "Device eviction remains unresolved; its capacity is still reserved",
          retryable: true,
          retryAfterMs: 1_000,
        });
      }
      signal.throwIfAborted();
      admission = await this.options.store.continueAdmission(input);
    }
    await this.timing.recordRefusedAdmission(admission);
    if (
      admission.kind === "refused" ||
      admission.kind === "existing" ||
      admission.kind === "wait"
    ) {
      return this.result(admission.request);
    }
    signal.throwIfAborted();
    const prepared = await this.options.devices.prepare(admission.resource, {
      livenessOwnerToken,
      signal,
      preparationTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
      executionOwnerPid: config.executionOwnerPid,
      deviceProfile: requestedDeviceProfile(config),
    });
    signal.throwIfAborted();
    const request = await this.options.store.activate(
      config.requestId,
      this.options.owner,
      prepared.sessionId,
      prepared.timing,
    );
    if (this.stopping) {
      try {
        // The first shutdown snapshot can precede this activation commit. Mark it before
        // returning, even while shutdown is still joining recovery or other preparations.
        await this.options.store.relinquishForRestart(config.requestId, this.options.owner);
      } catch (error) {
        // Activation already committed; a failed handoff must not fail or destroy its grant.
        logger.warn(
          `Session request ${config.requestId} could not be kept for restart: ${errorMessage(error)}`,
          error,
        );
      }
    }
    // Activation committed: the session now belongs to the request identity. A caller abort from
    // here on hands it back for a replay of that identity instead of destroying it; the session's
    // own liveness policy releases it if the caller never returns. Abandonment is separate and
    // durable, so an aborted caller re-reads the receipt rather than reporting a stale one.
    try {
      this.timing.logReadyAcquisition(request, admission.resource);
      const result = await this.result(
        signal.aborted
          ? ((await this.options.store.getRequest(config.requestId)) ?? request)
          : request,
      );
      return result.outcome === "ready" ? await this.rereadIfSuperseded(result, config) : result;
    } catch (error) {
      // Only the reply is uncertain (#12771): the committed grant is not a preparation failure.
      throw new CommittedReceiptReadError(config.requestId, error);
    }
  }

  /**
   * An abandonment can commit while the ready receipt is being assembled (#12762). Reread the
   * durable receipt so a ready reply never outlives the grant it describes.
   */
  private async rereadIfSuperseded(
    result: SessionBrokerResult,
    config: SessionConfig,
  ): Promise<SessionBrokerResult> {
    const latest = await this.options.store.getRequest(config.requestId);
    return latest && latest.state !== "active" ? this.result(latest) : result;
  }

  /** Whether this host's configuration enables iPhone Duo sessions. */
  supportsIosDuo(): boolean {
    return this.options.capabilities?.iosDuo === true;
  }

  async status(requestId: string): Promise<SessionBrokerResult | undefined> {
    const request = await this.options.store.getRequest(requestId);
    return request && this.result(request);
  }

  async ownedStatus(
    requestId: string,
    ownerToken: string,
  ): Promise<SessionBrokerResult | undefined> {
    const request = await this.options.store.getRequest(requestId);
    if (!request) {
      return undefined;
    }
    this.assertConsumerOwner(request, ownerToken);
    return this.result(request);
  }

  async abandon(requestId: string, ownerToken: string): Promise<SessionBrokerResult> {
    if (this.stopping) {
      throw new SessionBrokerStoppingError();
    }
    const abandonment = await this.options.store.abandon(requestId, this.options.owner, ownerToken);
    for (const preparation of this.preparationOwners.values()) {
      if (preparation.requestId === requestId) {
        preparation.controller.abort(
          new ActionableError("Session request was abandoned by its liveness owner"),
        );
      }
    }
    if (abandonment.request.sessionId) {
      await this.drainAbandonedSession(abandonment.request.sessionId);
    }
    if (abandonment.ticket && !this.hasPendingPreparation(requestId)) {
      await this.tryCleanup(abandonment.ticket);
    }
    return this.result((await this.options.store.getRequest(requestId)) ?? abandonment.request);
  }

  async ownedSessionRequest(
    sessionUuid: string,
    ownerToken: string,
  ): Promise<BrokerRequestRecord | undefined> {
    const request = await this.options.store.getSession(sessionUuid);
    if (request) {
      this.assertConsumerOwner(request, ownerToken);
    }
    return request;
  }

  /** Admission check only. Releasing, failed, stale-owner and terminal receipts grant no control. */
  async hasActiveSession(sessionUuid: string): Promise<boolean> {
    const request = await this.options.store.getSession(sessionUuid);
    return request?.state === "active" && sameProcess(request.owner, this.options.owner);
  }

  async getExport(prepareId: string, requestDigest: string, ownerToken: string) {
    const found = await this.authorizedExport(prepareId, requestDigest, ownerToken);
    if (!found) {
      return undefined;
    }
    return {
      contractVersion: 1 as const,
      prepareId,
      requestDigest,
      acknowledged: found.record.acknowledgedAtMs !== null,
      result: await this.result(found.request),
    };
  }

  async acknowledgeExport(
    prepareId: string,
    requestDigest: string,
    ownerToken: string,
  ): Promise<{ prepareId: string; outcome: "acknowledged" | "unknown_export" }> {
    const found = await this.authorizedExport(prepareId, requestDigest, ownerToken);
    const record = found && (await this.options.store.acknowledgeExport(prepareId));
    return { prepareId, outcome: record ? "acknowledged" : "unknown_export" };
  }

  private async authorizedExport(prepareId: string, requestDigest: string, ownerToken: string) {
    const record = await this.options.store.getExport(prepareId);
    if (!record) {
      return undefined;
    }
    const request = await this.options.store.getRequest(record.requestId);
    if (
      record.requestDigest !== requestDigest ||
      !request ||
      !this.consumerOwns(request, ownerToken)
    ) {
      throw new SessionExportIdentityMismatchError();
    }
    return { record, request };
  }

  private assertConsumerOwner(request: BrokerRequestRecord, ownerToken: string): void {
    if (!this.consumerOwns(request, ownerToken)) {
      throw new ActionableError("Session request belongs to another liveness owner");
    }
  }

  private consumerOwns(request: BrokerRequestRecord, ownerToken: string): boolean {
    return (
      Boolean(ownerToken) &&
      request.fingerprint === sessionRequestFingerprint(request.parameters, ownerToken)
    );
  }

  /**
   * Ends a session with a bounded reply after durable commitment; native work remains tracked
   * until settlement. Only settled cleanup records `released`; expiry replies `cleanup_pending`. An
   * owner-exit release (#12791) is not the client's release: it terminally records
   * `session_owner_exited` and answers as soon as that receipt is committed, while the session
   * drain and device destruction continue as tracked release work ({@link joinReleases}).
   */
  release(
    sessionUuid: string,
    reason?: SessionBrokerReleaseReason,
    options: { replyBudgetMs?: number } = {},
  ): Promise<SessionBrokerReleaseResult> {
    if (reason === SESSION_OWNER_EXITED_CODE && !this.releases.has(sessionUuid)) {
      return this.releaseAfterOwnerExit(sessionUuid);
    }
    return boundedReleaseReply(
      sessionUuid,
      this.releaseTracked(sessionUuid),
      options.replyBudgetMs,
      this.options,
    );
  }

  private releaseTracked(sessionUuid: string, signal?: AbortSignal): TrackedRelease {
    const previous = this.releases.get(sessionUuid);
    if (previous) {
      return previous;
    }
    const committed = this.options.store.beginRelease(sessionUuid, this.options.owner);
    return trackRelease(
      this.releases,
      sessionUuid,
      committed.then((request) => this.releaseOnce(sessionUuid, request, signal)),
      committed,
    );
  }

  private releaseAfterOwnerExit(sessionUuid: string): Promise<SessionBrokerReleaseResult> {
    const committed = this.commitOwnerExit(sessionUuid);
    // Registered synchronously, so a concurrent release joins this cleanup instead of racing it.
    // trackRelease settles its own rejection; the caller observes the committed answer below.
    void trackRelease(
      this.releases,
      sessionUuid,
      committed.then((exit) =>
        exit
          ? this.finishOwnerExit(sessionUuid, exit)
          : { sessionUuid, outcome: "unknown_session" },
      ),
      committed,
    );
    return committed.then(async (exit) =>
      exit
        ? this.resetRelease.releaseStatus(exit.request, sessionUuid)
        : { sessionUuid, outcome: "unknown_session" },
    );
  }

  /** Terminal first: the receipt says the owner died even if the native drain never settles. */
  private async commitOwnerExit(
    sessionUuid: string,
  ): Promise<{ request: BrokerRequestRecord; ticket?: DestructionTicket } | undefined> {
    const request = await this.options.store.getSession(sessionUuid);
    if (!request) {
      return undefined;
    }
    const ticket = await this.options.store.fail(
      request.requestId,
      this.options.owner,
      SESSION_OWNER_EXITED_MESSAGE,
      SESSION_OWNER_EXITED_CODE,
    );
    logger.info(
      `Session ${sessionUuid} lost its execution owner; request ${request.requestId} is ` +
        `terminal (${SESSION_OWNER_EXITED_CODE})`,
    );
    return {
      request: (await this.options.store.getRequest(request.requestId)) ?? request,
      ...(ticket ? { ticket } : {}),
    };
  }

  private async finishOwnerExit(
    sessionUuid: string,
    exit: { request: BrokerRequestRecord; ticket?: DestructionTicket },
  ): Promise<SessionBrokerReleaseResult> {
    try {
      await this.options.devices.release(sessionUuid);
    } catch (error) {
      // The destroying resource and native journal keep ownership; recovery retries cleanup.
      logger.warn(
        `Session ${sessionUuid} drain after owner exit remains pending: ${errorMessage(error)}`,
      );
    }
    if (exit.ticket) {
      await this.tryCleanup(exit.ticket);
    }
    return this.resetRelease.releaseStatus(exit.request, sessionUuid);
  }

  /** Daemon shutdown joins callers; unfinished native work retains journal ownership. */
  async joinReleases(): Promise<void> {
    await Promise.allSettled([...this.releases.values()].map((release) => release.pending));
  }

  async close(): Promise<void> {
    try {
      await this.markRestartHandoff();
    } catch (error) {
      // Preparations are already aborted; retry the handoff after joining their native work.
      logger.warn(`Session broker restart handoff failed: ${errorMessage(error)}`, error);
    }
    await Promise.allSettled([...this.preparationOwners.keys()]);
    // Retry after joining preparations in case the first snapshot or an inline mark failed;
    // the store makes each mark idempotent.
    await this.markRestartHandoff();
    const requests = await this.options.store.listRecoverableRequests();
    // Only a release the consumer already began is finished here; background recovery cleanup was
    // stopped by the handoff mark above and starts no new work.
    await Promise.allSettled(
      requests
        .filter(
          (request) =>
            sameProcess(request.owner, this.options.owner) &&
            request.sessionId &&
            request.state === "releasing" &&
            !this.queuedRecoveryReleases.has(request.requestId),
        )
        .map((request) => this.releaseTracked(request.sessionId!).pending),
    );
    await this.joinReleases();
    await this.cleanup.join();
    await Promise.allSettled([...this.destroys.values()]);
  }

  /**
   * Stop admission/recovery and commit handoff before joining native work (#13799).
   * Abandonment also rejects as stopping from this first mark, before close() joins work.
   */
  async markRestartHandoff(): Promise<void> {
    this.stopping = true;
    this.cleanup.stop();
    for (const preparation of this.preparationOwners.values()) {
      // Admitted work stores a retryable stopping receipt requiring a new request ID;
      // unadmitted work stores nothing and is refused as stopping.
      preparation.controller.abort(new SessionBrokerStoppingError());
    }
    const requests = await this.options.store.listRecoverableRequests();
    // Shutdown is not the consumer's release (#12451): an active session keeps its device for the
    // restarted provider, which adopts it once the same session UUID is re-owned natively.
    await Promise.allSettled(
      requests
        .filter(
          (request) =>
            sameProcess(request.owner, this.options.owner) &&
            request.sessionId &&
            request.state === "active",
        )
        .map((request) =>
          this.options.store
            .relinquishForRestart(request.requestId, this.options.owner)
            .catch((error: unknown) => {
              // Unmarked, the successor treats the session as a crashed owner's and retires it.
              logger.warn(
                `Session request ${request.requestId} could not be kept for restart: ${errorMessage(error)}`,
                error,
              );
            }),
        ),
    );
  }

  /** Compatibility entry point: durable receipts followed by a bounded native cleanup pass. */
  async recover(): Promise<void> {
    await this.recoverReceipts();
    await this.recoverCleanup();
  }

  /** Startup awaits only transactions and the admission-only session disposition lookup. */
  async recoverReceipts(): Promise<void> {
    for (const request of await this.options.store.listRecoverableRequests()) {
      if (this.stopping) {
        return;
      }
      try {
        await this.recoverOneRequest(request);
      } catch (error) {
        // One broken receipt must not starve every later receipt in each recovery pass.
        logger.warn(
          `Session request ${request.requestId} recovery remains pending: ${errorMessage(error)}`,
          error,
        );
      }
    }
  }

  async recoverCleanup(): Promise<void> {
    if (this.stopping) {
      return;
    }
    const requests = new Map(
      (await this.options.store.listRecoverableRequests())
        .filter((request) => sameProcess(request.owner, this.options.owner))
        .map((request) => [request.requestId, request]),
    );
    const items: RecoveryCleanupItem[] = [];
    for (const resource of await this.options.store.listLiveResources()) {
      if (resource.requestId && this.hasPendingPreparation(resource.requestId)) {
        continue;
      }
      const request = resource.requestId ? requests.get(resource.requestId) : undefined;
      if (resource.state !== "destroying" && request?.state !== "releasing") {
        continue;
      }
      if (request?.state === "releasing") {
        this.queuedRecoveryReleases.add(request.requestId);
      }
      items.push({
        resourceId: resource.resourceId,
        run: (signal) => this.recoverResource(resource, request, signal),
      });
    }
    // Invariant: receipts retain releasing/resetting or terminal/destroying ownership until
    // background cleanup proves absence (or a clean reset). Admission counts these resources
    // against caps and can reuse only idle rows, never a device awaiting native cleanup.
    await this.cleanup.run(items);
  }

  private async recoverResource(
    resource: BrokerResourceRecord,
    request: BrokerRequestRecord | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (request?.state === "releasing" && request.sessionId) {
      const session = request.sessionId;
      await this.releaseTracked(session, signal).pending;
      return;
    }
    if (
      request?.state === "failed" &&
      request.errorCode === SESSION_REQUEST_ABANDONED_CODE &&
      request.sessionId
    ) {
      await this.drainAbandonedSession(request.sessionId);
    }
    signal.throwIfAborted();
    await this.tryCleanup(destructionTicket(resource), signal);
  }

  private async recoverOneRequest(request: BrokerRequestRecord): Promise<void> {
    if (sameProcess(request.owner, this.options.owner)) {
      await this.recoverOwnedRequest(request);
      return;
    }
    if ((await this.recoverRestartHandoff(request)) !== "terminal") {
      return;
    }
    // Only another process generation's receipt can need takeover; ours never does.
    await this.options.store.recoverRequest(request.requestId, this.options.owner);
    if (request.state === "acquiring") {
      await this.timing.recordFailedAcquisition(request);
    }
  }

  private async recoverOwnedRequest(request: BrokerRequestRecord): Promise<void> {
    if (
      request.state === "active" &&
      request.sessionId &&
      this.options.sessionDisposition &&
      (await this.options.sessionDisposition(request.sessionId)) === "gone" &&
      !this.stopping
    ) {
      // Expired restart handoffs use ordinary, durably owned release; no replacement is selected.
      await this.options.store.beginRelease(request.sessionId, this.options.owner);
    }
    if (request.state === "acquiring" && !this.preparations.has(request.requestId)) {
      await this.options.store.failInterruptedAcquisition(
        request.requestId,
        this.options.owner,
        "Acquisition ended without committing a session; cleanup is pending",
      );
      await this.timing.recordFailedAcquisition(request);
    }
  }

  /**
   * A gracefully relinquished session is adopted while its session survives the restart (live, or
   * a still-valid restart reservation). Only a session that is gone falls through to ordinary
   * dead-owner recovery, which records `session_owner_exited` and destroys the device. A crashed
   * owner never relinquished, so its receipts take that terminal path directly.
   */
  private async recoverRestartHandoff(
    request: BrokerRequestRecord,
  ): Promise<"adopted" | "pending" | "terminal"> {
    if (!request.restartHandoff || request.state !== "active" || !request.sessionId) {
      return "terminal";
    }
    const disposition = this.options.sessionDisposition
      ? await this.options.sessionDisposition(request.sessionId)
      : "gone";
    if (disposition === "gone") {
      return "terminal";
    }
    const adoption = await this.options.store.adoptRestartHandoff(
      request.requestId,
      this.options.owner,
    );
    if (adoption === "adopted") {
      logger.info(
        `Session request ${request.requestId} adopted session ${request.sessionId} after a provider restart`,
      );
    }
    return adoption === "not-handoff" ? "terminal" : adoption;
  }

  /** Forgets terminal receipts past their replay window. Returns how many were pruned. */
  pruneReceipts(): Promise<number> {
    return this.options.store.pruneTerminalRequests(
      this.options.receiptRetentionMs ?? RECEIPT_RETENTION_MS,
      RECEIPT_PRUNE_BATCH,
      this.options.exportRetentionMs ?? EXPORT_RETENTION_MS,
    );
  }

  private async releaseOnce(
    sessionUuid: string,
    request: BrokerRequestRecord | undefined,
    signal?: AbortSignal,
  ): Promise<SessionBrokerReleaseResult> {
    if (!request) {
      return { sessionUuid, outcome: "unknown_session" };
    }
    if (request.state === "released" || request.state === "failed") {
      return this.resetRelease.releaseStatus(request, sessionUuid);
    }
    const resource = await this.requestResource(request);
    if (!resource) {
      throw new ActionableError("Session has no durable resource; cannot acknowledge cleanup");
    }
    signal?.throwIfAborted();
    try {
      if (request.state === "releasing" && resource.state === "destroying") {
        await this.tryCleanup(destructionTicket(resource), signal);
        return this.resetRelease.releaseStatus(request, sessionUuid);
      }
      const disposition = await this.resetRelease.drainAndReset(
        request,
        resource,
        sessionUuid,
        signal,
      );
      signal?.throwIfAborted();
      if (disposition === "pending") {
        return {
          ...(await this.resetRelease.releaseStatus(request, sessionUuid)),
          outcome: "cleanup_pending",
        };
      }
      if (disposition === "idle") {
        return this.resetRelease.releaseStatus(request, sessionUuid);
      }
      const ticket = await this.options.store.releaseByDestruction(
        request.requestId,
        this.options.owner,
      );
      this.resetReadiness.notify(resource.resourceId);
      if (ticket) {
        await this.tryCleanup(ticket, signal);
      }
      return this.resetRelease.releaseStatus(request, sessionUuid);
    } finally {
      this.resetReadiness.notify(resource.resourceId);
    }
  }

  private async drainAbandonedSession(sessionUuid: string): Promise<void> {
    try {
      const inFlightRelease = this.releases.get(sessionUuid);
      if (inFlightRelease) {
        await inFlightRelease.pending;
      } else {
        await this.options.devices.release(sessionUuid);
      }
    } catch (error) {
      logger.warn(
        `Abandoned session ${sessionUuid} release remains pending: ${errorMessage(error)}`,
      );
    }
  }

  private async requestResource(
    request: BrokerRequestRecord,
  ): Promise<BrokerResourceRecord | undefined> {
    return request.resourceId ? this.options.store.getResource(request.resourceId) : undefined;
  }

  private async result(request: BrokerRequestRecord): Promise<SessionBrokerResult> {
    const resource = await this.requestResource(request);
    return {
      contractVersion: 1,
      requestId: request.requestId,
      outcome:
        request.state === "active"
          ? "ready"
          : request.state === "failed"
            ? "failed"
            : request.state === "released"
              ? "released"
              : "pending",
      sessionUuid: request.sessionId,
      profile: resource ? nativeProfile(resource) : null,
      cleanupPending: this.cleanupIsPending(request, resource),
      ...(request.timing ? { timing: request.timing } : {}),
      ...(request.error
        ? { failure: storedBrokerFailure(request, this.cleanupIsPending(request, resource)) }
        : {}),
    };
  }

  private cleanupIsPending(
    request: BrokerRequestRecord,
    resource: BrokerResourceRecord | undefined,
  ): boolean {
    const durableCleanupPending =
      resource?.requestId === request.requestId &&
      ["destroying", "resetting", "unknown"].includes(resource.state);
    const preparationPending =
      request.errorCode === SESSION_REQUEST_ABANDONED_CODE &&
      this.hasPendingPreparation(request.requestId);
    return Boolean(durableCleanupPending || preparationPending);
  }

  private async resultUnlessAborted(
    request: BrokerRequestRecord,
    signal: AbortSignal,
  ): Promise<SessionBrokerResult> {
    const result = await this.result(request);
    signal.throwIfAborted();
    return result;
  }

  private hasPendingPreparation(requestId: string): boolean {
    return (this.preparations.get(requestId) ?? 0) > 0;
  }

  private async destroy(resource: BrokerResourceRecord, signal?: AbortSignal): Promise<boolean> {
    if ((await this.options.devices.destroy(resource, signal)) !== "absent") {
      return false;
    }
    signal?.throwIfAborted();
    return this.options.store.confirmDestroyed(destructionTicket(resource));
  }

  private tryCleanup(ticket: DestructionTicket, signal?: AbortSignal): Promise<void> {
    const previous = this.destroys.get(ticket.resourceId);
    if (previous) {
      return previous;
    }
    const pending = this.cleanupOnce(ticket, signal).finally(() => {
      this.destroys.delete(ticket.resourceId);
    });
    this.destroys.set(ticket.resourceId, pending);
    return pending;
  }

  private async cleanupOnce(ticket: DestructionTicket, signal?: AbortSignal): Promise<void> {
    const resource = await this.options.store.getResource(ticket.resourceId);
    if (resource?.state === "destroying" && resource.revision === ticket.revision) {
      try {
        signal?.throwIfAborted();
        await this.destroy(resource, signal);
      } catch (error) {
        // The durable destroying row and native journal retain ownership for another pass.
        logger.warn(
          `Session resource ${resource.resourceId} cleanup remains pending: ${errorMessage(error)}`,
        );
      }
    }
  }
}
