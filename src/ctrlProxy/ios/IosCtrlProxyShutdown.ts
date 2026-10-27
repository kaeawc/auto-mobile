import { logger } from "../../utils/logger";
import { BootedDevice } from "../../models";
import { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { SHUTDOWN_STOP_TIMEOUT_MS, SHUTDOWN_FORCE_STOP_TIMEOUT_MS } from "./IosCtrlProxyContracts";

export interface IosCtrlProxyShutdownHost {
  readonly timer: Timer;
  readonly device: BootedDevice;
  stop(deadline?: number): Promise<void>;
  forceStopForShutdown(deadline: number): Promise<void>;
}
export class IosCtrlProxyShutdown {
  static async stopWithinShutdownDeadline(
    instance: IosCtrlProxyShutdownHost,
    timer: Timer,
  ): Promise<unknown | null> {
    let forceStop: Promise<void> | undefined;
    const settled = instance.stop(instance.timer.now() + SHUTDOWN_STOP_TIMEOUT_MS).then(
      () => null,
      (error) => error,
    );
    const timedOut = Symbol("CtrlProxy stop timeout");
    let result: unknown | null;
    try {
      result = await raceWithDeadline(settled, {
        timer,
        timeoutMs: SHUTDOWN_STOP_TIMEOUT_MS,
        label: "CtrlProxy stop",
        timeoutError: () => {
          // Reserve a bounded direct termination window after the stop deadline.
          forceStop = IosCtrlProxyShutdown.forceStopWithinShutdownDeadline(instance, timer);
          return timedOut;
        },
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      const pendingForceStop = forceStop;
      if (!pendingForceStop) {
        throw error;
      }
      // After the deadline, the stop and direct termination are independent operations.
      result = await raceWithDeadline(
        [
          settled,
          pendingForceStop.then(() => new Error(`timed out after ${SHUTDOWN_STOP_TIMEOUT_MS}ms`)),
        ],
        { timer, label: "CtrlProxy force stop" },
      );
    }
    if (forceStop) {
      // Keep the registry until direct termination has also settled.
      await forceStop;
    } else if (result !== null) {
      await IosCtrlProxyShutdown.forceStopWithinShutdownDeadline(instance, timer);
    }
    return result;
  }

  static async forceStopWithinShutdownDeadline(
    instance: IosCtrlProxyShutdownHost,
    timer: Timer,
  ): Promise<void> {
    const timedOut = Symbol("force stop timeout");
    try {
      await raceWithDeadline(
        Promise.resolve(
          instance.forceStopForShutdown(instance.timer.now() + SHUTDOWN_FORCE_STOP_TIMEOUT_MS),
        ),
        {
          timer,
          timeoutMs: SHUTDOWN_FORCE_STOP_TIMEOUT_MS,
          label: "CtrlProxy force stop",
          timeoutError: () => timedOut,
        },
      );
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
    }
  }

  static async forceStopWithinEvictionDeadline(
    instance: IosCtrlProxyShutdownHost,
    timer: Timer,
    deadlineMs?: number,
  ): Promise<void> {
    if (deadlineMs === undefined) {
      await IosCtrlProxyShutdown.forceStopWithinShutdownDeadline(instance, timer);
      return;
    }

    const now = timer.now();
    const remainingMs = deadlineMs - now;
    if (remainingMs <= 0) {
      logger.debug(
        `[IOSCtrlProxy] Eviction deadline already expired for ${instance.device.deviceId}; ` +
          "starting force-stop without waiting",
      );
      void Promise.resolve(instance.forceStopForShutdown(deadlineMs)).catch((error) => {
        logger.debug(
          `[IOSCtrlProxy] Force-stop after an expired eviction deadline failed: ${error}`,
        );
      });
      return;
    }

    const waitMs = Math.min(remainingMs, SHUTDOWN_FORCE_STOP_TIMEOUT_MS);
    const timedOut = Symbol("eviction force stop timeout");
    try {
      await raceWithDeadline(
        Promise.resolve(
          instance.forceStopForShutdown(Math.min(deadlineMs, now + SHUTDOWN_FORCE_STOP_TIMEOUT_MS)),
        ),
        {
          timer,
          timeoutMs: waitMs,
          label: "CtrlProxy eviction force stop",
          timeoutError: () => timedOut,
        },
      );
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
    }
  }
}
