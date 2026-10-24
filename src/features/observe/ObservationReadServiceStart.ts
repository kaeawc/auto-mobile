import { RunnerReadinessError } from "../../ctrlProxy/RunnerReadinessError";
import {
  getSharedIosRunnerLaunchQueueView,
  type IosRunnerLaunchQueueView,
  type IosRunnerLaunchQueueStatus,
} from "../../ctrlProxy/ios/IosRunnerLaunchGate";
import { RunnerLaunchQueuedError } from "../../ctrlProxy/ios/RunnerLaunchQueuedError";
import { isIdle, holderOf } from "../../daemon/deviceBinding";
import { AndroidCtrlProxyClient } from "./android";
import { IOSCtrlProxyClient } from "./ios";
import type { BootedDevice } from "../../models";
import { defaultDaemonContext } from "../../daemon/daemonContext";
import { ActionableError } from "../../models/ActionableError";
import { SingleFlight } from "../../utils/cache/SingleFlight";
import {
  deviceReadinessLockKey,
  getDeviceAcquisitionReadiness,
  isDeviceReadinessLocked,
} from "../../utils/deviceReadinessLock";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { RunnerReadinessService } from "../../ctrlProxy/RunnerReadinessService";
import { createDefaultRunnerReadinessService } from "../../daemon/defaultRunnerReadinessService";
import { serverConfig } from "../../utils/ServerConfig";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

export function existingHierarchyClient(
  device: BootedDevice,
): AndroidCtrlProxyClient | IOSCtrlProxyClient | null {
  return device.platform === "ios"
    ? IOSCtrlProxyClient.getExistingInstance(device.deviceId)
    : AndroidCtrlProxyClient.getExistingInstance(device.deviceId);
}

/** Admission only: never resolves sessions or changes pool state. */
export interface ObservationServiceOwnershipGuard {
  canStart(device: BootedDevice): boolean;
  /** True when an in-flight pool transition required a wait. */
  awaitTransition?(device: BootedDevice, signal?: AbortSignal): Promise<boolean>;
}

export const daemonObservationServiceOwnershipGuard: ObservationServiceOwnershipGuard = {
  async awaitTransition(device, signal) {
    return (
      defaultDaemonContext.devicePool()?.waitForAssignmentTransition(device.deviceId, signal) ??
      false
    );
  },
  canStart(device) {
    const pool = defaultDaemonContext.devicePool();
    if (!pool) {
      return false;
    }
    const pooled = pool.getDevice(device.deviceId);
    return (
      !getDeviceAcquisitionReadiness(deviceReadinessLockKey(device.platform, device.deviceId)) &&
      pooled?.platform === device.platform &&
      pooled.name === device.name &&
      isIdle(pooled) &&
      !holderOf(pooled) &&
      pool.isSafeForObservationServiceStart(device.deviceId)
    );
  },
};

export interface ObservationPoolPickup {
  available(): boolean;
  isPooled(device: BootedDevice): boolean;
  ensurePooled(device: BootedDevice, signal?: AbortSignal): Promise<void>;
}

const daemonPoolPickup: ObservationPoolPickup = {
  available: () => defaultDaemonContext.devicePoolWrites() !== undefined,
  isPooled: (device) => Boolean(defaultDaemonContext.devicePool()?.getDevice(device.deviceId)),
  ensurePooled: async (device) => {
    await defaultDaemonContext.devicePoolWrites()?.pickUpRunningDevice(device);
  },
};

// Foreign or non-assignable devices must not trigger pickup on every observe.
const UNPOOLED_PICKUP_THROTTLE_MS = 10_000;

export interface ObservationServiceStartRequest {
  device: BootedDevice;
  deadlineMs: number;
  signal?: AbortSignal;
}

interface LaunchQueueSnapshot {
  status?: IosRunnerLaunchQueueStatus;
}

/** One flight per device. Individual reads abandon their wait without cancelling other readers. */
export class ObservationReadServiceStart {
  private readonly queueSnapshots = new Map<string, LaunchQueueSnapshot>();
  private readonly flights = new SingleFlight<string, boolean>();
  private readonly pickupFlights = new SingleFlight<string, string | undefined>();
  private readonly unpooledPickupAt = new Map<string, number>();
  private readonly poolPickup: ObservationPoolPickup;
  private readonly timer: Timer;
  private readonly guard: ObservationServiceOwnershipGuard;

