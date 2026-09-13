import { DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS } from "./deviceDataStreamSocketServer";
import type { RequestedObservation } from "./deviceDataStreamSocketServer";
import type { ObserveResult } from "../models";
import type { Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";

/**
 * iOS may legitimately need up to 15 seconds for a fresh hierarchy. Leave three
 * seconds below the stream's 20-second outer guard so a single stalled device
 * settles locally while the outer guard can still catch a callback-level hang.
 */
export const PER_DEVICE_OBSERVATION_TIMEOUT_MS = DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS - 3_000;

export interface ObservationRequestDevice {
  id: string;
}

export interface ObservationRequestBatchOptions<TDevice extends ObservationRequestDevice> {
  timer: Timer;
  signal: AbortSignal;
  perDeviceTimeoutMs?: number;
  assertDeviceActionable?: (device: TDevice) => void;
}

function failedObservation(timer: Timer, error: string): ObserveResult {
  return {
    updatedAt: timer.now(),
    screenSize: { width: 0, height: 0 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    error,
  };
}

function failedRequestObservation(
  timer: Timer,
  deviceId: string,
  error: string,
): RequestedObservation {
  return { deviceId, observation: failedObservation(timer, error) };
}

/** Run all targeted observations independently so one device cannot block its siblings. */
export async function runObservationRequestBatch<TDevice extends ObservationRequestDevice>(
  devices: readonly TDevice[],
  execute: (device: TDevice, signal: AbortSignal) => Promise<ObserveResult>,
  options: ObservationRequestBatchOptions<TDevice>,
): Promise<RequestedObservation[]> {
  const { timer, signal, assertDeviceActionable } = options;
  const perDeviceTimeoutMs = options.perDeviceTimeoutMs ?? PER_DEVICE_OBSERVATION_TIMEOUT_MS;

  const settled = await Promise.allSettled(
    devices.map(async (device): Promise<RequestedObservation> => {
      if (signal.aborted) {
        return failedRequestObservation(
          timer,
          device.id,
          `Observation request was aborted for device ${device.id}`,
        );
      }

      try {
        assertDeviceActionable?.(device);
      } catch (error) {
        const message = errorMessage(error);
        logger.warn(`[Daemon] Skipped observation for ${device.id}: ${message}`);
        return failedRequestObservation(timer, device.id, message);
      }

      const controller = new AbortController();
      const timeoutError = new Error(
        `Observation request timed out after ${perDeviceTimeoutMs}ms for device ${device.id}`,
      );
      const combinedSignal = AbortSignal.any([signal, controller.signal]);
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = timer.setTimeout(() => {
          controller.abort();
          reject(timeoutError);
        }, perDeviceTimeoutMs);
      });

      try {
        const observation = await Promise.race([execute(device, combinedSignal), timeoutPromise]);
        return { deviceId: device.id, observation };
      } catch (error) {
        const message = errorMessage(error);
        logger.warn(`[Daemon] Failed to observe ${device.id}: ${message}`);
        return failedRequestObservation(timer, device.id, message);
      } finally {
        if (timeoutHandle) {
          timer.clearTimeout(timeoutHandle);
        }
      }
    }),
  );

  return settled.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    const device = devices[index]!;
    const message = errorMessage(result.reason);
    logger.warn(`[Daemon] Observation task for ${device.id} rejected unexpectedly: ${message}`);
    return failedRequestObservation(timer, device.id, message);
  });
}
