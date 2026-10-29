import { isErrored, holderOf } from "../deviceBinding";
import { DevicePoolError } from "../DevicePoolError";
import {
  describeMultiDeviceAllocationAttempts,
  type MultiDeviceAllocationBlock,
  type MultiDeviceAllocationTicket,
  type MultiDeviceAllocationOutcome,
} from "../multiDeviceAllocation";
import { withAllocationCancellationScope } from "../allocationCancellationScope";
import { logger } from "../../utils/logger";
import { ActionableError, Platform } from "../../models";
import { matchesPlatformSelector } from "../../models/Platform";
import { assertPoolCapacity } from "../poolCapacityError";
import { type DevicePoolRefreshResult } from "../devicePoolRefresh";
import { DeviceAllocationRequest } from "../DeviceCriteriaMatcher";
import { throwIfRequestAborted } from "../../utils/AbortContext";
import type { PooledDevice } from "../devicePoolTypes";
import { refreshFailureContext, RollbackAssignment } from "./contracts";
import type { DevicePoolOperations } from "./operations";
import type { DevicePoolState } from "./state";

export interface MultiAllocationOperations {
  assignMultipleDevices(
    sessionIds: string[],
    timeoutMs?: number,
    platform?: Platform,
  ): Promise<Map<string, string>>;
  assignMultipleDevicesInScope(
    sessionIds: string[],
    timeoutMs: number,
    platform?: Platform,
  ): Promise<Map<string, string>>;
  startDevicesForPlatformShortfall(
    requiredCount: number,
    deadlineMs: number,
    platform: Platform | undefined,
  ): Promise<{
    stats: ReturnType<DevicePoolOperations["getStatsForPlatform"]>;
    refresh?: {
      failure: string | undefined;
    };
  }>;
  assignMultipleDevicesByCriteria(
    requests: DeviceAllocationRequest[],
    timeoutMs?: number,
  ): Promise<Map<string, string>>;
  assignMultipleDevicesByCriteriaInScope(
    requests: DeviceAllocationRequest[],
    timeoutMs: number,
  ): Promise<Map<string, string>>;
  deviceHeldByExistingSession(sessionId: string): PooledDevice | undefined;
  heldDeviceDisqualification(
    request: DeviceAllocationRequest,
    device: PooledDevice,
  ): string | undefined;
  recordHeldAssignment(request: DeviceAllocationRequest, assignments: Map<string, string>): boolean;
  canClaimMultiDeviceAllocation(ticket: MultiDeviceAllocationTicket): boolean;
  executeMultiDeviceAllocation<T>(
    ticket: MultiDeviceAllocationTicket,
    deadlineMs: number,
    setRefreshFailure: (failure: string | undefined) => void,
    allocate: () => Promise<T>,
  ): Promise<MultiDeviceAllocationOutcome<T>>;
  refreshMultiDeviceInventory(
    ticket: MultiDeviceAllocationTicket,
  ): Promise<DevicePoolRefreshResult | undefined>;
  isPotentialAllocationSupply(device: PooledDevice): boolean;
  potentialSupplyFor(request: DeviceAllocationRequest): PooledDevice[];
  rollbackAssignmentsIndependently(
    assignments: ReadonlyMap<string, RollbackAssignment>,
  ): Promise<void>;
}
type MultiAllocationState = Pick<
  DevicePoolState,
  | "sessionManager"
  | "timer"
  | "criteriaMatcher"
  | "recoveryCoordinator"
  | "multiDeviceAllocations"
  | "devices"
  | "androidTransportAliases"
>;
export type MultiAllocationCallbacks = Pick<
  DevicePoolOperations,
  | "ensurePoolRefreshed"
  | "getDevicesByPlatform"
  | "pruneStaleIdleIosDevices"
  | "evictUnavailableIdleDevicesMatching"
  | "tryAssignUnownedDevice"
  | "getStatsForPlatform"
  | "refreshForeignOwnership"
  | "countForeignDrivenDevices"
  | "startAdditionalDevices"
  | "refreshDevicesWithOutcome"
  | "getDevicesMatchingAnyRequest"
  | "getDevicesMatchingCriteria"
  | "startAdditionalDevicesForCriteria"
  | "isCriteriaUnavailableWithoutPendingRecovery"
  | "tryAssignDeviceWithCriteria"
  | "recordCriteriaAssignment"
  | "rollbackAssignments"
  | "getDeviceHealthMarker"
  | "isBindingDevice"
  | "isDrivenByForeignDaemon"
  | "isIdleDeviceEligible"
  | "selectIdleDevice"
  | "assertHealthyAllocationPossible"
  | "shouldWaitForDevice"
  | "countBusyDevices"
  | "hasPendingAndroidRecoveryMatching"