  constructor(
    private readonly options: {
      timer?: Timer;
      launchQueue?: IosRunnerLaunchQueueView;
      ownershipGuard?: ObservationServiceOwnershipGuard;
      poolPickup?: ObservationPoolPickup;
      readiness?: Pick<RunnerReadinessService, "ensureReady">;
      skipCtrlProxyDownload?: () => boolean;
      isServiceConnected?: (device: BootedDevice) => boolean;
    } = {},
  ) {
    this.timer = options.timer ?? defaultTimer;
    this.guard = options.ownershipGuard ?? daemonObservationServiceOwnershipGuard;
    this.poolPickup = options.poolPickup ?? daemonPoolPickup;
  }

  async start(request: ObservationServiceStartRequest): Promise<boolean> {
    request.signal?.throwIfAborted();
    if (!this.guard.canStart(request.device)) {
      if (this.poolPickup.available() && !this.poolPickup.isPooled(request.device)) {
        await this.pickupIfUnpooled(request);
      }
      await this.admit(request);
    }
    const key = deviceReadinessLockKey(request.device.platform, request.device.deviceId);
    // Each waiter retains the flight's snapshot even after setup removes the map entry.
    const snapshot = this.queueSnapshotFor(key);
    try {
      return await raceWithDeadline(
        () =>
          this.flights.run(
            key,
            (signal) => this.setup({ request, flightSignal: signal, snapshot }),
            request.signal,
            {
              cancelWhenAllWaitersAbort: true,
            },
          ),
        {
          timer: this.timer,
          timeoutMs: Math.max(0, request.deadlineMs - this.timer.now()),
          signal: request.signal,
          label: "Observer hierarchy service start",
        },
      );
    } catch (error) {
      request.signal?.throwIfAborted();
      logger.warn(`[observe] Hierarchy service start failed: ${errorMessage(error)}`, error);
      return this.rethrowStartupFailure(error, request, snapshot);
    } finally {
      // setup may still be running for other readers; their closures retain this snapshot.
      if (!this.flights.has(key)) {
        this.clearQueueSnapshot(key, snapshot);
      }
    }
  }

  private async admit(request: ObservationServiceStartRequest): Promise<void> {
    const awaitTransition = this.guard.awaitTransition?.bind(this.guard);
    let iterations = 0;
    while (!this.guard.canStart(request.device)) {
      const remaining = request.deadlineMs - this.timer.now();
      // An expired deadline intentionally falls through to the same decline.
      if (!awaitTransition || remaining <= 0 || iterations >= 8) {
        break;
      }
      iterations++;
      const waited = await raceWithDeadline(() => awaitTransition(request.device, request.signal), {
        timer: this.timer,
        timeoutMs: remaining,
        signal: request.signal,
        label: "Observer pool assignment transition",
      });
      if (!waited) {
        break;
      }
    }
    if (!this.guard.canStart(request.device)) {
      throw new ActionableError(
        "service start declined: ownership or pool transition cannot be excluded",
      );
    }
  }

  private queueSnapshotFor(key: string): LaunchQueueSnapshot {
    const snapshot = this.flights.has(key) ? (this.queueSnapshots.get(key) ?? {}) : {};
    this.queueSnapshots.set(key, snapshot);
    return snapshot;
  }

  private clearQueueSnapshot(key: string, snapshot: LaunchQueueSnapshot): void {
    if (this.queueSnapshots.get(key) === snapshot) {
      this.queueSnapshots.delete(key);
    }
  }

  private rethrowStartupFailure(
    error: unknown,
    request: ObservationServiceStartRequest,
    snapshot: LaunchQueueSnapshot,
  ): never {
    const timedOut =
      (error instanceof RunnerReadinessError && error.deadlineExhausted) ||
      (error instanceof Error &&
        error.message.startsWith("Observer hierarchy service start timed out"));
    const status = timedOut
      ? (snapshot.status ?? this.launchQueueStatus(request.device))
      : undefined;
    if (status) {
      throw new RunnerLaunchQueuedError(request.device.deviceId, status, { cause: error });
    }
    throw error;
  }

  private launchQueueStatus(device: BootedDevice): IosRunnerLaunchQueueStatus | undefined {
    return device.platform === "ios"
      ? (this.options.launchQueue ?? getSharedIosRunnerLaunchQueueView()).queueStatus(
          device.deviceId,
        )
      : undefined;
  }

