import {
  matchSessionDevice,
  normalizeSessionDeviceRequirement,
  resolveSessionDeviceProfile,
  type RequirementResult,
  type SessionDeviceCatalog,
  type SessionRequirementDefaults,
} from "../../devices/sessionRequirements";
import { ActionableError } from "../../models/ActionableError";
import type { SessionConfig } from "../../models/sessionConfig";
import type {
  SessionBrokerFailure,
  SessionBrokerReleaseResult,
  SessionBrokerResult,
} from "../../models/sessionBrokerResult";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { BindingProcessIdentity } from "./registry/bindingRegistry";
import type { BrokerLimits } from "./admission";
import { SessionBrokerFailureError, type SessionBrokerDevicePort } from "./devicePort";
import type { SessionLiveness } from "./sessionDisposition";
import { nativeProfile, poolProfile } from "./profile";
import { SESSION_REQUEST_ABANDONED_CODE, sessionRequestFingerprint } from "./requestIdentity";
import type { SqliteSessionBrokerStore } from "./sqliteStore";
import {
  destructionTicket,
  type BrokerAdmission,
  type BrokerAdmissionInput,
  type BrokerRequestRecord,
  type BrokerResourceRecord,
  type DestructionTicket,
} from "./store";

export interface SessionBrokerOptions {
  store: SqliteSessionBrokerStore;
  devices: SessionBrokerDevicePort;
  owner: BindingProcessIdentity;
  limits: BrokerLimits;
  catalog: (platform: "ios" | "android", signal?: AbortSignal) => Promise<SessionDeviceCatalog>;
  defaults: (platform: "ios" | "android") => SessionRequirementDefaults;
  /** Admission-only lookup; must not start lazy release from inside recovery. */
  sessionDisposition?: (sessionUuid: string) => SessionLiveness | Promise<SessionLiveness>;
  /** Opt in only after the native reset baseline has passed contamination tests. */
  reuseCleanDevices?: boolean;
}

function unwrap<T>(result: RequirementResult<T>): T {
  if (!result.ok) {
    throw new SessionBrokerFailureError({
      code: result.error.code,
      message: result.error.message,
      retryable: result.error.transient,
    });
  }
  return result.value;
}

function failureFor(error: unknown): SessionBrokerFailure {
  return error instanceof SessionBrokerFailureError
    ? error.failure
    : { code: "session_preparation_failed", message: errorMessage(error), retryable: false };
}

function failedResult(config: SessionConfig, failure: SessionBrokerFailure): SessionBrokerResult {
  return {
    contractVersion: 1,
    requestId: config.requestId,
    outcome: "failed",
    sessionUuid: null,
    profile: null,
    cleanupPending: false,
    failure,
  };
}

function sameProcess(left: BindingProcessIdentity, right: BindingProcessIdentity): boolean {
  return (
    left.daemonId === right.daemonId &&
    left.pid === right.pid &&
    left.processGenerationToken === right.processGenerationToken
  );
}

/**
 * Owns one acquisition-to-release lifecycle behind the consumer's fresh session UUID.
 * Requests are reserved before native work. Every unsuccessful acquisition becomes terminal and
 * leaves durable cleanup; no retry or restart silently gives its identity a different session.
 *
 * This class starts no background tasks. The daemon owns and joins explicit recovery passes,
 * and uses the existing native journal driver for platform work that outlives a bounded pass.
 */
export class SessionBroker {
  private readonly releases = new Map<string, Promise<SessionBrokerReleaseResult>>();
  private readonly preparations = new Map<string, number>();
  private readonly preparationOwners = new Map<
    Promise<SessionBrokerResult>,
    { controller: AbortController; requestId: string }
  >();
  private stopping = false;

  constructor(private readonly options: SessionBrokerOptions) {}