>;

/** Multi Allocation responsibilities of DevicePool. */
export class DevicePoolMultiAllocation {
  constructor(
    private readonly state: MultiAllocationState,
    private readonly callbacks: MultiAllocationCallbacks,
  ) {}
  /**
   * Assign multiple devices to sessions upfront with a shared timeout
   *
   * This is used for multi-device plans where we want to allocate all devices
   * before execution begins, ensuring we fail fast if not enough devices are available.
   *
   * @param sessionIds Array of session IDs to assign devices to
   * @param timeoutMs Total timeout in milliseconds for allocating ALL devices (default: 5 minutes)
   * @returns Map of sessionId -> deviceId for all assigned devices
   * @throws ActionableError if unable to allocate all devices within timeout
   */
  async assignMultipleDevices(
    sessionIds: string[],
    timeoutMs: number = 300000,
    platform?: Platform,
  ): Promise<Map<string, string>> {
    return withAllocationCancellationScope(this.state.sessionManager, () =>
      this.assignMultipleDevicesInScope(sessionIds, timeoutMs, platform),
    );
  }

  async assignMultipleDevicesInScope(
    sessionIds: string[],
    timeoutMs: number,
    platform?: Platform,
  ): Promise<Map<string, string>> {
    const ticket: MultiDeviceAllocationTicket = {
      requests: sessionIds.map((sessionId) => ({ sessionId, criteria: { platform } })),
    };
    try {
      const startTime = this.state.timer.now();
      const assignments = new Map<string, string>();
      const assignmentsToRollback = new Map<string, RollbackAssignment>();
      const requiredCount = sessionIds.length;
      logger.info(
        `[DevicePool] Starting upfront allocation of ${requiredCount} devices ` +
          `(timeout: ${timeoutMs / 1000}s)`,
      );
      // Validate we have enough devices
      let refreshFailure = await this.callbacks.ensurePoolRefreshed();
      const preallocationCandidates = this.callbacks.getDevicesByPlatform(platform);
      await this.callbacks.pruneStaleIdleIosDevices(preallocationCandidates);
      await this.callbacks.evictUnavailableIdleDevicesMatching((device) =>
        matchesPlatformSelector(device.platform, platform),
      );
      const shortfall = await this.startDevicesForPlatformShortfall(
        requiredCount,
        startTime + timeoutMs,
        platform,
      );
      if (shortfall.refresh) {
        refreshFailure = shortfall.refresh.failure;
      }
      assertPoolCapacity(
        this.state.criteriaMatcher,
        shortfall.stats,
        requiredCount,
        platform,
        this.state.recoveryCoordinator.recoveringAndroidImages.size,
        refreshFailureContext(refreshFailure),
      );
      this.state.multiDeviceAllocations.enqueue(ticket);
      // Queue waits consume deadline time, but never allocation attempts.
      const assigned = new Set<string>();
      let firstWaitLogged = false;
      const allocate = () =>
        this.executeMultiDeviceAllocation(
          ticket,
          startTime + timeoutMs,
          (failure) => {
            refreshFailure = failure;
          },
          async () => {
            throwIfRequestAborted();
            // Try to assign all remaining sessions
            while (assigned.size < requiredCount) {
              const sessionId = sessionIds[assigned.size];
              if (this.recordHeldAssignment(ticket.requests[assigned.size], assignments)) {
                assigned.add(sessionId);
                continue;
              }
              const assignResult = await this.callbacks.tryAssignUnownedDevice(sessionId, platform);
              if (assignResult.refreshCompleted) {
                refreshFailure = assignResult.refreshFailure;
              }
              if (assignResult.success) {
                assigned.add(sessionId);
                assignments.set(sessionId, assignResult.deviceId!);
                if (assignResult.session) {
                  assignmentsToRollback.set(sessionId, {
                    deviceId: assignResult.deviceId!,
                    session: assignResult.session,
                  });
                }
                logger.info(
                  `[DevicePool] Allocated device ${assignResult.deviceId} to session ${sessionId} (${assigned.size}/${requiredCount})`,
                );
              } else if (assignResult.livenessUnknown) {
                throw new DevicePoolError(
                  `Unable to verify iOS simulator liveness for session ${sessionId}; iOS discovery failed.`,
                  false,
                );
              } else if (!assignResult.shouldWait) {
                // No devices at all - non-retryable error
                const currentStats = this.callbacks.getStatsForPlatform(platform);
                throw new DevicePoolError(
                  `Failed to allocate devices: no devices available.\n` +
                    `Required: ${requiredCount} devices, allocated: ${assigned.size}\n` +
                    `Device pool status:\n` +
                    `  Total devices: ${currentStats.total}\n` +
                    `  Idle: ${currentStats.idle}\n` +
                    `  Assigned: ${currentStats.assigned}\n` +
                    `  Error: ${currentStats.error}\n\n` +
                    `Suggestions:\n` +
                    `  - Start an emulator or simulator\n` +
                    `  - Check device pool status: auto-mobile --cli listDevices\n` +
                    `  - Verify device tooling is working for the selected platform`,
                  false,
                );
              } else {
                // Devices busy - throw retryable error to wait
                if (!firstWaitLogged) {
                  firstWaitLogged = true;
                  logger.info(
                    `[DevicePool] Waiting for ${requiredCount - assigned.size} more device(s) (${assignResult.totalDevices} total, all currently busy)...`,
                  );
                }
                await this.rollbackAssignmentsIndependently(assignmentsToRollback);
                assignmentsToRollback.clear();
                assignments.clear();
                assigned.clear();
                throw new DevicePoolError("All devices busy", true, refreshFailure);
              }
            }
            // All devices assigned successfully
            return assignments;
          },
        );
      let result: Awaited<ReturnType<typeof allocate>>;
      try {
        result = await allocate();
      } catch (error) {
        await this.rollbackAssignmentsIndependently(assignmentsToRollback);
        throw error;
      }
      if (!result.success) {
        await this.rollbackAssignmentsIndependently(assignmentsToRollback);
        throwIfRequestAborted();
        // Timeout case
        const elapsed = this.state.timer.now() - startTime;
        const currentStats = this.callbacks.getStatsForPlatform(platform);
        throw new ActionableError(
          `Timed out allocating devices after ${Math.round(elapsed / 1000)}s ` +
            `(${describeMultiDeviceAllocationAttempts(result)}).\n` +
            refreshFailureContext(refreshFailure) +
            `Required: ${requiredCount} devices\n` +
            `Device pool status:\n` +
            `  Total devices: ${currentStats.total}\n` +
            `  Idle: ${currentStats.idle}\n` +
            `  Assigned: ${currentStats.assigned}\n` +
            `  Error: ${currentStats.error}\n\n` +
            `Suggestions:\n` +
            `  - Reduce parallel test count to match available devices\n` +
            `  - Start additional emulators or connect more physical devices\n` +
            `  - Increase device allocation timeout\n` +
            `  - Check if tests are properly releasing devices after completion`,
        );
      }
      const totalElapsed = this.state.timer.now() - startTime;
      logger.info(
        `[DevicePool] Successfully allocated ${requiredCount} devices ` +
          `in ${totalElapsed}ms (${result.attempts} attempts)`,
      );
      return result.value!;
    } finally {
      this.state.multiDeviceAllocations.remove(ticket);
    }
  }

