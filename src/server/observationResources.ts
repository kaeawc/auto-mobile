import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { logger } from "../utils/logger";
import { stringifyToolResponse } from "../utils/toolUtils";
import { ScreenshotJobTracker } from "../utils/ScreenshotJobTracker";
import { DaemonState } from "../daemon/daemonState";
import { TakeScreenshot } from "../features/observe/TakeScreenshot";
import type { TrackedScreenshotService } from "../features/observe/screenshot/ObserveScreenshotRecorder";
import type { BootedDevice } from "../models";
import * as realFs from "fs/promises";

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
}

interface SessionScreenshotResourceDependencies {
  resolveActiveSession(sessionUuid: string): ActiveSessionDevice | undefined;
  createScreenshotService(device: BootedDevice): TrackedScreenshotService;
}

function resolveActiveSession(sessionUuid: string): ActiveSessionDevice | undefined {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return undefined;
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
  createScreenshotService: device => new TakeScreenshot(device),
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
        text: JSON.stringify({
          error: "No observation available. Call the 'observe' tool first to capture screen state."
        }, null, 2)
      };
    }

    // Return the observation as JSON
    return {
      uri: RESOURCE_URIS.LATEST_OBSERVATION,
      mimeType: "application/json",
      text: stringifyToolResponse(cachedResult)
    };
  } catch (error) {
    logger.error(`[ObservationResources] Failed to get latest observation: ${error}`);
    return {
      uri: RESOURCE_URIS.LATEST_OBSERVATION,
      mimeType: "application/json",
      text: JSON.stringify({
        error: `Failed to retrieve observation: ${error}`
      }, null, 2)
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
        text: JSON.stringify({
          error: "No observation available. Call the 'observe' tool first to capture a screenshot."
        }, null, 2)
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
        text: JSON.stringify({
          error: errorMessage
        }, null, 2)
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
      blob: base64Image
    };
  } catch (error) {
    logger.error(`[ObservationResources] Failed to get latest screenshot: ${error}`);
    return {
      uri: RESOURCE_URIS.LATEST_SCREENSHOT,
      mimeType: "application/json",
      text: JSON.stringify({
        error: `Failed to retrieve screenshot: ${error}`
      }, null, 2)
    };
  }
}

function sessionResourceError(uri: string, sessionUuid: string): ResourceContent {
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify({
      error: `No active device session found for sessionUuid ${sessionUuid}.`,
    }, null, 2),
  };
}

// Session-scoped handler for a cached observation.
async function getSessionObservation(params: Record<string, string>): Promise<ResourceContent> {
  const { sessionUuid } = params;
  const uri = `automobile:observation/session/${sessionUuid}/latest`;
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
        text: JSON.stringify({
          error: `No observation available for sessionUuid ${sessionUuid}. Call the 'observe' tool first.`
        }, null, 2)
      };
    }

    return {
      uri,
      mimeType: "application/json",
      text: stringifyToolResponse(cachedResult)
    };
  } catch (error) {
    logger.error(`[ObservationResources] Failed to get observation for session ${sessionUuid}: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({
        error: `Failed to retrieve observation for sessionUuid ${sessionUuid}: ${error}`
      }, null, 2)
    };
  }
}

// Session-scoped handler for a cached screenshot.
async function getSessionScreenshot(params: Record<string, string>): Promise<ResourceContent> {
  const { sessionUuid } = params;
  const uri = `automobile:observation/session/${sessionUuid}/latest/screenshot`;
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
        text: JSON.stringify({
          error: `No observation available for sessionUuid ${sessionUuid}. Call the 'observe' tool first.`
        }, null, 2)
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
        text: JSON.stringify({ error: errorMessage }, null, 2)
      };
    }

    const imageBuffer = await screenshotFileSystem.readFile(screenshotPath);
    const base64Image = imageBuffer.toString("base64");
    const mimeType = screenshotPath.endsWith(".webp") ? "image/webp" : "image/png";

    return { uri, mimeType, blob: base64Image };
  } catch (error) {
    logger.error(`[ObservationResources] Failed to get screenshot for session ${sessionUuid}: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({
        error: `Failed to retrieve screenshot for sessionUuid ${sessionUuid}: ${error}`
      }, null, 2)
    };
  }
}

// Session-scoped handler for a fresh screenshot. Every successful read captures
// the screen; it deliberately does not fall back to an observe cache.
async function getFreshSessionScreenshot(params: Record<string, string>): Promise<ResourceContent> {
  const { sessionUuid } = params;
  const uri = `automobile:device-session/${sessionUuid}/screenshot`;
  const activeSession = sessionScreenshotResourceDependencies.resolveActiveSession(sessionUuid);
  if (!activeSession) {
    return sessionResourceError(uri, sessionUuid);
  }

  try {
    const screenshotService =
      sessionScreenshotResourceDependencies.createScreenshotService(activeSession.device);
    const { promise } = screenshotService.startTrackedCapture(
      { format: "png" },
      { queueAfterPending: true },
    );
    const result = await promise;

    const currentSession = sessionScreenshotResourceDependencies.resolveActiveSession(sessionUuid);
    if (currentSession?.device.deviceId !== activeSession.device.deviceId) {
      return sessionResourceError(uri, sessionUuid);
    }
    if (!result.success || !result.path) {
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({
          error: result.error || "Failed to capture a fresh screenshot.",
        }, null, 2),
      };
    }

    const imageBuffer = await screenshotFileSystem.readFile(result.path);
    return {
      uri,
      mimeType: "image/png",
      blob: imageBuffer.toString("base64"),
    };
  } catch (error) {
    logger.error(`[ObservationResources] Failed to capture fresh screenshot for session ${sessionUuid}: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({
        error: `Failed to capture fresh screenshot for sessionUuid ${sessionUuid}: ${error}`,
      }, null, 2),
    };
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
    getLatestObservation
  );

  // Register latest screenshot as image blob resource (all devices)
  ResourceRegistry.register(
    RESOURCE_URIS.LATEST_SCREENSHOT,
    "Latest Screenshot",
    "The most recent screen capture as a PNG or WebP image. Updated automatically after each observe() call.",
    "image/png",
    getLatestScreenshot
  );

  // Register session-scoped observation template
  ResourceRegistry.registerTemplate(
    RESOURCE_URIS.SESSION_OBSERVATION,
    "Session Observation",
    "Cached screen observation for an active device session.",
    "application/json",
    getSessionObservation
  );

  // Register session-scoped cached screenshot template
  ResourceRegistry.registerTemplate(
    RESOURCE_URIS.SESSION_SCREENSHOT,
    "Session Screenshot",
    "Cached screen capture for an active device session.",
    "image/png",
    getSessionScreenshot
  );

  // Register fresh session screenshot template
  ResourceRegistry.registerTemplate(
    RESOURCE_URIS.FRESH_SESSION_SCREENSHOT,
    "Fresh Session Screenshot",
    "Fresh PNG screen capture for an active device session. Every read captures the current screen.",
    "image/png",
    getFreshSessionScreenshot
  );

  logger.info("[ObservationResources] Registered observation resources");
}
