import { ResourceRegistry, ResourceContent, type ResourceReadContext } from "./resourceRegistry";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { logger } from "../utils/logger";
import { stringifyToolResponse } from "../utils/toolUtils";
import { ScreenshotJobTracker } from "../utils/ScreenshotJobTracker";
import { DaemonState } from "../daemon/daemonState";
import { TakeScreenshot } from "../features/observe/TakeScreenshot";
import { resolveDirectSessionDevice } from "./directSessionDeviceRegistry";
import type { TrackedScreenshotService } from "../features/observe/screenshot/ObserveScreenshotRecorder";
import type { BootedDevice } from "../models";
import * as realFs from "fs/promises";
import { errorMessage } from "../utils/describeUnknownError";
import { OPERATION_CANCELLED_MESSAGE } from "../utils/constants";

interface ScreenshotFileSystem {
  stat(path: string): Promise<{ isFile(): boolean }>;
  readFile(path: string): Promise<Buffer>;
}

let screenshotFileSystem: ScreenshotFileSystem = realFs;

export function setScreenshotFileSystem(fs: ScreenshotFileSystem): void {
  screenshotFileSystem = fs;
}

export function resetScreenshotFileSystem(): void {
  screenshotFileSystem = realFs;
}

interface ActiveSessionDevice {
  sessionUuid: string;
  device: BootedDevice;
  incarnation?: number;
}

interface SessionScreenshotResourceDependencies {
  resolveActiveSession(sessionUuid: string): ActiveSessionDevice | undefined;
  createScreenshotService(device: BootedDevice): TrackedScreenshotService;
}

let nextSessionIncarnation = 0;
const sessionIncarnations = new WeakMap<object, number>();

function getSessionIncarnation(session: object): number {
  const existing = sessionIncarnations.get(session);
  if (existing !== undefined) {
    return existing;
  }
  const incarnation = ++nextSessionIncarnation;
  sessionIncarnations.set(session, incarnation);
  return incarnation;
}

function resolveActiveSession(sessionUuid: string): ActiveSessionDevice | undefined {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return resolveDirectSessionDevice(sessionUuid);
  }

  const session = daemonState.getSessionManager().getSession(sessionUuid);
  if (!session) {
    return undefined;
  }

  const pooledDevice = daemonState.getDevicePool().getDevice(session.assignedDevice);
  if (!pooledDevice || pooledDevice.sessionId !== sessionUuid) {
    return undefined;
  }

  return {
    sessionUuid,
    incarnation: getSessionIncarnation(session),
    device: {
      deviceId: pooledDevice.id,
      name: pooledDevice.name,
      platform: pooledDevice.platform,
      iosVersion: pooledDevice.iosVersion,
    },
  };
}

const defaultSessionScreenshotResourceDependencies: SessionScreenshotResourceDependencies = {
  resolveActiveSession,
  createScreenshotService: (device) => new TakeScreenshot(device),
};

let sessionScreenshotResourceDependencies = defaultSessionScreenshotResourceDependencies;

export function setSessionScreenshotResourceDependencies(
  dependencies: SessionScreenshotResourceDependencies,
): void {
  sessionScreenshotResourceDependencies = dependencies;
}

export function resetSessionScreenshotResourceDependencies(): void {
  sessionScreenshotResourceDependencies = defaultSessionScreenshotResourceDependencies;
}

// Resource URIs
export const RESOURCE_URIS = {
  LATEST_OBSERVATION: "automobile:observation/latest",
  LATEST_SCREENSHOT: "automobile:observation/latest/screenshot",
  SESSION_OBSERVATION: "automobile:observation/session/{sessionUuid}/latest",
  SESSION_SCREENSHOT: "automobile:observation/session/{sessionUuid}/latest/screenshot",
  FRESH_SESSION_SCREENSHOT: "automobile:device-session/{sessionUuid}/screenshot",
} as const;