  /**
   * Boot startable images for a platform allocation that has too few devices. Another daemon's
   * device cannot serve the plan until that daemon lets it go, so it does not count against
   * booting a startable image (mt-0083 D2). Returns the pool stats to judge capacity by.
   */
  async startDevicesForPlatformShortfall(
    requiredCount: number,
    deadlineMs: number,
    platform: Platform | undefined,
  ): Promise<{
    stats: ReturnType<DevicePoolOperations["getStatsForPlatform"]>;
    refresh?: {
      failure: string | undefined;
    };
  }> {
    const stats = this.callbacks.getStatsForPlatform(platform);
    await this.callbacks.refreshForeignOwnership();
    const usableTotal = stats.total - this.callbacks.countForeignDrivenDevices(platform);
    if (usableTotal >= requiredCount) {
      return { stats };
    }
    const started = await this.callbacks.startAdditionalDevices(
      requiredCount - usableTotal,
      deadlineMs,
      platform,
    );
    if (started > 0) {
      const refresh = { failure: (await this.callbacks.refreshDevicesWithOutcome()).failure };
      return { stats: this.callbacks.getStatsForPlatform(platform), refresh };
    }
    // A queued Android start may have joined a boot without launching a device.
    return { stats: platform === "android" ? this.callbacks.getStatsForPlatform(platform) : stats };
  }

