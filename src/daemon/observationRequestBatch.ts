import { DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS } from "./deviceDataStreamSocketServer";
import type { RequestedObservation } from "./deviceDataStreamSocketServer";
import type { ObserveResult } from "../models";
import type { Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { createTimestampedId, defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { raceWithDeadline } from "../utils/raceWithDeadline";

/**
 * Each device gets the full outer request budget because batch devices now race
 * concurrently. This is deliberately not the outer budget minus headroom: the
 * outer wrapper remains the true ceiling, while this timeout only fires when
 * that wrapper is absent or has a larger budget, so it never cuts a device
 * shorter than it was before batching.
 */
export const PER_DEVICE_OBSERVATION_TIMEOUT_MS = DEFAULT_OBSERVATION_REQUEST_TIMEOUT_MS;

/** Margin added to the outer batch wrapper so each per-device timer settles first. */
export const OBSERVATION_BATCH_HEADROOM_MS = 3_000;

export interface ObservationRequestDevice {
  id: string;
}

export interface PooledObservationDeps<TDevice extends ObservationRequestDevice> {
  /** Host clock at request start: the floor for iOS, which shares the host clock. */
  hostRequestStartMs: number;
  /** One device-clock read for an Android device; it falls back to host time on failure. */
  readAndroidDeviceClockMs: (device: TDevice, signal: AbortSignal) => Promise<number>;
  observe: (
    device: TDevice,
    options: { minTimestamp: number; signal: AbortSignal },
  ) => Promise<ObserveResult>;
}

/**
 * Build the per-device observe step for {@link runObservationRequestBatch}.
 *
 * `minTimestamp` is compared with the hierarchy's device-authored `updatedAt`, so
 * an Android floor must be in that device's clock domain: a host floor reads a
 * current capture as stale when the device clock is behind and admits an old one
 * when it is ahead (issue #9895, same class as #6430/#9878). Android therefore
 * reads its own clock once, in parallel with its siblings. iOS keeps the host floor.
 */
export function createPooledObservationExecutor<
  TDevice extends ObservationRequestDevice & { platform: string },
>(
  deps: PooledObservationDeps<TDevice>,
): (device: TDevice, signal: AbortSignal) => Promise<ObserveResult> {
  return async (device, signal) => {
    const minTimestamp =
      device.platform === "android"
        ? await deps.readAndroidDeviceClockMs(device, signal)
        : deps.hostRequestStartMs;
    signal.throwIfAborted();
    return deps.observe(device, { minTimestamp, signal });
  };
}

export interface ObservationRequestBatchOptions<TDevice extends ObservationRequestDevice> {
  timer: Timer;
  signal: AbortSignal;
  perDeviceTimeoutMs?: number;
  assertDeviceActionable?: (device: TDevice) => void;
  idGenerator?: IdGenerator;
}

function failedObservation(timer: Timer, idGenerator: IdGenerator, error: string): ObserveResult {
  return {
    observationId: createTimestampedId("failed_observation", timer, idGenerator),
    // No display stamp is available; the placeholder generation remains 0.
    display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
    updatedAt: timer.now(),
    screenSize: { width: 0, height: 0 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    error,
  };
}

function failedRequestObservation(
  timer: Timer,
  idGenerator: IdGenerator,
  deviceId: string,
  error: string,
): RequestedObservation {
  return { deviceId, observation: failedObservation(timer, idGenerator, error) };
}

/** Run all targeted observations independently so one device cannot block its siblings. */
export async function runObservationRequestBatch<TDevice extends ObservationRequestDevice>(
  devices: readonly TDevice[],
  execute: (device: TDevice, signal: AbortSignal) => Promise<ObserveResult>,
  options: ObservationRequestBatchOptions<TDevice>,
): Promise<RequestedObservation[]> {
  const { timer, signal, assertDeviceActionable } = options;
  const idGenerator = options.idGenerator ?? defaultIdGenerator;
  const perDeviceTimeoutMs = options.perDeviceTimeoutMs ?? PER_DEVICE_OBSERVATION_TIMEOUT_MS;

  const settled = await Promise.allSettled(
    devices.map(async (device): Promise<RequestedObservation> => {
      if (signal.aborted) {
        return failedRequestObservation(
          timer,
          idGenerator,
          device.id,
          `Observation request was aborted for device ${device.id}`,
        );
      }

      try {
        assertDeviceActionable?.(device);
      } catch (error) {
        const message = errorMessage(error);
        logger.warn(`[Daemon] Skipped observation for ${device.id}: ${message}`);
        return failedRequestObservation(timer, idGenerator, device.id, message);
      }

      const controller = new AbortController();
      const timeoutError = new Error(
        `Observation request timed out after ${perDeviceTimeoutMs}ms for device ${device.id}`,
      );
      const combinedSignal = AbortSignal.any([signal, controller.signal]);
      try {
        const observation = await raceWithDeadline(execute(device, combinedSignal), {
          timer,
          timeoutMs: perDeviceTimeoutMs,
          label: "Observation request",
          timeoutError: () => timeoutError,
          onTimeout: () => controller.abort(),
        });
        return { deviceId: device.id, observation };
      } catch (error) {
        const message = errorMessage(error);
        logger.warn(`[Daemon] Failed to observe ${device.id}: ${message}`);
        return failedRequestObservation(timer, idGenerator, device.id, message);
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
    return failedRequestObservation(timer, idGenerator, device.id, message);
  });
}
