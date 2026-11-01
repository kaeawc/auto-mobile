import { getDeviceDataStreamServer } from "../../daemon/deviceDataStreamSocketServer";
import type { ViewHierarchyResult } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  DefaultScreenshotBackoffScheduler,
  type ScreenshotBackoffConfigInput,
  type ScreenshotBackoffScheduler,
  type ScreenshotCaptureResult,
} from "./ScreenshotBackoffScheduler";

export function forwardHierarchyToObservationStream(
  deviceId: string,
  hierarchy: ViewHierarchyResult,
  frameContext: string | undefined,
  hooks: {
    logTag: string;
    prepare?: () => void;
    recordForwarded: (captureSequence: number) => void;
  },
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
    logger.warn(
      `[${hooks.logTag}] Failed to push hierarchy to observation stream: ${errorMessage(error)}`,
      error,
    );
  }
}

export function buildScreenshotBackoffScheduler(
  deviceId: string,
  timer: Timer,
  capture: () => Promise<ScreenshotCaptureResult>,
  {
    emit,
    options,
  }: {
    emit: (result: ScreenshotCaptureResult) => void;
    options: ScreenshotBackoffConfigInput;
  },
): ScreenshotBackoffScheduler {
  return new DefaultScreenshotBackoffScheduler(capture, emit, {
    config: {
      ...options,
      getKeepAliveIntervalMs: () => {
        const server = getDeviceDataStreamServer();
        return server?.getScreenshotIntervalMsForDevice(deviceId) ?? 3000;
      },
    },
    timer,
    shouldKeepAlive: () => {
      const server = getDeviceDataStreamServer();
      return !!server && server.hasSubscriberForDevice(deviceId);
    },
  });
}