  prepare(
    config: SessionConfig,
    livenessOwnerToken: string,
    signal?: AbortSignal,
  ): Promise<SessionBrokerResult> {
    if (this.stopping) {
      return Promise.reject(new ActionableError("Session broker is stopping"));
    }
    const controller = new AbortController();
    const ownedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const pending = this.prepareOnce(config, livenessOwnerToken, ownedSignal);
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
  ): Promise<SessionBrokerResult> {
    let admitted = false;
    const fingerprint = sessionRequestFingerprint(config, livenessOwnerToken);
    this.preparations.set(config.requestId, (this.preparations.get(config.requestId) ?? 0) + 1);
    try {
      const previous = await this.options.store.getRequest(config.requestId);
      if (previous) {
        return this.replay(previous, config, fingerprint, livenessOwnerToken, signal);
      }
      const input = await this.admissionInput(config, fingerprint, signal);
      const admission = await this.options.store.admit(input);
      if (admission.kind === "existing" || admission.kind === "refused") {
        return this.resultUnlessAborted(admission.request, signal);
      }
      admitted = true;
      return await this.prepareAdmission(admission, input, config, livenessOwnerToken, signal);
    } catch (error) {
      logger.warn(
        `Session request ${config.requestId} preparation failed: ${errorMessage(error)}`,
        error,
      );
      return this.handlePreparationFailure(
        config,
        livenessOwnerToken,
        fingerprint,
        admitted,
        error,
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
  ): Promise<SessionBrokerResult> {
    const failure = failureFor(error);
    if (admitted) {
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
      const result = await this.result(request);
      return request.errorCode === SESSION_REQUEST_ABANDONED_CODE
        ? result
        : {
            ...result,
            failure: { ...failure, retryable: failure.retryable && !result.cleanupPending },
          };
    }
    // Catalog/default resolution can fail before admission. Retain that terminal identity too:
    // a changed host catalog must not turn its replay into a new native acquisition.
    // An independently committed receipt wins; never overwrite an acquisition from a sibling
    // caller. A persistence failure is an RPC error, not a claimed durable terminal result.
    const independentlyCommitted = await this.options.store.getRequest(config.requestId);
    if (
      independentlyCommitted?.errorCode === SESSION_REQUEST_ABANDONED_CODE &&
      this.consumerOwns(independentlyCommitted, livenessOwnerToken)
    ) {
      return this.result(independentlyCommitted);
    }
    const receipt = await this.options.store.recordPreAdmissionFailure(
      { requestId: config.requestId, fingerprint, parameters: config, owner: this.options.owner },
      failure,
    );
    return this.result(receipt);
  }

  private finishPreparation(requestId: string): void {
    const remaining = (this.preparations.get(requestId) ?? 1) - 1;
    if (remaining === 0) {
      this.preparations.delete(requestId);
    } else {
      this.preparations.set(requestId, remaining);
    }
  }

  /** Receipt replay does not depend on today's runtime catalog or default configuration. */
  private replay(
    previous: BrokerRequestRecord,
    config: SessionConfig,
    fingerprint: string,
    livenessOwnerToken: string,
    signal: AbortSignal,
  ): Promise<SessionBrokerResult> | SessionBrokerResult {
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
    return this.resultUnlessAborted(previous, signal);
  }

  private async admissionInput(
    config: SessionConfig,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<BrokerAdmissionInput> {
    signal.throwIfAborted();
    const catalog = await this.options.catalog(config.device.platform, signal);
    const defaults = this.options.defaults(config.device.platform);
    const requirement = unwrap(normalizeSessionDeviceRequirement(config.device, defaults, catalog));
    return {
      requestId: config.requestId,
      fingerprint,
      parameters: config,
      owner: this.options.owner,
      limits: this.options.limits,
      matches: (profile) => matchSessionDevice(requirement, poolProfile(profile)).kind === "match",
      resolveCreation: () => unwrap(resolveSessionDeviceProfile(requirement, defaults, catalog)),
    };
  }

  private async prepareAdmission(
    initial: BrokerAdmission,
    input: BrokerAdmissionInput,
    config: SessionConfig,
    livenessOwnerToken: string,
    signal: AbortSignal,
  ): Promise<SessionBrokerResult> {
    let admission = initial;
    // Each eviction removes a distinct idle resource. No creation reservation is made until
    // the existing journal confirms that device's absence.
    while (admission.kind === "evict") {
      if (!(await this.destroy(admission.resource))) {
        throw new ActionableError(
          "Device eviction remains unresolved; its capacity is still reserved",
        );
      }
      signal.throwIfAborted();
      admission = await this.options.store.continueAdmission(input);
    }
    if (admission.kind === "refused" || admission.kind === "existing") {
      return this.result(admission.request);
    }
    signal.throwIfAborted();
    const prepared = await this.options.devices.prepare(admission.resource, {
      livenessOwnerToken,
      signal,
      preparationTimeoutMs: config.preparationTimeoutMs,
      idleTimeoutMs: config.idleTimeoutMs,
      executionOwnerPid: config.executionOwnerPid,
    });
    signal.throwIfAborted();
    const request = await this.options.store.activate(
      config.requestId,
      this.options.owner,
      prepared.sessionId,
    );
    return this.resultUnlessAborted(request, signal);
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
      throw new ActionableError("Session broker is stopping");
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

  release(sessionUuid: string): Promise<SessionBrokerReleaseResult> {
    const previous = this.releases.get(sessionUuid);
    if (previous) {
      return previous;
    }
    const pending = this.releaseOnce(sessionUuid);
    this.releases.set(sessionUuid, pending);
    // Both handlers terminate; callers still observe the original result/rejection.
    void pending.then(
      () => this.releases.delete(sessionUuid),
      () => this.releases.delete(sessionUuid),
    );
    return pending;
  }

  /** Daemon shutdown joins callers; unfinished native work retains journal ownership. */
  async joinReleases(): Promise<void> {
    await Promise.allSettled([...this.releases.values()]);
  }

  async close(): Promise<void> {
    this.stopping = true;
    for (const preparation of this.preparationOwners.values()) {
      preparation.controller.abort(new ActionableError("Session broker is stopping"));
    }
    await Promise.allSettled([...this.preparationOwners.keys()]);
    const requests = await this.options.store.listRequests();
    await Promise.allSettled(
      requests
        .filter(
          (request) =>
            sameProcess(request.owner, this.options.owner) &&
            (request.state === "active" || request.state === "releasing") &&
            request.sessionId,
        )
        .map((request) => this.release(request.sessionId!)),
    );
    await this.joinReleases();
  }

  /** Full bounded snapshot, not a repeatedly scanned prefix that can starve later cleanup. */
  async recover(): Promise<void> {
    for (const request of await this.options.store.listRequests()) {
      try {
        await this.recoverOneRequest(request);
      } catch (error) {
        // One broken request must not starve every later cleanup in each recovery pass.
        logger.warn(
          `Session request ${request.requestId} recovery remains pending: ${errorMessage(error)}`,
        );
      }
    }
    for (const resource of await this.options.store.listResources()) {
      if (
        resource.state === "destroying" &&
        (!resource.requestId || !this.hasPendingPreparation(resource.requestId))
      ) {
        await this.tryCleanup(destructionTicket(resource));
      }
    }
  }

  private async recoverOneRequest(request: BrokerRequestRecord): Promise<void> {
    if (sameProcess(request.owner, this.options.owner)) {
      if (
        request.state === "active" &&
        request.sessionId &&
        this.options.sessionDisposition &&
        (await this.options.sessionDisposition(request.sessionId)) === "gone"
      ) {
        // Expired restart handoffs use ordinary, durably owned release; no replacement is selected.
        await this.release(request.sessionId);
      }
      if (request.state === "acquiring" && !this.preparations.has(request.requestId)) {
        await this.options.store.fail(
          request.requestId,
          this.options.owner,
          "Acquisition ended without committing a session; cleanup is pending",
        );
      }
      if (request.state === "releasing" && request.sessionId) {
        await this.release(request.sessionId);
      }
      await this.redriveAbandonedSession(request);
    }
    await this.options.store.recoverRequest(request.requestId, this.options.owner);
  }

  private async redriveAbandonedSession(request: BrokerRequestRecord): Promise<void> {
    if (
      request.state === "failed" &&
      request.errorCode === SESSION_REQUEST_ABANDONED_CODE &&
      request.sessionId
    ) {
      await this.drainAbandonedSession(request.sessionId);
    }
  }

  private async releaseOnce(sessionUuid: string): Promise<SessionBrokerReleaseResult> {
    const request = await this.options.store.beginRelease(sessionUuid, this.options.owner);
    if (!request) {
      return { sessionUuid, outcome: "unknown_session" };
    }
    if (request.state === "released") {
      return { sessionUuid, outcome: "released" };
    }
    if (request.state === "failed") {
      return this.releaseStatus(request, sessionUuid);
    }
    const resource = await this.requestResource(request);
    if (!resource) {
      throw new ActionableError("Session has no durable resource; cannot acknowledge cleanup");
    }
    const disposition = await this.drainAndReset(request, resource, sessionUuid);
    if (disposition === "pending") {
      return { sessionUuid, outcome: "cleanup_pending" };
    }
    if (disposition === "idle") {
      return this.releaseStatus(request, sessionUuid);
    }
    const ticket = await this.options.store.releaseByDestruction(
      request.requestId,
      this.options.owner,
    );
    if (ticket) {
      await this.tryCleanup(ticket);
    }
    return this.releaseStatus(request, sessionUuid);
  }

  private async drainAbandonedSession(sessionUuid: string): Promise<void> {
    try {
      const inFlightRelease = this.releases.get(sessionUuid);
      if (inFlightRelease) {
        await inFlightRelease;
      } else {
        await this.options.devices.release(sessionUuid);
      }
    } catch (error) {
      logger.warn(
        `Abandoned session ${sessionUuid} release remains pending: ${errorMessage(error)}`,
      );
    }
  }

  private async drainAndReset(
    request: BrokerRequestRecord,
    resource: BrokerResourceRecord,
    sessionUuid: string,
  ): Promise<"idle" | "destroy" | "pending"> {
    try {
      if (!(await this.options.devices.release(sessionUuid)).settled) {
        return "pending";
      }
      if (
        !this.options.reuseCleanDevices ||
        !this.options.devices.reset ||
        resource.state !== "resetting"
      ) {
        return "destroy";
      }
      if ((await this.options.devices.reset(resource)) !== "clean") {
        return "destroy";
      }
      const tickets = await this.options.store.completeCleanRelease(
        request.requestId,
        this.options.owner,
        this.options.limits,
      );
      for (const ticket of tickets) {
        await this.tryCleanup(ticket);
      }
      return "idle";
    } catch (error) {
      // Native execution/journal fences still prevent destructive work before the drain joins.
      logger.warn(
        `Session ${sessionUuid} could not finish its clean release: ${errorMessage(error)}`,
      );
      return "destroy";
    }
  }

  private async releaseStatus(
    request: BrokerRequestRecord,
    sessionUuid: string,
  ): Promise<SessionBrokerReleaseResult> {
    const resource = await this.requestResource(request);
    const pending =
      resource?.requestId === request.requestId &&
      resource.state !== "idle" &&
      resource.state !== "destroyed";
    return { sessionUuid, outcome: pending ? "cleanup_pending" : "released" };
  }

  private async requestResource(
    request: BrokerRequestRecord,
  ): Promise<BrokerResourceRecord | undefined> {
    return (await this.options.store.listResources()).find(
      (entry) => entry.resourceId === request.resourceId,
    );
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
      ...(request.error
        ? {
            failure: {
              code: request.errorCode ?? "session_preparation_failed",
              message: request.error,
              retryable: request.retryable && !this.cleanupIsPending(request, resource),
            },
          }
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

  private async destroy(resource: BrokerResourceRecord): Promise<boolean> {
    if ((await this.options.devices.destroy(resource)) !== "absent") {
      return false;
    }
    return this.options.store.confirmDestroyed(destructionTicket(resource));
  }

  private async tryCleanup(ticket: DestructionTicket): Promise<void> {
    const resource = (await this.options.store.listResources()).find(
      (entry) => entry.resourceId === ticket.resourceId && entry.revision === ticket.revision,
    );
    if (resource?.state === "destroying") {
      try {
        await this.destroy(resource);
      } catch (error) {
        // The durable destroying row and native journal retain ownership for another pass.
        logger.warn(
          `Session resource ${resource.resourceId} cleanup remains pending: ${errorMessage(error)}`,
        );
      }
    }
  }
}
