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
}

export const daemonObservationServiceOwnershipGuard: ObservationServiceOwnershipGuard = {
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
    await defaultDaemonContext.devicePoolWrites()?.addDevice(device);
  },
};

// Foreign or non-assignable devices must not trigger pickup on every observe.
const UNPOOLED_PICKUP_THROTTLE_MS = 10_000;

export interface ObservationServiceStartRequest {
  device: BootedDevice;
  deadlineMs: number;
  signal?: AbortSignal;
}

/** One flight per device. Individual reads abandon their wait without cancelling other readers. */
export class ObservationReadServiceStart {
  private readonly flights = new SingleFlight<string, boolean>();
  private readonly pickupFlights = new SingleFlight<string, string | undefined>();
  private readonly unpooledPickupAt = new Map<string, number>();
  private readonly poolPickup: ObservationPoolPickup;
  private readonly timer: Timer;
  private readonly guard: ObservationServiceOwnershipGuard;

  constructor(
    private readonly options: {
      timer?: Timer;
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
      if (!this.guard.canStart(request.device)) {
        throw new ActionableError(
          "service start declined: ownership or pool transition cannot be excluded",
        );
      }
    }
    const key = deviceReadinessLockKey(request.device.platform, request.device.deviceId);
    try {
      return await raceWithDeadline(
        () =>
          this.flights.run(
            key,
            (signal) => this.setup({ request, flightSignal: signal }),
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
      throw error;
    }
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
  }): Promise<boolean> {
    const { request, flightSignal } = options;
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
    const timeout = this.timer.setTimeout(
      () => deadline.abort(new ActionableError("Observer hierarchy service start timed out")),
      remaining,
    );
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
