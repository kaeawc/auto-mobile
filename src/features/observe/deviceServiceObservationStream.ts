/**
 * Observation-stream wiring for device service clients: forwarding hierarchies
 * to the device data stream server and building the shared screenshot scheduler.
 */

import type { ViewHierarchyResult } from "../../models";
import { getDeviceDataStreamServer } from "../../daemon/deviceDataStreamSocketServer";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import {
  DefaultScreenshotBackoffScheduler,
  type ScreenshotBackoffScheduler,
  type ScreenshotCaptureResult,
} from "./ScreenshotBackoffScheduler";

export interface HierarchyForwardingHooks {
  logTag: string;
  prepare?: () => void;
  recordForwarded: (captureSequence: number) => void;
}

export function forwardHierarchyToObservationStream(
  deviceId: string,
  hierarchy: ViewHierarchyResult,
  frameContext: string | undefined,
  hooks: HierarchyForwardingHooks,
): void {
  const server = getDeviceDataStreamServer();
  if (!server) {
    return;
  }
  try {
    hooks.prepare?.();
    const captureSequence = server.pushHierarchyUpdate(deviceId, hierarchy, frameContext);
    // A missing identity leaves geometry untracked so control clients fail closed.
    if (captureSequence !== null) {
      hierarchy.captureSequence = captureSequence;
      hooks.recordForwarded(captureSequence);
    }
  } catch (error) {
    logger.warn(`[${hooks.logTag}] Failed to push hierarchy to observation stream: ${error}`);
  }
}

export function buildScreenshotBackoffScheduler(
  deviceId: string,
  timer: Timer,
  capture: () => Promise<ScreenshotCaptureResult>,
  emit: (result: ScreenshotCaptureResult) => void,
  options: ConstructorParameters<typeof DefaultScreenshotBackoffScheduler>[2],
): ScreenshotBackoffScheduler {
  return new DefaultScreenshotBackoffScheduler(
    capture,
    emit,
    {
      ...options,
      getKeepAliveIntervalMs: () => {
        const server = getDeviceDataStreamServer();
        return server?.getScreenshotIntervalMsForDevice(deviceId) ?? 3000;
      },
    },
    timer,
    () => {
      const server = getDeviceDataStreamServer();
      return !!server && server.hasSubscriberForDevice(deviceId);
    },
  );
}