  /**
   * Assign multiple devices with per-session criteria.
   *
   * This is used when plans specify device definitions (platform/type/version).
   * When no booted device matches a request, a matching shutdown image may be
   * started before allocation.
   */
  async assignMultipleDevicesByCriteria(
    requests: DeviceAllocationRequest[],
    timeoutMs: number = 300000,
  ): Promise<Map<string, string>> {
    return withAllocationCancellationScope(this.state.sessionManager, () =>
      this.assignMultipleDevicesByCriteriaInScope(requests, timeoutMs),
    );
  }

  async assignMultipleDevicesByCriteriaInScope(
    requests: DeviceAllocationRequest[],
    timeoutMs: number,
  ): Promise<Map<string, string>> {
    const ticket: MultiDeviceAllocationTicket = { requests };
    try {
      const startTime = this.state.timer.now();
      const assignments = new Map<string, string>();
      const assignmentsToRollback = new Map<string, RollbackAssignment>();
      const requiredCount = requests.length;
      if (requiredCount === 0) {
        return assignments;
      }
      logger.info(
        `[DevicePool] Starting criteria-based allocation of ${requiredCount} devices ` +
          `(timeout: ${timeoutMs / 1000}s)`,
      );
      let refreshFailure = await this.callbacks.ensurePoolRefreshed();
      const sortedRequests = this.state.criteriaMatcher.sortBySpecificity(requests);
      await this.callbacks.pruneStaleIdleIosDevices(
        this.callbacks.getDevicesMatchingAnyRequest(sortedRequests),
      );
      await this.callbacks.evictUnavailableIdleDevicesMatching((device) =>
        sortedRequests.some(
          (request) =>
            this.state.criteriaMatcher.filterDevices([device], request.criteria).length > 0,
        ),
      );
      const needsRefresh = this.criteriaNeedRefresh(sortedRequests);
      if (needsRefresh) {
        refreshFailure = (await this.callbacks.refreshDevicesWithOutcome()).failure;
      }
      await this.callbacks.refreshForeignOwnership();
      const started = await this.callbacks.startAdditionalDevicesForCriteria(
        sortedRequests,
        startTime + timeoutMs,
      );
      if (started > 0) {
        logger.info(
          `[DevicePool] Started ${started} additional device(s) for criteria-based allocation`,
        );
      }
      for (const request of requests) {
        const candidates = this.callbacks.getDevicesMatchingCriteria(request.criteria);
        if (
          this.callbacks.isCriteriaUnavailableWithoutPendingRecovery(
            candidates.length > 0,
            request.criteria,
          )
        ) {
          const summary = this.state.criteriaMatcher.formatCriteriaSummary(request.criteria);
          throw new ActionableError(
            `No devices match criteria for session ${request.sessionId}${summary}.\n` +
              refreshFailureContext(refreshFailure) +
              `Ensure the required devices are installed, startable, and available.`,
          );
        }
      }
      // There is no configured pool maximum. A short current inventory may
      // grow through another flow, so preserve waiting for additional devices.
      this.state.multiDeviceAllocations.enqueue(ticket);
      let attemptCount = 0;
      let allocationCompleted = false;
      try {
        const result = await this.executeMultiDeviceAllocation(
          ticket,
          startTime + timeoutMs,
          (failure) => {
            refreshFailure = failure;
          },
          async () => {
            for (const request of sortedRequests) {
              if (assignments.has(request.sessionId)) {
                continue;
              }
              if (this.recordHeldAssignment(request, assignments)) {
                continue;
              }
              const result = await this.callbacks.tryAssignDeviceWithCriteria(
                request.sessionId,
                request.criteria,
              );
              if (result.refreshCompleted) {
                refreshFailure = result.refreshFailure;
              }
              if (result.success) {
                this.callbacks.recordCriteriaAssignment(
                  request,
                  result,
                  assignments,
                  assignmentsToRollback,
                );
                logger.info(
                  `[DevicePool] Allocated device ${result.deviceId} to session ${request.sessionId} ` +
                    `(${assignments.size}/${requiredCount})`,
                );
              } else if (result.livenessUnknown) {
                throw new ActionableError(
                  `Unable to verify iOS simulator liveness for session ${request.sessionId}; iOS discovery failed.`,
                );
              } else if (!result.shouldWait) {
                const summary = this.state.criteriaMatcher.formatCriteriaSummary(request.criteria);
                throw new ActionableError(
                  `Failed to allocate device for session ${request.sessionId}${summary}.\n` +
                    `No matching devices are currently available.\n` +
                    `Suggestions:\n` +
                    `  - Boot a simulator or emulator that matches the requested criteria\n` +
                    `  - Wait for a device to become idle\n` +
                    `  - Reduce parallel test count to match available devices`,
                );
              }
            }
            if (assignments.size < requiredCount) {
              // Never retain new claims while waiting; existing sessions survive.
              await this.callbacks.rollbackAssignments(assignmentsToRollback);
              assignmentsToRollback.clear();
              assignments.clear();
              throw new DevicePoolError("All devices busy", true, refreshFailure);
            }
            return assignments;
          },
        );
        attemptCount = result.attempts;
        if (!result.success) {
          const elapsed = this.state.timer.now() - startTime;
          throw new ActionableError(
            `Timed out allocating devices after ${Math.round(elapsed / 1000)}s ` +
              `(${describeMultiDeviceAllocationAttempts(result)}).\n` +
              refreshFailureContext(refreshFailure) +
              `Required: ${requiredCount} devices\n` +
              `Suggestions:\n` +
              `  - Boot additional simulators or emulators that match the plan requirements\n` +
              `  - Reduce the number of devices required in the test plan\n` +
              `  - Increase device allocation timeout`,
          );
        }
        allocationCompleted = true;
      } finally {
        if (!allocationCompleted) {
          await this.rollbackAssignmentsIndependently(assignmentsToRollback);
        }
      }
      const totalElapsed = this.state.timer.now() - startTime;
      logger.info(
        `[DevicePool] Successfully allocated ${requiredCount} devices by criteria ` +
          `in ${totalElapsed}ms (${attemptCount} attempts)`,
      );
      return assignments;
    } finally {
      this.state.multiDeviceAllocations.remove(ticket);
    }
  }

