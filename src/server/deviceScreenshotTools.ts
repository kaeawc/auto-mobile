import { z } from "zod/v4";
import * as fs from "node:fs/promises";
import { ActionableError } from "../models/ActionableError";
import type { BootedDevice } from "../models";
import { TakeScreenshot } from "../features/observe/TakeScreenshot";
import type { TrackedScreenshotService } from "../features/observe/screenshot/ObserveScreenshotRecorder";
import { getScreenshotStateStore } from "../features/observe/screenshot/ScreenshotStateRegistry";
import {
  detectImageMimeType,
  readImageHeaderDimensions,
} from "../utils/screenshot/imageHeaderDimensions";
import { errorMessage } from "../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { logger } from "../utils/logger";
import { OPERATION_CANCELLED_MESSAGE } from "../utils/constants";
import { DaemonState } from "../daemon/daemonState";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { listBootedDevicesForResource } from "./resourceDeviceResolver";
import { ToolRegistry } from "./toolRegistry";

const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

export const captureDeviceScreenshotSchema = z.strictObject({
  deviceId: z.string().trim().min(1),
  format: z.enum(["png", "jpeg", "webp"]).default("png"),
  timeoutMs: z.number().int().min(1).max(60_000).default(30_000),
});

export type CaptureDeviceScreenshotArgs = z.infer<typeof captureDeviceScreenshotSchema>;

interface ScreenshotFileReader {
  stat(path: string): Promise<{ isFile(): boolean; size: number; mtimeMs: number }>;
  readFile(path: string): Promise<Buffer>;
}

export interface DeviceScreenshotDependencies {
  listBooted(signal: AbortSignal): Promise<BootedDevice[]>;
  /** Called before capture and again before any image is returned. */
  isAuthorized(device: BootedDevice, callerSessionUuid: string | undefined): boolean;
  createScreenshotService(device: BootedDevice): TrackedScreenshotService;
  cachedScreenshotPath(deviceId: string): string | undefined;
  files: ScreenshotFileReader;
  timer: Timer;
}

function defaultScreenshotDependencies(): DeviceScreenshotDependencies {
  return {
    listBooted: async (signal) => {
      return listBootedDevicesForResource("either", "captureDeviceScreenshot", {
        signal,
        requireFresh: true,
      });
    },
    isAuthorized: (device, callerSessionUuid) => {
      const daemon = DaemonState.getInstance();
      if (!daemon.isInitialized()) {
        return true;
      }
      const owner = daemon.getDevicePool().getDevice(device.deviceId)?.sessionId;
      const callerBaseSessionUuid = resolveToolSelectionBaseSessionUuid(
        callerSessionUuid,
        daemon.getSessionManager(),
      );
      return hasScreenshotAccess(
        owner ?? undefined,
        callerBaseSessionUuid,
        getToolSelectionContext()?.ownsDeviceSession,
      );
    },
    createScreenshotService: (device) => new TakeScreenshot(device),
    cachedScreenshotPath: (deviceId) => getScreenshotStateStore().getPath(deviceId),
    files: fs,
    timer: defaultTimer,
  };
}

/** An owned device requires a binding to the caller's MCP connection. */
export function hasScreenshotAccess(
  ownerSessionUuid: string | undefined,
  callerSessionUuid: string | undefined,
  ownsSession: ((sessionUuid: string) => boolean) | undefined,
): boolean {
  return Boolean(
    !ownerSessionUuid ||
    (ownerSessionUuid === callerSessionUuid && ownsSession?.(ownerSessionUuid)),
  );
}

type ScreenshotFailure = { code: string; message: string; retryable: boolean };
type ScreenshotMetadata = {
  deviceId: string;
  deviceName: string;
  platform: BootedDevice["platform"];
  source: "fresh" | "cached";
  captureSource: "device" | "observation-cache";
  mimeType: string;
  capturedAt: string;
  ageMs: number;
  width?: number;
  height?: number;
  freshFailure?: ScreenshotFailure;
};

function failure(code: string, message: string, retryable: boolean): ScreenshotFailure {
  return { code, message, retryable };
}

