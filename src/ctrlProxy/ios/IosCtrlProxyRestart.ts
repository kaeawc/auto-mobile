import type { IosCtrlProxyRuntime } from "./IosCtrlProxyRuntime";
import { ForceRestartCancelledError } from "./ForceRestartCancelledError";
import type { SharedCtrlProxyStart } from "./IosCtrlProxyLifecycleSteps";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { toActionableError } from "../../models/ActionableError";
import {
  FORCE_RESTART_DRAIN_GRACE_MS,
  FORCE_RESTART_DRAIN_POLL_INTERVAL_MS,
  CtrlProxyStartOptions,
} from "./IosCtrlProxyContracts";

interface IosCtrlProxyRestartHost {
  stop(deadline?: number): Promise<void>;
  assertDeviceNotRetired(): void;
  assertDeviceNotSuspended(): void;
  forceRestart(options?: CtrlProxyStartOptions): Promise<void>;
  waitForReconnectStartup(
    sharedStart: SharedCtrlProxyStart,
    signal: AbortSignal | undefined,
  ): Promise<void>;
  isRunnerStillHealthyAfterForcedTeardown(signal?: AbortSignal): Promise<boolean>;
  allocateReplacementServicePort(retiredServicePort: number): void;
  startAfterForceRestart(
    options: CtrlProxyStartOptions,
    expectedForceRestartGeneration?: number,
  ): Promise<void>;
  checkHealthEndpointOnPortForDevice(
    port: number,
    deviceId: string,
    timeoutMs?: number,
    options?: { requireDeviceId?: boolean },
  ): Promise<boolean>;
  sleepForHealthPoll(delayMs: number, signal?: AbortSignal): Promise<void>;
  extendHealthPollDeadline(
    sharedStart: SharedCtrlProxyStart,
    callerId: symbol,
    minimumHealthPollDurationMs: number | undefined,
  ): void;
  removeHealthPollDeadline(sharedStart: SharedCtrlProxyStart, callerId: symbol | undefined): void;
}

/** Coordinates forced restarts and device-removal recovery without overlapping startup. */
export class IosCtrlProxyRestart {
  constructor(
    private readonly state: Pick<
      IosCtrlProxyRuntime,
      | "removalGeneration"
      | "forcedRestartBudget"
      | "forceRestartGeneration"
      | "forceRestartInFlight"
      | "removalCleanup"
      | "rearmedRemovalGeneration"
      | "sharedStart"
      | "isStopping"
      | "processSupervisor"
      | "servicePort"
      | "unhealthyRetiredPorts"
      | "runnerGeneration"
      | "forceRestartHealthPollDurationsMs"
      | "timer"
      | "device"
    >,
    private readonly host: IosCtrlProxyRestartHost,
  ) {}

  /** Suspend recovery immediately, then retire any runner owned by this device. */
  async suspendForDeviceRemoval(reason = "device disappeared from discovery"): Promise<void> {
    const removalGeneration = ++this.state.removalGeneration;
    this.state.forcedRestartBudget.suspend(reason);
    this.state.forceRestartGeneration++;
    const cleanup = (async () => {
      try {
        await this.state.forceRestartInFlight;
      } catch (error) {
        logger.warn(
          `[IOSCtrlProxy] In-flight restart settled after device removal: ${errorMessage(error)}`,
        );
      }
      await this.host.stop();
    })();
    this.state.removalCleanup = cleanup;
    try {
      await cleanup;
    } catch (error) {
      if (this.state.removalGeneration === removalGeneration) {
        this.state.forcedRestartBudget.suspend(
          `device removal cleanup failed: ${errorMessage(error)}`,
        );
        if (this.state.rearmedRemovalGeneration === removalGeneration) {
          this.state.rearmedRemovalGeneration = removalGeneration - 1;
        }
      }
      throw toActionableError(error, "iOS device removal cleanup failed");
    } finally {
      if (this.state.removalCleanup === cleanup) {
        this.state.removalCleanup = null;
      }
    }
  }

  supersededSinceRemoval(removalGeneration: number): boolean {
    return (
      this.state.removalGeneration !== removalGeneration ||
      this.state.rearmedRemovalGeneration >= removalGeneration ||
      this.state.sharedStart !== null
    );
  }

