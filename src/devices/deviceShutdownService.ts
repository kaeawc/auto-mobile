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
 * a late operation retained the reservation. Retained reservations release on
 * success, or on failure only when releaseAfterFailure is requested; otherwise
 * they stay retained with a warning.
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
    let retainReservation = false;
    try {
      reservation = await workflow.prepare();
      const retainReservationUntil = (
        operation: Promise<unknown>,
        releaseAfterFailure = false,
      ): void => {
        retainReservation = true;
        void operation.then(
          () => this.releaseBestEffort(reservation, "late operation success"),
          (error) => {
            if (releaseAfterFailure) {
              return this.releaseBestEffort(reservation, "late operation failure");
            }
            this.log.warn(
              `[DeviceShutdownService] Retaining shutdown reservation after late teardown failed: ${errorMessage(error)}`,
              error,
            );
          },
        );
      };
      return await workflow.execute(reservation, retainReservationUntil);
    } catch (error) {
      return workflow.failure(error);
    } finally {
      if (!retainReservation) {
        await this.releaseBestEffort(reservation, "finally");
      }
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