function failureResponse(detail: ScreenshotFailure) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: detail }) }],
    structuredContent: { error: detail },
    isError: true,
  };
}

async function readScreenshot(
  path: string,
  device: BootedDevice,
  source: "fresh" | "cached",
  deps: DeviceScreenshotDependencies,
  freshFailure?: ScreenshotFailure,
) {
  const stat = await deps.files.stat(path);
  if (!stat.isFile() || stat.size > MAX_SCREENSHOT_BYTES) {
    throw new ActionableError("Screenshot file is missing or exceeds the 16 MiB response limit.");
  }
  const bytes = await deps.files.readFile(path);
  if (bytes.length > MAX_SCREENSHOT_BYTES) {
    throw new ActionableError("Screenshot exceeds the 16 MiB response limit.");
  }
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) {
    throw new ActionableError("Screenshot has an unrecognized image format.");
  }
  const dimensions = readImageHeaderDimensions(bytes);
  const capturedAt = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : deps.timer.now();
  const metadata: ScreenshotMetadata = {
    deviceId: device.deviceId,
    deviceName: device.name,
    platform: device.platform,
    source,
    captureSource: source === "fresh" ? "device" : "observation-cache",
    mimeType,
    capturedAt: new Date(capturedAt).toISOString(),
    ageMs: Math.max(0, deps.timer.now() - capturedAt),
    ...(dimensions ? dimensions : {}),
    ...(freshFailure ? { freshFailure } : {}),
  };
  return { bytes, metadata };
}

function imageResponse(screenshot: { bytes: Buffer; metadata: ScreenshotMetadata }) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(screenshot.metadata) },
      {
        type: "image" as const,
        data: screenshot.bytes.toString("base64"),
        mimeType: screenshot.metadata.mimeType,
      },
    ],
    structuredContent: screenshot.metadata,
  };
}

function accessFailure(
  device: BootedDevice,
  callerSessionUuid: string | undefined,
  signal: AbortSignal | undefined,
  deps: DeviceScreenshotDependencies,
) {
  if (signal?.aborted) {
    return failureResponse(
      failure("SCREENSHOT_CAPTURE_CANCELLED", OPERATION_CANCELLED_MESSAGE, false),
    );
  }
  if (!deps.isAuthorized(device, callerSessionUuid)) {
    return failureResponse(failure("SCREENSHOT_ACCESS_DENIED", "Screenshot access denied.", false));
  }
  return undefined;
}