  /** Rearms after removal cleanup only once per removal generation, when suspended or exhausted. */
  async rearmAfterDeviceReappearance(): Promise<void> {
    const state = this.state.forcedRestartBudget.snapshot().state;
    const removalGeneration = this.state.removalGeneration;
    if (
      (state !== "suspended" && state !== "exhausted") ||
      removalGeneration === this.state.rearmedRemovalGeneration
    ) {
      return;
    }
    if (this.state.removalCleanup) {
      await this.state.removalCleanup;
    }
    if (
      removalGeneration !== this.state.removalGeneration ||
      removalGeneration === this.state.rearmedRemovalGeneration
    ) {
      return;
    }
    this.state.rearmedRemovalGeneration = removalGeneration;
    this.state.forcedRestartBudget.rearm("device reappeared");
  }

  isRecoveryInFlight(): boolean {
    const start = this.state.sharedStart;
    return (
      !!this.state.forceRestartInFlight ||
      (!this.state.isStopping &&
        (this.state.processSupervisor.isRestartPending() ||
          !!(
            start &&
            !start.completed &&
            !start.controller.signal.aborted &&
            !start.teardownCommitted
          )))
    );
  }

  /**
   * Force restart the service (useful when client detects issues)
   */
  async forceRestart(options: CtrlProxyStartOptions = {}): Promise<void> {
    this.host.assertDeviceNotRetired();
    this.host.assertDeviceNotSuspended();
    logger.info("[IOSCtrlProxy] Force restart requested");

    const existingRestart = this.state.forceRestartInFlight;
    if (existingRestart) {
      const restarted = await this.waitForForceRestart(options);
      if (restarted) {
        return;
      }
      return this.host.forceRestart(options);
    }

    const sharedStart = this.state.sharedStart;
    if (
      options.joinInFlightStart &&
      sharedStart &&
      !sharedStart.completed &&
      !sharedStart.controller.signal.aborted &&
      !sharedStart.teardownCommitted
    ) {
      try {
        // Join without disturbing a live startup. If it exceeds its health
        // deadline, fall through to the ordinary teardown and replacement path.
        await this.host.waitForReconnectStartup(sharedStart, options.signal);
        return;
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
        logger.warn(
          `[IOSCtrlProxy] Joined startup failed; forcing replacement: ${errorMessage(error)}`,
        );
      }
    }

    // Stop cannot be interrupted safely. Keep subsequent start/restart callers
    // behind this barrier until teardown settles, even if the initiating
    // readiness phase has already timed out.
    this.state.forceRestartGeneration += 1;
    const retiredServicePort = this.state.servicePort;
    this.state.unhealthyRetiredPorts.add(retiredServicePort);
    const restart = (async () => {
      try {
        await this.host.stop();
        this.host.assertDeviceNotRetired();
        this.host.assertDeviceNotSuspended();
        if (options.signal?.aborted) {
          throw new ForceRestartCancelledError(
            options.signal.reason ?? new Error("iOS CtrlProxy restart was aborted"),
          );
        }
        if (await this.host.isRunnerStillHealthyAfterForcedTeardown(options.signal)) {
          throw new Error(
            "iOS CtrlProxy is still running after forced teardown; refusing to reuse a potentially unresponsive runner",
          );
        }
        this.host.allocateReplacementServicePort(retiredServicePort);
        await this.host.startAfterForceRestart({
          ...options,
          minimumHealthPollDurationMs: this.maximumForceRestartHealthPollDurationMs(
            options.minimumHealthPollDurationMs,
          ),
        });
        this.state.runnerGeneration += 1;
        this.state.unhealthyRetiredPorts.clear();
      } catch (error) {
        if (options.signal?.aborted && !(error instanceof ForceRestartCancelledError)) {
          throw new ForceRestartCancelledError(options.signal.reason ?? error);
        }
        throw error;
      }
    })();
    this.state.forceRestartInFlight = restart;
    void restart
      .finally(() => {
        if (this.state.forceRestartInFlight === restart) {
          this.state.forceRestartInFlight = null;
          this.state.forceRestartHealthPollDurationsMs.clear();
        }
      })
      .catch((error) => {
        // forceRestart awaits the original promise; this observer drains its finalizer copy.
        logger.debug(`[IOSCtrlProxy] Restart cleanup rejection observed: ${errorMessage(error)}`);
      });
    await restart;
  }