// Helper to get the latest screenshot path from cache
async function getLatestScreenshotPath(): Promise<string | undefined> {
  try {
    const screenshotPath = RealObserveScreen.getRecentCachedScreenshotPath();
    if (!screenshotPath) {
      return undefined;
    }

    const fileStat = await screenshotFileSystem.stat(screenshotPath);
    if (!fileStat.isFile()) {
      return undefined;
    }

    return screenshotPath;
  } catch (error) {
    logger.warn(`[ObservationResources] Failed to get latest screenshot: ${error}`);
    return undefined;
  }
}

// Handler for latest observation resource (text/json)
async function getLatestObservation(): Promise<ResourceContent> {
  try {
    const cachedResult = RealObserveScreen.getRecentCachedResult();

    if (!cachedResult) {
      return {
        uri: RESOURCE_URIS.LATEST_OBSERVATION,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            error:
              "No observation available. Call the 'observe' tool first to capture screen state.",
          },
          null,
          2,
        ),
      };
    }

    // Return the observation as JSON
    return {
      uri: RESOURCE_URIS.LATEST_OBSERVATION,
      mimeType: "application/json",
      text: stringifyToolResponse(cachedResult),
    };
  } catch (error) {
    logger.error(`[ObservationResources] Failed to get latest observation: ${error}`);
    return {
      uri: RESOURCE_URIS.LATEST_OBSERVATION,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Failed to retrieve observation: ${error}`,
        },
        null,
        2,
      ),
    };
  }
}

// Handler for latest screenshot resource (image/png as blob)
async function getLatestScreenshot(): Promise<ResourceContent> {
  try {
    const cachedResult = RealObserveScreen.getRecentCachedResult();
    if (!cachedResult) {
      return {
        uri: RESOURCE_URIS.LATEST_SCREENSHOT,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            error:
              "No observation available. Call the 'observe' tool first to capture a screenshot.",
          },
          null,
          2,
        ),
      };
    }

    let screenshotPath = await getLatestScreenshotPath();

    if (!screenshotPath) {
      const pendingDeviceId = ScreenshotJobTracker.getMostRecentPendingDeviceId();
      if (pendingDeviceId) {
        await ScreenshotJobTracker.waitForCompletion(pendingDeviceId, 3000);
        screenshotPath = await getLatestScreenshotPath();
      }
    }

    if (!screenshotPath) {
      const screenshotError = RealObserveScreen.getRecentCachedScreenshotError();
      const errorMessage = screenshotError
        ? `No screenshot available from the latest observation: ${screenshotError}`
        : "No screenshot available. Call the 'observe' tool again to capture a screenshot.";
      return {
        uri: RESOURCE_URIS.LATEST_SCREENSHOT,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            error: errorMessage,
          },
          null,
          2,
        ),
      };
    }

    // Read the screenshot file and convert to base64
    const imageBuffer = await screenshotFileSystem.readFile(screenshotPath);
    const base64Image = imageBuffer.toString("base64");

    // Determine mime type from file extension
    const mimeType = screenshotPath.endsWith(".webp") ? "image/webp" : "image/png";

    return {
      uri: RESOURCE_URIS.LATEST_SCREENSHOT,
      mimeType,
      blob: base64Image,
    };
  } catch (error) {
    logger.error(`[ObservationResources] Failed to get latest screenshot: ${error}`);
    return {
      uri: RESOURCE_URIS.LATEST_SCREENSHOT,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Failed to retrieve screenshot: ${error}`,
        },
        null,
        2,
      ),
    };
  }
}

function sessionResourceError(uri: string, sessionUuid: string): ResourceContent {
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify(
      {
        error: `No active device session found for sessionUuid ${sessionUuid}.`,
      },
      null,
      2,
    ),
  };
}

type FreshSessionScreenshotFailureCode =
  | "SESSION_NOT_ACTIVE"
  | "SESSION_OWNERSHIP_LOST"
  | "SCREENSHOT_CAPTURE_FAILED"
  | "SCREENSHOT_CAPTURE_CANCELLED"
  | "SCREENSHOT_READ_FAILED"
  | "SCREENSHOT_ACCESS_DENIED";