  /**
   * The device an existing session already owns in this pool, if any. Such a
   * session takes no new claim, so a multi-device request counts that device
   * toward its total instead of waiting for an idle device it will not use.
   */
  deviceHeldByExistingSession(sessionId: string): PooledDevice | undefined {
    const session = this.state.sessionManager.getSession(sessionId);
    if (!session) {
      return undefined;
    }
    const device = this.state.devices.get(session.assignedDevice);
    return holderOf(device) === sessionId ? device : undefined;
  }

  /**
   * Why a session's held device cannot serve a request: the same platform,
   * criteria and health rules an idle candidate must meet. Undefined when it can.
   */
  heldDeviceDisqualification(
    request: DeviceAllocationRequest,
    device: PooledDevice,
  ): string | undefined {
    if (this.state.criteriaMatcher.filterDevices([device], request.criteria).length === 0) {
      return (
        `it does not match the requested criteria` +
        `${this.state.criteriaMatcher.formatCriteriaSummary(request.criteria)}`
      );
    }
    if (isErrored(device)) {
      return "the device is in an error state";
    }
    const marker = this.callbacks.getDeviceHealthMarker(device.id);
    return marker ? `the device is unhealthy (${marker.reason}, since ${marker.since})` : undefined;
  }

  /**
   * Records the device an existing session (e.g. an executePlan base session)
   * already holds (#10153). It needs no idle device and is never rolled back.
   * A held device that cannot serve the request fails the allocation: the
   * session keeps its device rather than silently moving to another one.
   */
  recordHeldAssignment(
    request: DeviceAllocationRequest,
    assignments: Map<string, string>,
  ): boolean {
    const held = this.deviceHeldByExistingSession(request.sessionId);
    if (!held) {
      return false;
    }
    const disqualification = this.heldDeviceDisqualification(request, held);
    if (disqualification) {
      throw new ActionableError(
        `Session '${request.sessionId}' already holds device '${held.id}', but ${disqualification}.\n` +
          `A device label mapped to an existing session must use that session's device.\n` +
          `Suggestions:\n` +
          `  - Release the session or select a device that matches the plan's device requirements\n` +
          `  - Recover or replace the device (killDevice/startDevice) and retry`,
      );
    }
    assignments.set(request.sessionId, held.id);
    return true;
  }

