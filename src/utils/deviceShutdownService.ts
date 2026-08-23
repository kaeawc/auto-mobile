import { logger } from "./logger";

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
 * A late platform command keeps the captured pool incarnation reserved until
 * it actually settles, so reconnect/recovery cannot reuse ownership while the
 * old command is still capable of mutating the device.
 */
export class DeviceShutdownService {
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
          () => reservation?.release(),
          (error) => {
            if (releaseAfterFailure) {
              void reservation?.release();
              return;
            }
            logger.warn(
              `[DeviceShutdownService] Retaining shutdown reservation after late teardown failed: ${error}`,
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
        await reservation?.release();
      }
    }
  }
}