async function captureFresh(
  device: BootedDevice,
  args: CaptureDeviceScreenshotArgs,
  deadlineMs: number,
  controller: AbortController,
  deps: DeviceScreenshotDependencies,
): Promise<{ path?: string; freshFailure?: ScreenshotFailure }> {
  const remainingMs = deadlineMs - deps.timer.now();
  if (remainingMs <= 0) {
    return {
      freshFailure: failure("SCREENSHOT_CAPTURE_TIMEOUT", "Screenshot timeout exhausted.", true),
    };
  }
  try {
    const service = deps.createScreenshotService(device);
    const { promise } = service.startTrackedCapture(
      { format: args.format },
      { parentSignal: controller.signal, queueAfterPending: true },
    );
    const result = await raceWithDeadline(promise, {
      timer: deps.timer,
      timeoutMs: remainingMs,
      signal: controller.signal,
      label: "Device screenshot capture",
      onTimeout: () => controller.abort(),
    });
    return result.success && result.path
      ? { path: result.path }
      : {
          freshFailure: failure(
            "SCREENSHOT_CAPTURE_FAILED",
            result.error ?? "Capture failed.",
            true,
          ),
        };
  } catch (error) {
    logger.warn(
      `Fresh screenshot capture failed for ${device.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return { freshFailure: failure("SCREENSHOT_CAPTURE_FAILED", errorMessage(error), true) };
  }
}

async function readFreshOrFallback(
  device: BootedDevice,
  capture: { path?: string; freshFailure?: ScreenshotFailure },
  callerSessionUuid: string | undefined,
  signal: AbortSignal | undefined,
  deps: DeviceScreenshotDependencies,
) {
  let freshFailure = capture.freshFailure;
  if (capture.path) {
    try {
      const screenshot = await readScreenshot(capture.path, device, "fresh", deps);
      return accessFailure(device, callerSessionUuid, signal, deps) ?? imageResponse(screenshot);
    } catch (error) {
      logger.warn(
        `Fresh screenshot read failed for ${device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      freshFailure = failure("SCREENSHOT_READ_FAILED", errorMessage(error), true);
    }
  }
  const cachedPath = deps.cachedScreenshotPath(device.deviceId);
  if (!cachedPath) {
    return failureResponse(
      freshFailure ?? failure("SCREENSHOT_UNAVAILABLE", "No screenshot available.", true),
    );
  }
  try {
    const screenshot = await readScreenshot(cachedPath, device, "cached", deps, freshFailure);
    return accessFailure(device, callerSessionUuid, signal, deps) ?? imageResponse(screenshot);
  } catch (error) {
    logger.warn(
      `Cached screenshot read failed for ${device.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return failureResponse(failure("SCREENSHOT_UNAVAILABLE", errorMessage(error), true));
  }
}

async function resolveBootedDevice(
  args: CaptureDeviceScreenshotArgs,
  controller: AbortController,
  deps: DeviceScreenshotDependencies,
): Promise<BootedDevice | ScreenshotFailure> {
  const devices = await raceWithDeadline(() => deps.listBooted(controller.signal), {
    timer: deps.timer,
    timeoutMs: args.timeoutMs,
    signal: controller.signal,
    label: "Device screenshot discovery",
    onTimeout: () => controller.abort(),
  });
  const matches = devices.filter(
    (device) => device.deviceId === args.deviceId || device.name === args.deviceId,
  );
  if (matches.length === 1) {
    return matches[0];
  }
  return failure(
    matches.length === 0 ? "DEVICE_NOT_BOOTED" : "DEVICE_AMBIGUOUS",
    `Expected one booted device for '${args.deviceId}'; found ${matches.length}.`,
    matches.length === 0,
  );
}

/** Capture by device identity without allocating or touching an automation session. */
export async function captureDeviceScreenshot(
  args: CaptureDeviceScreenshotArgs,
  callerSessionUuid: string | undefined,
  signal: AbortSignal | undefined,
  deps: DeviceScreenshotDependencies = defaultScreenshotDependencies(),
) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const deadlineMs = deps.timer.now() + args.timeoutMs;
  try {
    signal?.throwIfAborted();
    const resolved = await resolveBootedDevice(args, controller, deps);
    if ("code" in resolved) {
      return failureResponse(resolved);
    }
    const device = resolved;
    const denied = accessFailure(device, callerSessionUuid, signal, deps);
    if (denied) {
      return denied;
    }
    const capture = await captureFresh(device, args, deadlineMs, controller, deps);
    const deniedAfterCapture = accessFailure(device, callerSessionUuid, signal, deps);
    return (
      deniedAfterCapture ?? readFreshOrFallback(device, capture, callerSessionUuid, signal, deps)
    );
  } catch (error) {
    logger.warn(`Device screenshot failed: ${errorMessage(error)}`, error);
    return failureResponse(
      failure(
        signal?.aborted ? "SCREENSHOT_CAPTURE_CANCELLED" : "SCREENSHOT_CAPTURE_FAILED",
        errorMessage(error),
        !signal?.aborted,
      ),
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export function registerDeviceScreenshotTool(): void {
  ToolRegistry.register(
    "captureDeviceScreenshot",
    "Capture a fresh raw screenshot of one booted device, with a clearly labeled cached observation screenshot if capture fails. Does not acquire a device session.",
    captureDeviceScreenshotSchema,
    (args: CaptureDeviceScreenshotArgs, _progress, signal) =>
      captureDeviceScreenshot(args, getToolSelectionContext()?.routingSessionUuid, signal),
    { defaultEnabled: true },
  );
}