  canClaimMultiDeviceAllocation(ticket: MultiDeviceAllocationTicket): boolean {
    // Sessions that already hold a pooled device need no new claim and must
    // survive rollback; anything else (including a session whose device left
    // the pool) counts as a claim, matching recordHeldAssignment.
    const claims: DeviceAllocationRequest[] = [];
    for (const request of ticket.requests) {
      const held = this.deviceHeldByExistingSession(request.sessionId);
      if (!held) {
        claims.push(request);
      } else if (this.heldDeviceDisqualification(request, held)) {
        // Let the attempt fail fast with the reason instead of waiting.
        return true;
      }
    }
    // A ticket that claims nothing cannot take a device from an earlier waiter,
    // so it is exempt from the queue (#10153).
    if (claims.length === 0) {
      return true;
    }
    if (this.state.multiDeviceAllocations.isQueuedBehindConflictingRequest(ticket)) {
      return false;
    }
    const available = new Set<string>();
    let canClaim = true;
    for (const request of this.state.criteriaMatcher.sortBySpecificity(claims)) {
      const matching = this.callbacks
        .getDevicesMatchingCriteria(request.criteria)
        .filter((candidate) => !this.callbacks.isBindingDevice(candidate));
      const candidates = matching.filter(
        (candidate) => !this.callbacks.isDrivenByForeignDaemon(candidate),
      );
      const device = candidates.find(
        (candidate) =>
          this.callbacks.isIdleDeviceEligible(candidate) && !available.has(candidate.id),
      );
      if (!device) {
        const idle = this.callbacks.selectIdleDevice(candidates);
        // Healthy idle capacity already counted for another request may grow
        // later; it is neither a health failure nor a reason to claim partially.
        // Another daemon's device is healthy capacity that frees later, so wait for it.
        if (matching.length === candidates.length) {
          this.callbacks.assertHealthyAllocationPossible(candidates, idle);
        }
        if (
          !idle &&
          !this.callbacks.shouldWaitForDevice(
            // Another daemon's device is busy from here: it frees when that daemon lets it go.
            this.callbacks.countBusyDevices(candidates) + (matching.length - candidates.length),
            this.callbacks.hasPendingAndroidRecoveryMatching(request.criteria),
          )
        ) {
          // Let the real attempt refresh once and report authoritative absence
          // (or recover an errored entry), as single-attempt allocation does.
          return true;
        }
        canClaim = false;
        continue;
      }
      available.add(device.id);
    }
    return canClaim;
  }

  async executeMultiDeviceAllocation<T>(
    ticket: MultiDeviceAllocationTicket,
    deadlineMs: number,
    setRefreshFailure: (failure: string | undefined) => void,
    allocate: () => Promise<T>,
  ): Promise<MultiDeviceAllocationOutcome<T>> {
    let attempts = 0;
    let waited = false;
    let lastBlock: MultiDeviceAllocationBlock | undefined;
    while (true) {
      if (waited) {
        await this.state.multiDeviceAllocations.waitForMultiDeviceRetry(deadlineMs);
        const refreshed = await this.refreshMultiDeviceInventory(ticket);
        if (refreshed) {
          setRefreshFailure(refreshed.failure);
        }
      }
      throwIfRequestAborted();
      if (this.state.timer.now() >= deadlineMs && waited) {
        return { success: false, attempts, lastBlock };
      }
      waited = true;
      await this.callbacks.refreshForeignOwnership();
      // A session may gain or lose its device while the ticket waits (e.g.
      // session-preserving recovery), so deadlock analysis reads a fresh pin.
      this.state.multiDeviceAllocations.recordHeldSessions(ticket);
      if (!this.canClaimMultiDeviceAllocation(ticket)) {
        lastBlock = this.state.multiDeviceAllocations.multiDeviceAllocationBlock(ticket);
        this.state.multiDeviceAllocations.throwIfMultiDeviceAllocationDeadlocked(ticket);
        if (this.state.timer.now() >= deadlineMs) {
          return { success: false, attempts, lastBlock };
        }
        continue;
      }
      attempts++;
      lastBlock = "contention";
      try {
        return { success: true, value: await allocate(), attempts };
      } catch (error) {
        if (!(error instanceof DevicePoolError) || !error.isRetryable) {
          throw error instanceof DevicePoolError ? new ActionableError(error.message) : error;
        }
        // Contention is expected; allocate released this round's new claims.
        logger.debug("Multi-device allocation will retry after contention", error);
      }
    }
  }

