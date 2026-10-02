import { AndroidCtrlProxyClient } from "./android";
import { IOSCtrlProxyClient } from "./ios";
import type { BootedDevice } from "../../models";
import { DaemonState } from "../../daemon/daemonState";
import { ActionableError } from "../../models/ActionableError";
import { SingleFlight } from "../../utils/cache/SingleFlight";
import {
  deviceReadinessLockKey,
  getDeviceAcquisitionReadiness,
  isDeviceReadinessLocked,
} from "../../utils/deviceReadinessLock";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import {
  createDefaultRunnerReadinessService,
  type RunnerReadinessService,
} from "../../utils/RunnerReadinessService";
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
    const daemon = DaemonState.getInstance();
    if (!daemon.isInitialized()) {
      return false;
    }
    const pool = daemon.getDevicePool();
    const pooled = pool.getDevice(device.deviceId);
    return (
      !getDeviceAcquisitionReadiness(deviceReadinessLockKey(device.platform, device.deviceId)) &&
      pooled?.platform === device.platform &&
      pooled.name === device.name &&
      pooled.status === "idle" &&
      !pooled.sessionId &&
      pool.isSafeForObservationServiceStart(device.deviceId)
    );
  },
};

export interface ObservationServiceStartRequest {
  device: BootedDevice;
  deadlineMs: number;
  signal?: AbortSignal;
}

/** One flight per device. Individual reads abandon their wait without cancelling other readers. */
export class ObservationReadServiceStart {
  private readonly flights = new SingleFlight<string, boolean>();
  private readonly timer: Timer;
  private readonly guard: ObservationServiceOwnershipGuard;

  constructor(
    private readonly options: {
      timer?: Timer;
      ownershipGuard?: ObservationServiceOwnershipGuard;
      readiness?: Pick<RunnerReadinessService, "ensureReady">;
      skipCtrlProxyDownload?: () => boolean;
      isServiceConnected?: (device: BootedDevice) => boolean;
    } = {},
  ) {
    this.timer = options.timer ?? defaultTimer;
    this.guard = options.ownershipGuard ?? daemonObservationServiceOwnershipGuard;
  }

  async start(request: ObservationServiceStartRequest): Promise<boolean> {
    request.signal?.throwIfAborted();
    if (!this.guard.canStart(request.device)) {
      throw new ActionableError(
        "service start declined: ownership or pool transition cannot be excluded",
      );
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
