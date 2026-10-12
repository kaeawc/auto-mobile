import { createHash } from "node:crypto";
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
import { stableStringify } from "../../utils/stableStringify";
import { logger } from "../../utils/logger";
import type { SlotProcessIdentity } from "../managedSlots/slotRegistry";
import type { BrokerLimits } from "./admission";
import type { SessionBrokerDevicePort } from "./devicePort";
import { nativeProfile, poolProfile } from "./profile";
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
  owner: SlotProcessIdentity;
  limits: BrokerLimits;
  catalog: (platform: "ios" | "android", signal?: AbortSignal) => Promise<SessionDeviceCatalog>;
  defaults: (platform: "ios" | "android") => SessionRequirementDefaults;
  /** Admission-only session lookup; must not start lazy release from inside recovery. */
  sessionIsLive?: (sessionUuid: string) => boolean;
  /** Opt in only after the native reset baseline has passed contamination tests. */
  reuseCleanDevices?: boolean;
}

class RequirementError extends ActionableError {
  constructor(readonly failure: SessionBrokerFailure) {
    super(failure.message);
  }
}

function unwrap<T>(result: RequirementResult<T>): T {
  if (!result.ok) {
    throw new RequirementError({
      code: result.error.code,
      message: result.error.message,
      retryable: result.error.transient,
    });
  }
  return result.value;
}

function failureFor(error: unknown): SessionBrokerFailure {
  return error instanceof RequirementError
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

function sameProcess(left: SlotProcessIdentity, right: SlotProcessIdentity): boolean {
  return (
    left.daemonId === right.daemonId &&
    left.pid === right.pid &&
    left.processGenerationToken === right.processGenerationToken
  );
}

function requestFingerprint(config: unknown, livenessOwnerToken: string): string {
  return createHash("sha256").update(stableStringify({ config, livenessOwnerToken })).digest("hex");
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
  private readonly preparationOwners = new Map<Promise<SessionBrokerResult>, AbortController>();
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
    this.preparationOwners.set(pending, controller);
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
    const fingerprint = requestFingerprint(config, livenessOwnerToken);
    this.preparations.set(config.requestId, (this.preparations.get(config.requestId) ?? 0) + 1);
    try {
      const previous = await this.options.store.getRequest(config.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          return failedResult(
            config,
            failureFor(
              new ActionableError(
                "Session request identity was already used with different parameters",
              ),
            ),
          );
        }
        // Receipt replay does not depend on today's runtime catalog or default configuration.
        return this.result(previous);
      }
      const input = await this.admissionInput(config, fingerprint, signal);
      const admission = await this.options.store.admit(input);
      if (admission.kind === "existing" || admission.kind === "refused") {
        return this.result(admission.request);
      }
      admitted = true;
      return await this.prepareAdmission(admission, input, config, livenessOwnerToken, signal);
    } catch (error) {
      const failure = failureFor(error);
      if (admitted) {
        const ticket = await this.options.store.fail(
          config.requestId,
          this.options.owner,
          failure.message,
          failure.code,
        );
        if (ticket) {
          await this.tryCleanup(ticket);
        }
        const request = await this.options.store.getRequest(config.requestId);
        if (request) {
          return { ...(await this.result(request)), failure };
        }
        throw new ActionableError(
          "Admitted session request lost its durable receipt; cleanup cannot be acknowledged",
        );
      }
      // Catalog/default resolution can fail before admission. Retain that terminal identity too:
      // a changed host catalog must not turn its replay into a new native acquisition.
      // An independently committed receipt wins; never overwrite an acquisition from a sibling
      // caller. A persistence failure is an RPC error, not a claimed durable terminal result.
      const receipt = await this.options.store.recordPreAdmissionFailure(
        { requestId: config.requestId, fingerprint, parameters: config, owner: this.options.owner },
        failure,
      );
      return this.result(receipt);
    } finally {
      const remaining = (this.preparations.get(config.requestId) ?? 1) - 1;
      if (remaining === 0) {
        this.preparations.delete(config.requestId);
      } else {
        this.preparations.set(config.requestId, remaining);
      }
    }
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
    return this.result(request);
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
    if (!ownerToken || request.fingerprint !== requestFingerprint(request.parameters, ownerToken)) {
      throw new ActionableError("Session request belongs to another liveness owner");
    }
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
    for (const controller of this.preparationOwners.values()) {
      controller.abort(new ActionableError("Session broker is stopping"));
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
      if (resource.state === "destroying") {
        await this.tryCleanup(destructionTicket(resource));
      }
    }
  }

  private async recoverOneRequest(request: BrokerRequestRecord): Promise<void> {
    if (sameProcess(request.owner, this.options.owner)) {
      if (
        request.state === "active" &&
        request.sessionId &&
        this.options.sessionIsLive &&
        !this.options.sessionIsLive(request.sessionId)
      ) {
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
    }
    await this.options.store.recoverRequest(request.requestId, this.options.owner);
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
    const cleanupPending =
      resource?.requestId === request.requestId &&
      (resource.state === "destroying" ||
        resource.state === "resetting" ||
        resource.state === "unknown");
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
      cleanupPending: Boolean(cleanupPending),
      ...(request.error
        ? {
            failure: {
              code: request.errorCode ?? "session_preparation_failed",
              message: request.error,
              retryable: false,
            },
          }
        : {}),
    };
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