  /**
   * Poll the health endpoint for a bounded grace after a forced teardown. Returns
   * true only when the old runner is STILL answering at the end of the grace — a
   * listener that merely lags the process teardown stops answering well inside it,
   * and the restart may proceed. Honours the caller's abort signal while polling.
   *
   * Strict: a responder that omits deviceId must NOT be mistaken for the runner we
   * just tried to stop. The primary liveness gate is strict by default too; this
   * explicit option keeps the ownership requirement visible at the forced-teardown
   * call site. An ambiguous responder must not block a legitimate restart (#6415 follow-up).
   *
   * Public so tests can stub the probe.
   */
  async isRunnerStillHealthyAfterForcedTeardown(signal?: AbortSignal): Promise<boolean> {
    const graceDeadlineMs = this.state.timer.now() + FORCE_RESTART_DRAIN_GRACE_MS;
    for (;;) {
      if (
        !(await this.host.checkHealthEndpointOnPortForDevice(
          this.state.servicePort,
          this.state.device.deviceId,
          undefined,
          { requireDeviceId: true },
        ))
      ) {
        return false;
      }
      const remainingMs = graceDeadlineMs - this.state.timer.now();
      if (remainingMs <= 0) {
        return true;
      }
      await this.host.sleepForHealthPoll(
        Math.min(FORCE_RESTART_DRAIN_POLL_INTERVAL_MS, remainingMs),
        signal,
      );
    }
  }

  async waitForForceRestart(options: CtrlProxyStartOptions): Promise<boolean> {
    const restart = this.state.forceRestartInFlight;
    if (!restart) {
      return true;
    }
    const healthPollCaller = this.registerForceRestartHealthPollDuration(
      options.minimumHealthPollDurationMs,
    );
    const waitForRestart = async (): Promise<boolean> => {
      try {
        await restart;
        return true;
      } catch (error) {
        if (error instanceof ForceRestartCancelledError) {
          // The earlier caller's deadline must not poison a later live caller.
          return false;
        }
        throw error;
      }
    };
    try {
      const { signal } = options;
      if (!signal) {
        return await waitForRestart();
      }
      if (signal.aborted) {
        throw signal.reason ?? new Error("iOS CtrlProxy startup was aborted");
      }
      return await new Promise<boolean>((resolve, reject) => {
        const onAbort = () =>
          reject(signal.reason ?? new Error("iOS CtrlProxy startup was aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        void waitForRestart().then(
          (restarted) => {
            signal.removeEventListener("abort", onAbort);
            resolve(restarted);
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    } finally {
      this.removeForceRestartHealthPollDuration(healthPollCaller);
    }
  }

  private maximumForceRestartHealthPollDurationMs(
    ownerDurationMs: number | undefined,
  ): number | undefined {
    const joiningDurationMs = Math.max(0, ...this.state.forceRestartHealthPollDurationsMs.values());
    const maximumDurationMs = Math.max(ownerDurationMs ?? 0, joiningDurationMs);
    return maximumDurationMs > 0 ? maximumDurationMs : undefined;
  }

  private registerForceRestartHealthPollDuration(
    durationMs: number | undefined,
  ): symbol | undefined {
    if (!durationMs || durationMs <= 0) {
      return undefined;
    }
    const callerId = Symbol("CtrlProxy forced restart caller");
    this.state.forceRestartHealthPollDurationsMs.set(callerId, durationMs);
    if (this.state.sharedStart) {
      this.host.extendHealthPollDeadline(this.state.sharedStart, callerId, durationMs);
    }
    return callerId;
  }

  private removeForceRestartHealthPollDuration(callerId: symbol | undefined): void {
    if (!callerId) {
      return;
    }
    this.state.forceRestartHealthPollDurationsMs.delete(callerId);
    if (this.state.sharedStart) {
      this.host.removeHealthPollDeadline(this.state.sharedStart, callerId);
    }
  }
}