function freshSessionScreenshotError(
  uri: string,
  code: FreshSessionScreenshotFailureCode,
  retryable: boolean,
  error: string,
): ResourceContent {
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify({ code, retryable, error }, null, 2),
  };
}

function freshScreenshotCaptureFailure(
  uri: string,
  signal: AbortSignal | undefined,
  error: string,
): ResourceContent {
  if (signal?.aborted || error.includes(OPERATION_CANCELLED_MESSAGE)) {
    return freshSessionScreenshotError(uri, "SCREENSHOT_CAPTURE_CANCELLED", false, error);
  }
  if (/EACCES|EPERM|permission denied|read-only/i.test(error)) {
    return freshSessionScreenshotError(uri, "SCREENSHOT_ACCESS_DENIED", false, error);
  }
  return freshSessionScreenshotError(uri, "SCREENSHOT_CAPTURE_FAILED", true, error);
}

function unauthorizedSessionResourceError(uri: string): ResourceContent {
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify(
      {
        error: "This resource can only be read by its bound device session.",
      },
      null,
      2,
    ),
  };
}

function unauthorizedFreshScreenshotError(uri: string): ResourceContent {
  return freshSessionScreenshotError(
    uri,
    "SCREENSHOT_ACCESS_DENIED",
    false,
    "This resource can only be read by its bound device session.",
  );
}

function sessionOwnershipChanged(
  currentSession: ActiveSessionDevice | undefined,
  originalSession: ActiveSessionDevice,
): boolean {
  if (currentSession?.device.deviceId !== originalSession.device.deviceId) {
    return true;
  }
  if (currentSession?.incarnation !== undefined && originalSession.incarnation !== undefined) {
    return currentSession.incarnation !== originalSession.incarnation;
  }
  return false;
}

function isAuthorizedSessionResource(context: ResourceReadContext, sessionUuid: string): boolean {
  return context.sessionUuid === sessionUuid;
}

function releasedSessionNotActiveError(
  uri: string,
  context: ResourceReadContext,
  sessionUuid: string,
): ResourceContent | undefined {
  if (
    context.releasedSessionUuid === sessionUuid &&
    !sessionScreenshotResourceDependencies.resolveActiveSession(sessionUuid)
  ) {
    return freshSessionScreenshotError(
      uri,
      "SESSION_NOT_ACTIVE",
      false,
      `No active device session found for sessionUuid ${sessionUuid}.`,
    );
  }
  return undefined;
}

async function readFreshScreenshot(
  uri: string,
  sessionUuid: string,
  activeSession: ActiveSessionDevice,
  context: ResourceReadContext,
  path: string,
): Promise<ResourceContent> {
  try {
    const imageBuffer = await screenshotFileSystem.readFile(path);
    if (context.signal?.aborted) {
      return freshSessionScreenshotError(
        uri,
        "SCREENSHOT_CAPTURE_CANCELLED",
        false,
        OPERATION_CANCELLED_MESSAGE,
      );
    }
    const finalSession = sessionScreenshotResourceDependencies.resolveActiveSession(sessionUuid);
    if (sessionOwnershipChanged(finalSession, activeSession)) {
      return freshSessionScreenshotError(
        uri,
        "SESSION_OWNERSHIP_LOST",
        false,
        "Device session ownership was lost while reading a fresh screenshot.",
      );
    }
    return {
      uri,
      mimeType: "image/png",
      blob: imageBuffer.toString("base64"),
    };
  } catch (error) {
    const reason = errorMessage(error);
    logger.error(
      `[ObservationResources] Failed to read fresh screenshot for session ${sessionUuid}: ${reason}`,
    );
    if (context.signal?.aborted || reason.includes(OPERATION_CANCELLED_MESSAGE)) {
      return freshSessionScreenshotError(uri, "SCREENSHOT_CAPTURE_CANCELLED", false, reason);
    }
    const failedReadSession =
      sessionScreenshotResourceDependencies.resolveActiveSession(sessionUuid);
    if (sessionOwnershipChanged(failedReadSession, activeSession)) {
      return freshSessionScreenshotError(
        uri,
        "SESSION_OWNERSHIP_LOST",
        false,
        "Device session ownership was lost while reading a fresh screenshot.",
      );
    }
    return freshSessionScreenshotError(
      uri,
      "SCREENSHOT_READ_FAILED",
      false,
      `Failed to read fresh screenshot for sessionUuid ${sessionUuid}: ${reason}`,
    );
  }
}