  private async pickupIfUnpooled(request: ObservationServiceStartRequest): Promise<void> {
    const { device } = request;
    if (this.poolPickup.isPooled(device)) {
      return;
    }
    const remaining = request.deadlineMs - this.timer.now();
    if (remaining <= 0) {
      throw new ActionableError("Observer device pool pickup timed out before pickup");
    }
    const key = deviceReadinessLockKey(device.platform, device.deviceId);
    // Bound each reader's wait; pickup stays shared when one reader leaves.
    const failure = await raceWithDeadline(
      () =>
        this.pickupFlights.run(
          key,
          async () => {
            const pickupAt = this.unpooledPickupAt.get(key);
            if (
              this.poolPickup.isPooled(device) ||
              (pickupAt !== undefined && this.timer.now() - pickupAt < UNPOOLED_PICKUP_THROTTLE_MS)
            ) {
              return;
            }
            let failure: string | undefined;
            try {
              await this.poolPickup.ensurePooled(device);
            } catch (error) {
              failure = errorMessage(error);
              logger.warn(`[observe] Device pool pickup failed: ${failure}`, error);
            }
            if (!this.poolPickup.isPooled(device)) {
              this.unpooledPickupAt.set(key, this.timer.now());
            } else {
              this.unpooledPickupAt.delete(key);
            }
            return failure;
          },
          request.signal,
        ),
      {
        timer: this.timer,
        timeoutMs: remaining,
        signal: request.signal,
        label: "Observer device pool pickup",
      },
    );
    if (!this.poolPickup.isPooled(device)) {
      if (failure !== undefined) {
        throw new ActionableError(
          `Device ${device.deviceId} is running but could not be added to this daemon's device pool: ${failure}; call startDevice for it.`,
        );
      }
      throw new ActionableError(
        `Device ${device.deviceId} is running but not known to this daemon's device pool; call startDevice for it (or retry once the daemon has discovered it).`,
      );
    }
  }

  private async setup(options: {
    request: ObservationServiceStartRequest;
    flightSignal?: AbortSignal;
    snapshot: LaunchQueueSnapshot;
  }): Promise<boolean> {
    const { request, flightSignal, snapshot } = options;
    snapshot.status = undefined;
    // A stale failed dial can arrive after the earlier flight completed. Reuse
    // its resident client rather than resetting a service that is now healthy.
    if (
      (
        this.options.isServiceConnected ??
        ((device) => existingHierarchyClient(device)?.isConnected() === true)
      )(request.device)
    ) {
      return false;
    }
    const key = deviceReadinessLockKey(request.device.platform, request.device.deviceId);
    if (isDeviceReadinessLocked(key)) {
      throw new ActionableError("service start declined: device readiness is in progress");
    }
    const remaining = request.deadlineMs - this.timer.now();
    if (remaining <= 0) {
      throw new ActionableError("Observer hierarchy service start timed out before setup");
    }
    // The first read supplies the shared setup's ceiling. Its cancellation only
    // cancels setup when every waiter aborts; later readers retain their own bounds.
    const deadline = new AbortController();
    const timeout = this.timer.setTimeout(() => {
      snapshot.status = this.launchQueueStatus(request.device);
      deadline.abort(new ActionableError("Observer hierarchy service start timed out"));
    }, remaining);
    const signal = flightSignal
      ? AbortSignal.any([flightSignal, deadline.signal])
      : deadline.signal;
    try {
      const readiness = this.options.readiness ?? createDefaultRunnerReadinessService(this.timer);
      await raceWithDeadline(
        () =>
          readiness.ensureReady({
            device: request.device,
            requestedIdentity: request.device.deviceId,
            operationName: "observe deviceId",
            totalDeadlineMs: request.deadlineMs,
            readinessTimeoutMs: remaining,
            signal,
            skipCtrlProxyDownload: (
              this.options.skipCtrlProxyDownload ??
              (() => serverConfig.isSkipCtrlProxyDownloadEnabled())
            )(),
            assertCanSetup: () => {
              signal.throwIfAborted();
              if (!this.guard.canStart(request.device)) {
                throw new ActionableError(
                  "service start declined: ownership or pool transition changed while waiting for readiness",
                );
              }
            },
          }),
        {
          timer: this.timer,
          signal,
          timeoutMs: remaining,
          label: "Observer hierarchy service start",
        },
      );
      return true;
    } finally {
      this.timer.clearTimeout(timeout);
      this.clearQueueSnapshot(key, snapshot);
    }
  }
}

const starters = new WeakMap<Timer, ObservationReadServiceStart>();
export function getObservationReadServiceStart(timer: Timer): ObservationReadServiceStart {
  let starter = starters.get(timer);
  if (!starter) {
    starter = new ObservationReadServiceStart({ timer });
    starters.set(timer, starter);
  }
  return starter;
}
