import { ServiceStartTransitionDeclinedError } from "./ServiceStartTransitionDeclinedError";
export { ServiceStartTransitionDeclinedError } from "./ServiceStartTransitionDeclinedError";
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
import { AdjustableDeadline } from "../../utils/AdjustableDeadline";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type {
  RunnerReadinessRequest,
  RunnerReadinessService,
} from "../../ctrlProxy/RunnerReadinessService";
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
const MAX_TRANSITION_WAITS = 8;
/**
 * Launch phase: an iOS start flight may run this long from the moment its runner launch is
 * admitted (or from the flight start when the launch never queued).
 */
export const IOS_SERVICE_START_FLIGHT_CEILING_MS = 60_000;
/**
 * Queue phase (#15227): while the runner launch waits in the launch gate (#15103) the flight is
 * bounded by this wait ceiling instead of the launch ceiling, so a launch admitted late still gets
 * its full launch window rather than being cancelled and requeued.
 */
export const IOS_SERVICE_START_QUEUE_CEILING_MS = 300_000;

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
      iosFlightCeilingMs?: number;
      iosQueueCeilingMs?: number;
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
    let readerTimedOut = false;
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
          onTimeout: () => {
            readerTimedOut = true;
          },
        },
      );
    } catch (error) {
      request.signal?.throwIfAborted();
      logger.warn(`[observe] Hierarchy service start failed: ${errorMessage(error)}`, error);
      const backgroundStart =
        readerTimedOut && request.device.platform === "ios" && this.flights.has(key);
      return this.rethrowStartupFailure(error, request, snapshot, backgroundStart);
    } finally {
      // setup may still be running for other readers; their closures retain this snapshot.
      if (!this.flights.has(key)) {
        this.clearQueueSnapshot(key, snapshot);
      }
    }
  }

  private async admit(request: ObservationServiceStartRequest): Promise<void> {
    let iterations = 0;
    while (!this.guard.canStart(request.device)) {
      const remaining = request.deadlineMs - this.timer.now();
      // An expired deadline intentionally falls through to the same decline.
      if (!this.guard.awaitTransition || remaining <= 0 || iterations >= MAX_TRANSITION_WAITS) {
        break;
      }
      iterations++;
      const waited = await this.awaitTransition(request.device, request.deadlineMs, request.signal);
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

  private async awaitTransition(
    device: BootedDevice,
    deadlineMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return raceWithDeadline(() => this.guard.awaitTransition!(device, signal), {
      timer: this.timer,
      timeoutMs: Math.max(0, deadlineMs - this.timer.now()),
      signal,
      label: "Observer pool assignment transition",
    });
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
    backgroundStart: boolean,
  ): never {
    const timedOut =
      (error instanceof RunnerReadinessError && error.deadlineExhausted) ||
      (error instanceof Error &&
        error.message.startsWith("Observer hierarchy service start timed out"));
    if (!timedOut || request.device.platform !== "ios") {
      throw error;
    }
    // The flight ceiling or readiness budget can expire after the launch left the queue
    // (admitted but still starting), so a missing queue entry must not demote an expired
    // iOS start to a lost connection (#15214).
    const status = snapshot.status ?? this.launchQueueStatus(request.device);
    throw new RunnerLaunchQueuedError(request.device.deviceId, status, {
      cause: error,
      startWindowExpired: !status && !backgroundStart,
    });
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
    // Cold iOS starts outlive an individual read budget. Only explicit cancellation
    // by all waiters cancels a flight; each reader retains its own deadline.
    const flightMs =
      request.device.platform === "ios"
        ? Math.max(
            remaining,
            this.options.iosFlightCeilingMs ?? IOS_SERVICE_START_FLIGHT_CEILING_MS,
          )
        : remaining;
    const flight = this.startFlightDeadline(request, snapshot, flightMs);
    const signal = flightSignal ? AbortSignal.any([flightSignal, flight.signal]) : flight.signal;
    try {
      const readiness = this.options.readiness ?? createDefaultRunnerReadinessService(this.timer);
      await this.ensureReadyWithTransitions(readiness, {
        device: request.device,
        requestedIdentity: request.device.deviceId,
        operationName: "observe deviceId",
        totalDeadlineMs: flight.totalDeadlineMs,
        deadline: flight.deadline,
        readinessTimeoutMs: flightMs,
        signal,
        skipCtrlProxyDownload: (
          this.options.skipCtrlProxyDownload ??
          (() => serverConfig.isSkipCtrlProxyDownloadEnabled())
        )(),
        assertCanSetup: () => {
          signal.throwIfAborted();
          if (!this.guard.canStart(request.device)) {
            throw new ServiceStartTransitionDeclinedError(
              "service start declined: ownership or pool transition changed while waiting for readiness",
            );
          }
        },
      });
      return true;
    } finally {
      flight.stop();
      this.clearQueueSnapshot(key, snapshot);
    }
  }

  /**
   * Arm the flight's own ceiling. An iOS flight has a synthetic ceiling that follows the launch
   * queue; Android keeps the reader's fixed deadline.
   */
  private startFlightDeadline(
    request: ObservationServiceStartRequest,
    snapshot: LaunchQueueSnapshot,
    flightMs: number,
  ): {
    signal: AbortSignal;
    totalDeadlineMs: number;
    deadline: AdjustableDeadline | undefined;
    stop: () => void;
  } {
    const expired = new AbortController();
    const expire = (): void => {
      snapshot.status = this.launchQueueStatus(request.device);
      expired.abort(new ActionableError("Observer hierarchy service start timed out"));
    };
    if (request.device.platform !== "ios") {
      const handle = this.timer.setTimeout(expire, flightMs);
      return {
        signal: expired.signal,
        totalDeadlineMs: request.deadlineMs,
        deadline: undefined,
        stop: () => this.timer.clearTimeout(handle),
      };
    }
    const deadline = new AdjustableDeadline(this.timer, this.timer.now() + flightMs);
    const stopWatchingQueue = this.followLaunchQueue(request.device, deadline, flightMs);
    // The queue may already have moved the deadline before the numeric total is read.
    const cancelTimeout = deadline.whenExpired(this.timer, expire);
    return {
      signal: expired.signal,
      totalDeadlineMs: deadline.deadlineMs,
      deadline,
      stop: () => {
        cancelTimeout();
        stopWatchingQueue();
      },
    };
  }

  /**
   * Split the flight into a queue phase and a launch phase (#15227). While the runner launch waits
   * in the launch gate the deadline is the queue ceiling; once the gate admits it the launch window
   * restarts from admission, so a launch that waited most of the ceiling is not cancelled seconds
   * after it finally starts. The total stays bounded by the queue and launch ceilings.
   */
  private followLaunchQueue(
    device: BootedDevice,
    deadline: AdjustableDeadline,
    launchMs: number,
  ): () => void {
    const queueMs = Math.max(
      launchMs,
      this.options.iosQueueCeilingMs ?? IOS_SERVICE_START_QUEUE_CEILING_MS,
    );
    const startedAt = this.timer.now();
    const hardCapMs = startedAt + queueMs + launchMs;
    const moveTo = (deadlineMs: number): void => deadline.set(Math.min(deadlineMs, hardCapMs));
    const enterQueuePhase = (): void =>
      moveTo(Math.max(deadline.deadlineMs, this.timer.now() + queueMs));
    const queue = this.options.launchQueue ?? getSharedIosRunnerLaunchQueueView();
    const stopWatching = queue.watchQueue(device.deviceId, {
      queued: enterQueuePhase,
      admitted: () => moveTo(this.timer.now() + launchMs),
      // A cancelled queue entry has nothing left to wait for; an immediate re-admission fires no event.
      left: () => moveTo(this.timer.now() + launchMs),
    });
    // A launch queued by another start path before this flight joined it fires no event.
    if (queue.queueStatus(device.deviceId)) {
      enterQueuePhase();
    }
    return stopWatching;
  }

  private async ensureReadyWithTransitions(
    readiness: Pick<RunnerReadinessService, "ensureReady">,
    request: RunnerReadinessRequest,
  ): Promise<void> {
    let transitionWaits = 0;
    while (true) {
      const timeoutMs = Math.max(0, totalDeadlineOf(request) - this.timer.now());
      try {
        await raceWithDeadline(
          () =>
            readiness.ensureReady({
              ...request,
              // The health window never outgrows the launch window, even while the flight waits in the queue.
              readinessTimeoutMs: Math.min(timeoutMs, request.readinessTimeoutMs),
            }),
          {
            timer: this.timer,
            signal: request.signal,
            // A movable deadline follows the launch queue; otherwise the budget is fixed.
            ...(request.deadline ? { deadline: request.deadline } : { timeoutMs }),
            label: "Observer hierarchy service start",
          },
        );
        return;
      } catch (error) {
        // ensureReady has released the readiness lock before the pool mutex wait.
        await this.awaitSetupTransition(error, request, transitionWaits);
        transitionWaits++;
      }
    }
  }

  private async awaitSetupTransition(
    error: unknown,
    request: RunnerReadinessRequest,
    transitionWaits: number,
  ): Promise<void> {
    if (
      !(error instanceof ServiceStartTransitionDeclinedError) ||
      !this.guard.awaitTransition ||
      transitionWaits >= MAX_TRANSITION_WAITS ||
      request.signal?.aborted ||
      this.timer.now() >= totalDeadlineOf(request)
    ) {
      throw error;
    }
    let waited: boolean;
    try {
      waited = await this.awaitTransition(request.device, totalDeadlineOf(request), request.signal);
    } catch (transitionError) {
      logger.debug(
        "[observe] Assignment transition wait ended before setup retry",
        transitionError,
      );
      throw error;
    }
    if (!waited || request.signal?.aborted || this.timer.now() >= totalDeadlineOf(request)) {
      throw error;
    }
  }
}

function totalDeadlineOf(request: Pick<RunnerReadinessRequest, "deadline" | "totalDeadlineMs">) {
  return request.deadline?.deadlineMs ?? request.totalDeadlineMs;
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