// Session-scoped handler for a cached observation.
async function getSessionObservation(
  params: Record<string, string>,
  context: ResourceReadContext,
): Promise<ResourceContent> {
  const { sessionUuid } = params;
  const uri = `automobile:observation/session/${sessionUuid}/latest`;
  if (!isAuthorizedSessionResource(context, sessionUuid)) {
    return unauthorizedSessionResourceError(uri);
  }
  const activeSession = sessionScreenshotResourceDependencies.resolveActiveSession(sessionUuid);
  if (!activeSession) {
    return sessionResourceError(uri, sessionUuid);
  }

  const { deviceId } = activeSession.device;
  try {
    const cachedResult = RealObserveScreen.getRecentCachedResultForDevice(deviceId);

    if (!cachedResult) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            error: `No observation available for sessionUuid ${sessionUuid}. Call the 'observe' tool first.`,
          },
          null,
          2,
        ),
      };
    }

    return {
      uri,
      mimeType: "application/json",
      text: stringifyToolResponse(cachedResult),
    };
  } catch (error) {
    logger.error(
      `[ObservationResources] Failed to get observation for session ${sessionUuid}: ${error}`,
    );
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Failed to retrieve observation for sessionUuid ${sessionUuid}: ${error}`,
        },
        null,
        2,
      ),
    };
  }
}

// Session-scoped handler for a cached screenshot.
async function getSessionScreenshot(
  params: Record<string, string>,
  context: ResourceReadContext,
): Promise<ResourceContent> {
  const { sessionUuid } = params;
  const uri = `automobile:observation/session/${sessionUuid}/latest/screenshot`;
  if (!isAuthorizedSessionResource(context, sessionUuid)) {
    return unauthorizedSessionResourceError(uri);
  }
  const activeSession = sessionScreenshotResourceDependencies.resolveActiveSession(sessionUuid);
  if (!activeSession) {
    return sessionResourceError(uri, sessionUuid);
  }

  const { deviceId } = activeSession.device;
  try {
    const cachedResult = RealObserveScreen.getRecentCachedResultForDevice(deviceId);
    if (!cachedResult) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            error: `No observation available for sessionUuid ${sessionUuid}. Call the 'observe' tool first.`,
          },
          null,
          2,
        ),
      };
    }

    const screenshotPath = RealObserveScreen.getRecentCachedScreenshotPathForDevice(deviceId);
    if (!screenshotPath) {
      const screenshotError = RealObserveScreen.getRecentCachedScreenshotErrorForDevice(deviceId);
      const errorMessage = screenshotError
        ? `No screenshot available for sessionUuid ${sessionUuid}: ${screenshotError}`
        : `No screenshot available for sessionUuid ${sessionUuid}. Call the 'observe' tool again.`;
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ error: errorMessage }, null, 2),
      };
    }

    const imageBuffer = await screenshotFileSystem.readFile(screenshotPath);
    const base64Image = imageBuffer.toString("base64");
    const mimeType = screenshotPath.endsWith(".webp") ? "image/webp" : "image/png";

    return { uri, mimeType, blob: base64Image };
  } catch (error) {
    logger.error(
      `[ObservationResources] Failed to get screenshot for session ${sessionUuid}: ${error}`,
    );
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          error: `Failed to retrieve screenshot for sessionUuid ${sessionUuid}: ${error}`,
        },
        null,
        2,
      ),
    };
  }
}

// Session-scoped handler for a fresh screenshot. Every successful read captures
// the screen; it deliberately does not fall back to an observe cache.
async function getFreshSessionScreenshot(
  params: Record<string, string>,
  context: ResourceReadContext,
): Promise<ResourceContent> {
  const { sessionUuid } = params;
  const uri = `automobile:device-session/${sessionUuid}/screenshot`;
  if (!isAuthorizedSessionResource(context, sessionUuid)) {
    return (
      releasedSessionNotActiveError(uri, context, sessionUuid) ??
      unauthorizedFreshScreenshotError(uri)
    );
  }
  const activeSession = sessionScreenshotResourceDependencies.resolveActiveSession(sessionUuid);
  if (!activeSession) {
    return freshSessionScreenshotError(
      uri,
      "SESSION_NOT_ACTIVE",
      false,
      `No active device session found for sessionUuid ${sessionUuid}.`,
    );
  }

  try {
    const screenshotService = sessionScreenshotResourceDependencies.createScreenshotService(
      activeSession.device,
    );
    const { promise } = screenshotService.startTrackedCapture(
      { format: "png" },
      {
        parentSignal: context.signal,
        queueAfterPending: true,
      },
    );
    const result = await promise;

    const currentSession = sessionScreenshotResourceDependencies.resolveActiveSession(sessionUuid);
    if (sessionOwnershipChanged(currentSession, activeSession)) {
      return freshSessionScreenshotError(
        uri,
        "SESSION_OWNERSHIP_LOST",
        false,
        "Device session ownership was lost while capturing a fresh screenshot.",
      );
    }
    if (!result.success || !result.path) {
      return freshScreenshotCaptureFailure(
        uri,
        context.signal,
        result.error || "Failed to capture a fresh screenshot.",
      );
    }

    return readFreshScreenshot(uri, sessionUuid, activeSession, context, result.path);
  } catch (error) {
    const reason = errorMessage(error);
    logger.error(
      `[ObservationResources] Failed to capture fresh screenshot for session ${sessionUuid}: ${reason}`,
    );
    return freshScreenshotCaptureFailure(
      uri,
      context.signal,
      `Failed to capture fresh screenshot for sessionUuid ${sessionUuid}: ${reason}`,
    );
  }
}

// Register all observation resources
export function registerObservationResources(): void {
  // Register latest observation as text/json resource (all devices)
  ResourceRegistry.register(
    RESOURCE_URIS.LATEST_OBSERVATION,
    "Latest Observation",
    "The most recent screen observation including view hierarchy, elements, and metadata. Updated automatically after each observe() call.",
    "application/json",
    getLatestObservation,
  );

  // Register latest screenshot as image blob resource (all devices)
  ResourceRegistry.register(
    RESOURCE_URIS.LATEST_SCREENSHOT,
    "Latest Screenshot",
    "The most recent screen capture as a PNG or WebP image. Updated automatically after each observe() call.",
    "image/png",
    getLatestScreenshot,
  );

  // Register session-scoped observation template
  ResourceRegistry.registerTemplateWithReadContext(
    RESOURCE_URIS.SESSION_OBSERVATION,
    "Session Observation",
    "Cached screen observation for an active device session.",
    "application/json",
    getSessionObservation,
  );

  // Register session-scoped cached screenshot template
  ResourceRegistry.registerTemplateWithReadContext(
    RESOURCE_URIS.SESSION_SCREENSHOT,
    "Session Screenshot",
    "Cached screen capture for an active device session.",
    "image/png",
    getSessionScreenshot,
  );

  // Register fresh session screenshot template
  ResourceRegistry.registerTemplateWithReadContext(
    RESOURCE_URIS.FRESH_SESSION_SCREENSHOT,
    "Fresh Session Screenshot",
    "Fresh PNG screen capture for an active device session. Every read captures the current screen.",
    "image/png",
    getFreshSessionScreenshot,
  );

  logger.info("[ObservationResources] Registered observation resources");
}