  async refreshMultiDeviceInventory(
    ticket: MultiDeviceAllocationTicket,
  ): Promise<DevicePoolRefreshResult | undefined> {
    // Busy-only rounds must retain the last actual discovery failure. Refresh
    // only for missing capacity; releases already publish availability directly.
    const candidates = this.callbacks.getDevicesMatchingAnyRequest(ticket.requests);
    if (
      candidates.length < ticket.requests.length ||
      ticket.requests.some(
        (request) => this.callbacks.getDevicesMatchingCriteria(request.criteria).length === 0,
      )
    ) {
      return this.callbacks.refreshDevicesWithOutcome();
    }
    return undefined;
  }

  /**
   * Whether a device could serve a claim once its holder releases it. Error,
   * unhealthy and unassignable transport-alias devices never pass
   * isIdleDeviceEligible after a release, so they are not supply.
   */
  isPotentialAllocationSupply(device: PooledDevice): boolean {
    return (
      !isErrored(device) &&
      this.state.androidTransportAliases.isAssignable({
        deviceId: device.id,
        name: device.name,
        platform: device.platform,
      }) &&
      !this.callbacks.getDeviceHealthMarker(device.id)
    );
  }

  /** Devices matching a request that could ever be allocated to it. */
  potentialSupplyFor(request: DeviceAllocationRequest): PooledDevice[] {
    return this.callbacks
      .getDevicesMatchingCriteria(request.criteria)
      .filter((device) => this.isPotentialAllocationSupply(device));
  }

  /**
   * Roll back each entry of a failed multi-device allocation on its own, so one failed release
   * cannot strand the remaining claims (#11091). Used by both the criteria and platform paths.
   */
  async rollbackAssignmentsIndependently(
    assignments: ReadonlyMap<string, RollbackAssignment>,
  ): Promise<void> {
    for (const [sessionId, allocation] of assignments) {
      try {
        await this.callbacks.rollbackAssignments(new Map([[sessionId, allocation]]));
      } catch (error) {
        logger.warn(
          `[DevicePool] Failed to roll back multi-device allocation for ${sessionId} on ${allocation.deviceId}`,
          error,
        );
      }
    }
  }

  private criteriaNeedRefresh(requests: DeviceAllocationRequest[]): boolean {
    return requests.some(
      (request) => this.callbacks.getDevicesMatchingCriteria(request.criteria).length === 0,
    );
  }
}

export function connectMultiAllocation(
  part: () => DevicePoolMultiAllocation,
  seams: Pick<DevicePoolOperations, "assignMultipleDevices" | "assignMultipleDevicesByCriteria">,
): MultiAllocationOperations {
  return {
    assignMultipleDevices: (...args) => seams.assignMultipleDevices(...args),
    assignMultipleDevicesInScope: (...args) => part().assignMultipleDevicesInScope(...args),
    startDevicesForPlatformShortfall: (...args) => part().startDevicesForPlatformShortfall(...args),
    assignMultipleDevicesByCriteria: (...args) => seams.assignMultipleDevicesByCriteria(...args),
    assignMultipleDevicesByCriteriaInScope: (...args) =>
      part().assignMultipleDevicesByCriteriaInScope(...args),
    deviceHeldByExistingSession: (...args) => part().deviceHeldByExistingSession(...args),
    heldDeviceDisqualification: (...args) => part().heldDeviceDisqualification(...args),
    recordHeldAssignment: (...args) => part().recordHeldAssignment(...args),
    canClaimMultiDeviceAllocation: (...args) => part().canClaimMultiDeviceAllocation(...args),
    executeMultiDeviceAllocation<T>(
      ticket: MultiDeviceAllocationTicket,
      deadlineMs: number,
      setRefreshFailure: (failure: string | undefined) => void,
      allocate: () => Promise<T>,
    ): Promise<MultiDeviceAllocationOutcome<T>> {
      return part().executeMultiDeviceAllocation(ticket, deadlineMs, setRefreshFailure, allocate);
    },
    refreshMultiDeviceInventory: (...args) => part().refreshMultiDeviceInventory(...args),
    isPotentialAllocationSupply: (...args) => part().isPotentialAllocationSupply(...args),
    potentialSupplyFor: (...args) => part().potentialSupplyFor(...args),
    rollbackAssignmentsIndependently: (...args) => part().rollbackAssignmentsIndependently(...args),
  };
}
