import { errorMessage } from "../utils/describeUnknownError";
import { logger, type Logger } from "../utils/logger";

export interface DeviceShutdownReservation<TDevice> {
  device: TDevice;
  release(): Promise<void>;
}

export interface DeviceShutdownWorkflow<TDevice, TResult> {
  prepare(): Promise<DeviceShutdownReservation<TDevice> | undefined>;
  execute(
    reservation: DeviceShutdownReservation<TDevice> | undefined,
    retainReservationUntil: (operation: Promise<unknown>, releaseAfterFailure?: boolean) => void,
  ): Promise<TResult>;
  failure(error: unknown): TResult;
}

/**
 * Shared shutdown transaction boundary.
 *
 * The returned value or throw reflects prepare/execute/failure, including aborts;
 * best-effort reservation release failures are logged and never replace it.
 * Prepare runs first; if it throws, failure handles it without a reservation.
 * Otherwise finally attempts release, even when failure itself throws, unless
 * a late operation retained the reservation. A retained operation is either an
 * ownership hold (the default), whose settlement decides the release, or a
 * barrier (releaseAfterFailure), which only has to settle. The reservation is
 * released once, after execute has returned and every barrier has settled, and
 * only when no ownership hold was retained or the latest one to settle
 * succeeded. An ownership hold that fails keeps the reservation retained with a
 * warning, until a later ownership hold (a retirement retry) succeeds. So a
 * barrier settling never lifts an ownership hold's fence, and an ownership hold
 * never releases under a barrier that is still running.
 *
 * A late platform command keeps the captured pool incarnation reserved until
 * it actually settles, so reconnect/recovery cannot reuse ownership while the
 * old command is still capable of mutating the device.
 */
export class DeviceShutdownService {
  constructor(private readonly log: Logger = logger) {}

  async shutdown<TDevice, TResult>(
    workflow: DeviceShutdownWorkflow<TDevice, TResult>,
  ): Promise<TResult> {
    let reservation: DeviceShutdownReservation<TDevice> | undefined;
    // Execute itself is a barrier until it returns.
    const holds: {
      barriers: number;
      ownership: "none" | "pending" | "release" | "keep";
      released: boolean;
    } = { barriers: 1, ownership: "none", released: false };
    const releaseIfSettled = async (context: string): Promise<void> => {
      if (holds.released || holds.barriers > 0) {
        return;
      }
      if (holds.ownership === "none" || holds.ownership === "release") {
        holds.released = true;
        await this.releaseBestEffort(reservation, context);
      }
    };
    try {
      reservation = await workflow.prepare();
      const retainReservationUntil = (
        operation: Promise<unknown>,
        releaseAfterFailure = false,
      ): void => {
        if (releaseAfterFailure) {
          holds.barriers++;
        } else if (holds.ownership === "none") {
          holds.ownership = "pending";
        }
        const settle = async (succeeded: boolean, context: string): Promise<void> => {
          if (releaseAfterFailure) {
            holds.barriers--;
          } else {
            holds.ownership = succeeded ? "release" : "keep";
          }
          await releaseIfSettled(context);
        };
        void operation.then(
          () => settle(true, "late operation success"),
          (error) => {
            if (!releaseAfterFailure) {
              this.log.warn(
                `[DeviceShutdownService] Retaining shutdown reservation after late teardown failed: ${errorMessage(error)}`,
                error,
              );
            }
            return settle(false, "late operation failure");
          },
        );
      };
      return await workflow.execute(reservation, retainReservationUntil);
    } catch (error) {
      return workflow.failure(error);
    } finally {
      holds.barriers--;
      await releaseIfSettled("finally");
    }
  }

  private async releaseBestEffort<TDevice>(
    reservation: DeviceShutdownReservation<TDevice> | undefined,
    context: string,
  ): Promise<void> {
    try {
      await reservation?.release();
    } catch (error) {
      // TResult has no cleanup-warning field; preserve the shutdown outcome and log only.
      this.log.warn(
        `[DeviceShutdownService] Failed to release shutdown reservation (${context}): ${errorMessage(error)}`,
        error,
      );
    }
  }
}
