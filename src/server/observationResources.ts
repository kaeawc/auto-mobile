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
import { detectImageMimeType } from "../utils/screenshot/imageHeaderDimensions";

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

function screenshotMimeType(path: string, imageBuffer: Buffer): string {
  const detected = detectImageMimeType(imageBuffer);
  if (detected) {
    return detected;
  }
  if (path.endsWith(".webp")) {
    return "image/webp";
  }
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  return "image/png";
}

// Resource URIs
export const RESOURCE_URIS = {
  LATEST_OBSERVATION: "automobile:observation/latest",
  LATEST_SCREENSHOT: "automobile:observation/latest/screenshot",
  SESSION_OBSERVATION: "automobile:observation/session/{sessionUuid}/latest",
  SESSION_SCREENSHOT: "automobile:observation/session/{sessionUuid}/latest/screenshot",
  FRESH_SESSION_SCREENSHOT: "automobile:device-session/{sessionUuid}/screenshot",
} as const;

// The unscoped `automobile:observation/latest` pair is served by two separate
// resource reads. Resolving "most recent across all devices" independently in
// each of them is what let one device's hierarchy be paired with another
// device's screenshot (issue #6600): a device that completes an observation
// between a client's two reads wins the second lookup. So the hierarchy read
// records the observation it served, per reading client, and the screenshot
// read serves that device instead of re-resolving the global latest.
//
// The binding is per device, not per snapshot, because that is the finest
// identity the screenshot store carries — it keys the most recent capture by
// device id alone, with no observation/snapshot id to bind to. Binding the
// device is enough to close the cross-device pairing, which is the defect.
//
// Bindings are keyed by the reading client's device session. A context-less
// read — a client that has not acquired a device session, and so has not scoped
// itself to any device — falls back to one shared unscoped key; concurrent
// sessionless clients can still overwrite each other there, which is exactly
// today's global-latest behavior and never worse than it.
const UNSCOPED_BINDING_KEY = "__unscoped__";
// Bindings are tiny (a device id per client) but the key space is unbounded
// over a long-lived daemon's session churn, so keep only the most recent few.
const MAX_LATEST_OBSERVATION_BINDINGS = 64;
const latestObservationBindings = new Map<string, string>();

function bindingKey(context: ResourceReadContext | undefined): string {
  return context?.sessionUuid ?? UNSCOPED_BINDING_KEY;
}

function rememberServedObservation(
  context: ResourceReadContext | undefined,
  deviceId: string,
): void {
  const key = bindingKey(context);
  // Delete first so the re-insert refreshes this key's position in the Map's
  // insertion order, making the eviction below least-recently-bound.
  latestObservationBindings.delete(key);
  latestObservationBindings.set(key, deviceId);
  while (latestObservationBindings.size > MAX_LATEST_OBSERVATION_BINDINGS) {
    const oldestKey = latestObservationBindings.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    latestObservationBindings.delete(oldestKey);
  }
}

// The device whose screenshot pairs with the hierarchy this client was last
// served. Falls back to the globally latest observation when this client has
// not read a hierarchy yet, or when the bound device's observation has since
// been evicted or invalidated (its screenshot no longer describes anything this
// client was shown).
function resolveScreenshotDeviceId(context: ResourceReadContext | undefined): string | undefined {
  const boundDeviceId = latestObservationBindings.get(bindingKey(context));
  if (boundDeviceId && RealObserveScreen.getRecentCachedResultForDevice(boundDeviceId)) {
    return boundDeviceId;
  }
  if (boundDeviceId) {
    latestObservationBindings.delete(bindingKey(context));
  }
  return RealObserveScreen.getRecentCachedObservation()?.deviceId;
}

/** Test-only: drop every recorded hierarchy/screenshot binding. */
export function resetLatestObservationBindings(): void {
  latestObservationBindings.clear();
}

// Helper to get the cached screenshot path for a specific device. The device is
// always the one that owns the observation being served, so the hierarchy and
// the screenshot can never describe two different devices (issue #6600).
async function getLatestScreenshotPath(deviceId: string): Promise<string | undefined> {
  try {
    const screenshotPath = RealObserveScreen.getRecentCachedScreenshotPathForDevice(deviceId);
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
async function getLatestObservation(context?: ResourceReadContext): Promise<ResourceContent> {
  try {
    const cachedObservation = RealObserveScreen.getRecentCachedObservation();

    if (!cachedObservation) {
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

    // Bind this client's follow-up screenshot read to the observation just
    // served, so a concurrent observation on another device cannot win a second
    // global lookup and pair its screenshot with this hierarchy (issue #6600).
    rememberServedObservation(context, cachedObservation.deviceId);

    // Return the observation as JSON
    return {
      uri: RESOURCE_URIS.LATEST_OBSERVATION,
      mimeType: "application/json",
      text: stringifyToolResponse(cachedObservation.result),
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
async function getLatestScreenshot(context?: ResourceReadContext): Promise<ResourceContent> {
  try {
    const deviceId = resolveScreenshotDeviceId(context);
    if (!deviceId) {
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

    let screenshotPath = await getLatestScreenshotPath(deviceId);

    if (!screenshotPath && ScreenshotJobTracker.isPending(deviceId)) {
      await ScreenshotJobTracker.waitForCompletion(deviceId, 3000);
      screenshotPath = await getLatestScreenshotPath(deviceId);
    }

    if (!screenshotPath) {
      const screenshotError = RealObserveScreen.getRecentCachedScreenshotErrorForDevice(deviceId);
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
    const mimeType = screenshotMimeType(screenshotPath, imageBuffer);

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
      mimeType: screenshotMimeType(path, imageBuffer),
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
    const mimeType = screenshotMimeType(screenshotPath, imageBuffer);

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
      {},
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
