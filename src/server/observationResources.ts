import { screenshotPathProtection } from "../features/observe/ScreenshotPathProtection";
import {
  getRequestedResourceUri,
  ResourceRegistry,
  ResourceContent,
  type ResourceReadContext,
} from "./resourceRegistry";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { logger } from "../utils/logger";
import { safeDecodeSegment } from "./resourceUriSegments";
import { stringifyToolResponse } from "../utils/toolUtils";
import { ScreenshotJobTracker } from "../utils/ScreenshotJobTracker";
import { TakeScreenshot } from "../features/observe/TakeScreenshot";
import { resolveActiveSessionDevice, type ActiveSessionDevice } from "./activeSessionDevice";
import type { TrackedScreenshotService } from "../features/observe/screenshot/ObserveScreenshotRecorder";
import type { BootedDevice } from "../models";
import * as realFs from "fs/promises";
import { errorMessage } from "../utils/describeUnknownError";
import { OPERATION_CANCELLED_MESSAGE } from "../utils/constants";
import {
  readRetainedScreenshot,
  screenshotMimeType,
  type ScreenshotFileSystem,
} from "./retainedScreenshot";
import {
  getScreenshotStateStore,
  SCREENSHOT_CAPTURE_CANCELLED_REASON,
  SCREENSHOT_CAPTURE_SUPERSEDED_REASON,
} from "../features/observe/screenshot/ScreenshotStateRegistry";
import {
  OBSERVATION_SCREENSHOT_CAPTURE_WAIT_TIMEOUT_MS,
  OBSERVATION_SCREENSHOT_NOT_READY_RETRY_AFTER_MS,
  OBSERVATION_SCREENSHOT_URI_TEMPLATE,
} from "../daemon/observationResourceUris";
import { stripInternalObservationFields } from "./observationInternalFields";
import { markImportedPrototypeContent } from "../features/observe/importedPrototypeContent";

export interface SessionScreenshotResourceDependencies {
  resolveActiveSession(sessionUuid: string): ActiveSessionDevice | undefined;
  createScreenshotService(device: BootedDevice): TrackedScreenshotService;
}

const defaultSessionScreenshotResourceDependencies: SessionScreenshotResourceDependencies = {
  resolveActiveSession: resolveActiveSessionDevice,
  createScreenshotService: (device) => new TakeScreenshot(device),
};

export interface ObservationResourceDependencies {
  screenshotFileSystem?: ScreenshotFileSystem;
  sessionScreenshotResourceDependencies?: SessionScreenshotResourceDependencies;
}

// Resource URIs
export const RESOURCE_URIS = {
  LATEST_OBSERVATION: "automobile:observation/latest",
  LATEST_SCREENSHOT: "automobile:observation/latest/screenshot",
  /** This immutable device-and-capture identity is readable without session ownership. */
  OBSERVATION_SCREENSHOT: OBSERVATION_SCREENSHOT_URI_TEMPLATE,
  SESSION_OBSERVATION: "automobile:observation/session/{sessionUuid}/latest",
  SESSION_SCREENSHOT: "automobile:observation/session/{sessionUuid}/latest/screenshot",
  FRESH_SESSION_SCREENSHOT: "automobile:device-session/{sessionUuid}/screenshot",
} as const;

// The unscoped `automobile:observation/latest` and
// `automobile:observation/latest/screenshot` resources are separate reads
// (issue #6600). Each independently resolves the most-recent-across-all-devices
// observation from one `getRecentCachedObservation()` call at the instant it is
// read. That makes each read internally atomic: its hierarchy, or its
// screenshot-device resolution, cannot be assembled from stale, shared, or racy
// state.
//
// The pair is consequently a best-effort point-in-time snapshot, not a hard
// cross-read guarantee: a new observation can land in the small window between
// the two reads. Callers that need a guaranteed hierarchy/screenshot match from
// exactly one device can use the observation-id-scoped screenshot resource.
// It is keyed by immutable device and capture identities, is readable by any
// client (unlike session-scoped resources), and errors when that observation
// has been superseded or evicted from the device cache.

function resolveLatestScreenshotDeviceId(): string | undefined {
  return RealObserveScreen.getRecentCachedObservation()?.deviceId;
}

function isCachedScreenshotPending(deviceId: string): boolean {
  if (ScreenshotJobTracker.isPending(deviceId)) {
    return true;
  }
  const observationId = RealObserveScreen.getRecentCachedResultForDevice(deviceId)?.observationId;
  return observationId
    ? getScreenshotStateStore().isObservationPending(deviceId, observationId)
    : false;
}

export type ObservationResourceFailureCode =
  | "INVALID_REQUEST"
  | "OBSERVATION_NOT_RETAINED"
  | "SCREENSHOT_NOT_READY"
  | "SCREENSHOT_CAPTURE_FAILED"
  | "SCREENSHOT_CAPTURE_CANCELLED"
  | "SCREENSHOT_CAPTURE_SUPERSEDED"
  | "SCREENSHOT_NOT_CAPTURED"
  | "SCREENSHOT_FILE_UNAVAILABLE"
  | "SCREENSHOT_ACCESS_DENIED"
  | "SCREENSHOT_READ_FAILED"
  | "OBSERVATION_NOT_AVAILABLE"
  | "OBSERVATION_READ_FAILED"
  | "SESSION_NOT_BOUND"
  | "SESSION_NOT_ACTIVE";

interface ObservationResourceIdentity {
  deviceId?: string;
  observationId?: string;
  sessionUuid?: string;
}

function observationResourceError(
  uri: string,
  code: ObservationResourceFailureCode,
  error: string,
  identity: ObservationResourceIdentity = {},
): ResourceContent {
  const retryable = code === "SCREENSHOT_NOT_READY";
  const body = {
    code,
    retryable,
    ...(retryable ? { retryAfterMs: OBSERVATION_SCREENSHOT_NOT_READY_RETRY_AFTER_MS } : {}),
    error,
    ...(identity.deviceId ? { deviceId: identity.deviceId } : {}),
    ...(identity.observationId ? { observationId: identity.observationId } : {}),
    ...(identity.sessionUuid ? { sessionUuid: identity.sessionUuid } : {}),
  };
  return { uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) };
}

function screenshotCaptureFailureCode(reason: string | undefined): ObservationResourceFailureCode {
  if (reason === SCREENSHOT_CAPTURE_CANCELLED_REASON) {
    return "SCREENSHOT_CAPTURE_CANCELLED";
  }
  if (reason === SCREENSHOT_CAPTURE_SUPERSEDED_REASON) {
    return "SCREENSHOT_CAPTURE_SUPERSEDED";
  }
  return reason ? "SCREENSHOT_CAPTURE_FAILED" : "SCREENSHOT_NOT_CAPTURED";
}

function hasErrnoCode(error: unknown): error is { code: string } {
  return (
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
  );
}

function screenshotFileFailureCode(error: unknown): ObservationResourceFailureCode {
  if (!hasErrnoCode(error)) {
    return "SCREENSHOT_READ_FAILED";
  }
  switch (error.code) {
    case "ENOENT":
    case "ENOTDIR":
      return "SCREENSHOT_FILE_UNAVAILABLE";
    case "EACCES":
    case "EPERM":
      return "SCREENSHOT_ACCESS_DENIED";
    default:
      return "SCREENSHOT_READ_FAILED";
  }
}

async function screenshotNotFileError(
  uri: string,
  path: string,
  identity: ObservationResourceIdentity,
  deps: ObservationResourceDependencies = {},
): Promise<ResourceContent | undefined> {
  const fileStat = await screenshotFiles(deps).stat(path);
  if (!fileStat.isFile()) {
    return observationResourceError(
      uri,
      "SCREENSHOT_FILE_UNAVAILABLE",
      "The retained screenshot path is not a file. Call the 'observe' tool again to capture a screenshot.",
      identity,
    );
  }
  return undefined;
}

// Resolve the selected device's path, preserving stat/protection failure evidence.
async function getLatestScreenshotPath(
  deviceId: string,
  deps: ObservationResourceDependencies = {},
): Promise<string | ResourceContent | undefined> {
  try {
    const screenshotPath = RealObserveScreen.getRecentCachedScreenshotPathForDevice(deviceId);
    if (!screenshotPath) {
      return undefined;
    }
    await screenshotPathProtection.protect(screenshotPath);
    const unavailable = await screenshotNotFileError(
      RESOURCE_URIS.LATEST_SCREENSHOT,
      screenshotPath,
      { deviceId },
      deps,
    );
    if (unavailable) {
      return unavailable;
    }
    await screenshotPathProtection.protect(screenshotPath);
    return screenshotPath;
  } catch (error) {
    logger.warn("[ObservationResources] Failed to get latest screenshot", error);
    return observationResourceError(
      RESOURCE_URIS.LATEST_SCREENSHOT,
      screenshotFileFailureCode(error),
      `Failed to retrieve screenshot: ${errorMessage(String(error))}`,
      { deviceId },
    );
  }
}

// Handler for latest observation resource (text/json)
async function getLatestObservation(): Promise<ResourceContent> {
  let deviceId: string | undefined;
  try {
    const cachedObservation = RealObserveScreen.getRecentCachedObservation();
    if (!cachedObservation) {
      return observationResourceError(
        RESOURCE_URIS.LATEST_OBSERVATION,
        "OBSERVATION_NOT_AVAILABLE",
        "No observation available. Call the 'observe' tool first to capture screen state.",
      );
    }
    deviceId = cachedObservation.deviceId;
    // The cache is shared with tool paths that still need internal observation fields.
    const observation = { ...cachedObservation.result };
    stripInternalObservationFields(observation);
    // The cached capture bypasses sanitization, so imported UI text needs its notice here.
    markImportedPrototypeContent(observation, observation);
    return {
      uri: RESOURCE_URIS.LATEST_OBSERVATION,
      mimeType: "application/json",
      text: stringifyToolResponse(observation),
    };
  } catch (error) {
    logger.warn("[ObservationResources] Failed to get latest observation", error);
    return observationResourceError(
      RESOURCE_URIS.LATEST_OBSERVATION,
      "OBSERVATION_READ_FAILED",
      `Failed to retrieve observation: ${errorMessage(String(error))}`,
      { deviceId },
    );
  }
}

// Handler for latest screenshot resource (image blob)
async function getLatestScreenshot(
  deps: ObservationResourceDependencies = {},
): Promise<ResourceContent> {
  let deviceId: string | undefined;
  try {
    deviceId = resolveLatestScreenshotDeviceId();
    if (!deviceId) {
      return observationResourceError(
        RESOURCE_URIS.LATEST_SCREENSHOT,
        "OBSERVATION_NOT_AVAILABLE",
        "No observation available. Call the 'observe' tool first to capture a screenshot.",
      );
    }
    let screenshotPath = await getLatestScreenshotPath(deviceId, deps);
    if (typeof screenshotPath !== "string" && ScreenshotJobTracker.isPending(deviceId)) {
      await ScreenshotJobTracker.waitForCompletion(deviceId, 3000);
      screenshotPath = await getLatestScreenshotPath(deviceId, deps);
    }
    if (typeof screenshotPath !== "string" && isCachedScreenshotPending(deviceId)) {
      return observationResourceError(
        RESOURCE_URIS.LATEST_SCREENSHOT,
        "SCREENSHOT_NOT_READY",
        "Screenshot for the latest observation is not ready yet. Call the resource again after the capture completes.",
        { deviceId },
      );
    }
    if (typeof screenshotPath === "object") {
      return screenshotPath;
    }
    if (!screenshotPath) {
      const screenshotError = RealObserveScreen.getRecentCachedScreenshotErrorForDevice(deviceId);
      const message = screenshotError
        ? `No screenshot available from the latest observation: ${screenshotError}`
        : "No screenshot available. Call the 'observe' tool again to capture a screenshot.";
      return observationResourceError(
        RESOURCE_URIS.LATEST_SCREENSHOT,
        screenshotCaptureFailureCode(screenshotError),
        message,
        { deviceId },
      );
    }
    await screenshotPathProtection.protect(screenshotPath);
    const imageBuffer = await screenshotFiles(deps).readFile(screenshotPath);
    return {
      uri: RESOURCE_URIS.LATEST_SCREENSHOT,
      mimeType: screenshotMimeType(screenshotPath, imageBuffer),
      blob: imageBuffer.toString("base64"),
    };
  } catch (error) {
    logger.warn("[ObservationResources] Failed to get latest screenshot", error);
    return observationResourceError(
      RESOURCE_URIS.LATEST_SCREENSHOT,
      screenshotFileFailureCode(error),
      `Failed to retrieve screenshot: ${errorMessage(String(error))}`,
      { deviceId },
    );
  }
}

function observationScreenshotUnknownError(
  uri: string,
  deviceId: string,
  observationId: string,
): ResourceContent {
  return observationResourceError(
    uri,
    "OBSERVATION_NOT_RETAINED",
    `Observation id ${observationId} is unknown or has been superseded or evicted by a newer observation for device ${deviceId}. Call the 'observe' tool again.`,
    { deviceId, observationId },
  );
}

function observationScreenshotNotReadyError(
  uri: string,
  deviceId: string,
  observationId: string,
): ResourceContent {
  return observationResourceError(
    uri,
    "SCREENSHOT_NOT_READY",
    `Screenshot for observation id ${observationId} is not ready yet. Call the resource again after the capture completes.`,
    { deviceId, observationId },
  );
}

function observationScreenshotMalformedUriError(uri: string): ResourceContent {
  return observationResourceError(
    uri,
    "INVALID_REQUEST",
    "Malformed resource URI: a path segment is not valid percent-encoding.",
  );
}

function matchesObservationId(deviceId: string, observationId: string): boolean {
  const cachedResult = RealObserveScreen.getRecentCachedResultForDevice(deviceId);
  return cachedResult?.observationId === observationId;
}

async function waitForObservationScreenshot(
  uri: string,
  deviceId: string,
  observationId: string,
): Promise<ResourceContent | undefined> {
  const store = getScreenshotStateStore();
  await store.waitForObservation(
    deviceId,
    observationId,
    OBSERVATION_SCREENSHOT_CAPTURE_WAIT_TIMEOUT_MS,
  );
  if (!matchesObservationId(deviceId, observationId)) {
    return observationScreenshotUnknownError(uri, deviceId, observationId);
  }
  if (store.isObservationPending(deviceId, observationId)) {
    return observationScreenshotNotReadyError(uri, deviceId, observationId);
  }
  return undefined;
}

// Resolves an immutable observation's cached screenshot without waiting on an
// unrelated capture for the same device.
async function resolveObservationScreenshotPath(
  uri: string,
  deviceId: string,
  observationId: string,
): Promise<{ path: string | undefined } | ResourceContent> {
  let path = RealObserveScreen.getRecentCachedScreenshotPathForObservation(deviceId, observationId);
  if (!matchesObservationId(deviceId, observationId)) {
    return observationScreenshotUnknownError(uri, deviceId, observationId);
  }

  if (path) {
    return { path };
  }

  const pendingResult = await waitForObservationScreenshot(uri, deviceId, observationId);
  if (pendingResult) {
    return pendingResult;
  }
  path = RealObserveScreen.getRecentCachedScreenshotPathForObservation(deviceId, observationId);
  if (!matchesObservationId(deviceId, observationId)) {
    return observationScreenshotUnknownError(uri, deviceId, observationId);
  }
  return { path };
}

// Handler for the screenshot captured alongside one immutable device observation.
async function getObservationScreenshot(
  params: Record<string, string>,
  deps: ObservationResourceDependencies,
): Promise<ResourceContent> {
  const uri =
    getRequestedResourceUri(params) ??
    `automobile:observation/${params.deviceId}/${params.observationId}/screenshot`;
  const deviceId = safeDecodeSegment(params.deviceId);
  const observationId = safeDecodeSegment(params.observationId);

  if (deviceId === null || observationId === null) {
    return observationScreenshotMalformedUriError(uri);
  }

  try {
    if (!matchesObservationId(deviceId, observationId)) {
      return observationScreenshotUnknownError(uri, deviceId, observationId);
    }

    const screenshotPathResult = await resolveObservationScreenshotPath(
      uri,
      deviceId,
      observationId,
    );
    if (!("path" in screenshotPathResult)) {
      return screenshotPathResult;
    }
    const { path: screenshotPath } = screenshotPathResult;

    if (!screenshotPath) {
      const screenshotError = RealObserveScreen.getRecentCachedScreenshotErrorForObservation(
        deviceId,
        observationId,
      );
      const message = screenshotError
        ? `No screenshot available for observation id ${observationId}: ${screenshotError}`
        : "No screenshot available. Call the 'observe' tool again to capture a screenshot.";
      return observationResourceError(uri, screenshotCaptureFailureCode(screenshotError), message, {
        deviceId,
        observationId,
      });
    }

    const unavailable = await screenshotNotFileError(
      uri,
      screenshotPath,
      {
        deviceId,
        observationId,
      },
      deps,
    );
    if (unavailable) {
      return unavailable;
    }
    const image = await readRetainedScreenshot({
      path: screenshotPath,
      fileSystem: deps.screenshotFileSystem ?? realFs,
    });
    if (!matchesObservationId(deviceId, observationId)) {
      return observationScreenshotUnknownError(uri, deviceId, observationId);
    }

    return {
      uri,
      mimeType: image.mimeType,
      blob: image.data,
    };
  } catch (error) {
    logger.warn(
      `[ObservationResources] Failed to get screenshot for observation ${observationId} on device ${deviceId}`,
      error,
    );
    return observationResourceError(
      uri,
      screenshotFileFailureCode(error),
      `Failed to retrieve screenshot for observation id ${observationId}: ${errorMessage(String(error))}`,
      { deviceId, observationId },
    );
  }
}

const OBSERVATION_SCREENSHOT_URI_PATTERN =
  /^automobile:observation\/([^/&]+)\/([^/&]+)\/screenshot$/;

export type ObservationScreenshotBytes =
  | { bytes: Buffer; mimeType: string }
  | { error: string; code?: string; retryable?: boolean };

function resourceErrorText(content: ResourceContent): {
  error: string;
  code?: string;
  retryable?: boolean;
} {
  try {
    const parsed: unknown = JSON.parse(content.text ?? "");
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string"
    ) {
      return {
        error: parsed.error,
        ...("code" in parsed && typeof parsed.code === "string" ? { code: parsed.code } : {}),
        ...("retryable" in parsed && typeof parsed.retryable === "boolean"
          ? { retryable: parsed.retryable }
          : {}),
      };
    }
  } catch (error) {
    // Our own error envelope is JSON; anything else falls back to the raw text below.
    logger.warn(`[ObservationResources] Non-JSON resource error body: ${errorMessage(error)}`);
  }
  return { error: content.text ?? `No screenshot was returned for ${content.uri}.` };
}

/**
 * Reads the bytes behind `automobile:observation/{deviceId}/{observationId}/screenshot` for host
 * consumers such as the prototype tool. It runs the same handler as the resource read, so the
 * observation must still be the device's current one, a pending capture is awaited, and the file
 * is read through the same retention lease. That resource is readable by any client without
 * session ownership, so this exposes nothing a client could not already read.
 */
export async function readObservationScreenshotBytes(
  uri: string,
  deps: ObservationResourceDependencies = {},
): Promise<ObservationScreenshotBytes> {
  const match = OBSERVATION_SCREENSHOT_URI_PATTERN.exec(uri);
  if (!match) {
    return {
      error: `'${uri}' is not an observation screenshot URI; expected ${OBSERVATION_SCREENSHOT_URI_TEMPLATE}.`,
    };
  }
  const content = await getObservationScreenshot(
    { deviceId: match[1], observationId: match[2] },
    deps,
  );
  if (content.blob === undefined) {
    return resourceErrorText(content);
  }
  return { bytes: Buffer.from(content.blob, "base64"), mimeType: content.mimeType ?? "image/png" };
}

function sessionResourceError(uri: string, sessionUuid: string): ResourceContent {
  return observationResourceError(
    uri,
    "SESSION_NOT_ACTIVE",
    `No active device session found for sessionUuid ${sessionUuid}.`,
    { sessionUuid },
  );
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

function unauthorizedSessionResourceError(uri: string, sessionUuid: string): ResourceContent {
  return observationResourceError(
    uri,
    "SESSION_NOT_BOUND",
    "This resource can only be read by its bound device session.",
    { sessionUuid },
  );
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
  return context.sessionUuid === sessionUuid || context.ownsSession?.(sessionUuid) === true;
}

function releasedSessionNotActiveError(
  uri: string,
  context: ResourceReadContext,
  sessionUuid: string,
  deps: ObservationResourceDependencies = {},
): ResourceContent | undefined {
  if (
    context.releasedSessionUuid === sessionUuid &&
    !sessionScreenshotDependencies(deps).resolveActiveSession(sessionUuid)
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
  {
    context,
    path,
    deps = {},
  }: { context: ResourceReadContext; path: string; deps?: ObservationResourceDependencies },
): Promise<ResourceContent> {
  try {
    await screenshotPathProtection.protect(path);
    const imageBuffer = await screenshotFiles(deps).readFile(path);
    if (context.signal?.aborted) {
      return freshSessionScreenshotError(
        uri,
        "SCREENSHOT_CAPTURE_CANCELLED",
        false,
        OPERATION_CANCELLED_MESSAGE,
      );
    }
    const finalSession = sessionScreenshotDependencies(deps).resolveActiveSession(sessionUuid);
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
    const failedReadSession = sessionScreenshotDependencies(deps).resolveActiveSession(sessionUuid);
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
  deps: ObservationResourceDependencies = {},
): Promise<ResourceContent> {
  const { sessionUuid } = params;
  const uri = `automobile:observation/session/${sessionUuid}/latest`;
  if (!isAuthorizedSessionResource(context, sessionUuid)) {
    return unauthorizedSessionResourceError(uri, sessionUuid);
  }
  const activeSession = sessionScreenshotDependencies(deps).resolveActiveSession(sessionUuid);
  if (!activeSession) {
    return sessionResourceError(uri, sessionUuid);
  }

  const { deviceId } = activeSession.device;
  try {
    const cachedResult = RealObserveScreen.getRecentCachedResultForDevice(deviceId);

    if (!cachedResult) {
      return observationResourceError(
        uri,
        "OBSERVATION_NOT_AVAILABLE",
        `No observation available for sessionUuid ${sessionUuid}. Call the 'observe' tool first.`,
        { deviceId, sessionUuid },
      );
    }

    // The cache is shared with tool paths that still need internal observation fields.
    const observation = { ...cachedResult };
    stripInternalObservationFields(observation);
    markImportedPrototypeContent(observation, observation);

    return {
      uri,
      mimeType: "application/json",
      text: stringifyToolResponse(observation),
    };
  } catch (error) {
    logger.warn(
      `[ObservationResources] Failed to get observation for session ${sessionUuid}`,
      error,
    );
    return observationResourceError(
      uri,
      "OBSERVATION_READ_FAILED",
      `Failed to retrieve observation for sessionUuid ${sessionUuid}: ${errorMessage(String(error))}`,
      { deviceId, sessionUuid },
    );
  }
}

// Session-scoped handler for a cached screenshot.
async function getSessionScreenshot(
  params: Record<string, string>,
  context: ResourceReadContext,
  deps: ObservationResourceDependencies = {},
): Promise<ResourceContent> {
  const { sessionUuid } = params;
  const uri = `automobile:observation/session/${sessionUuid}/latest/screenshot`;
  if (!isAuthorizedSessionResource(context, sessionUuid)) {
    return unauthorizedSessionResourceError(uri, sessionUuid);
  }
  const activeSession = sessionScreenshotDependencies(deps).resolveActiveSession(sessionUuid);
  if (!activeSession) {
    return sessionResourceError(uri, sessionUuid);
  }

  const { deviceId } = activeSession.device;
  try {
    const cachedResult = RealObserveScreen.getRecentCachedResultForDevice(deviceId);
    if (!cachedResult) {
      return observationResourceError(
        uri,
        "OBSERVATION_NOT_AVAILABLE",
        `No observation available for sessionUuid ${sessionUuid}. Call the 'observe' tool first.`,
        { deviceId, sessionUuid },
      );
    }

    const screenshotPath = RealObserveScreen.getRecentCachedScreenshotPathForDevice(deviceId);
    if (!screenshotPath) {
      if (isCachedScreenshotPending(deviceId)) {
        return observationResourceError(
          uri,
          "SCREENSHOT_NOT_READY",
          `Screenshot for sessionUuid ${sessionUuid} is not ready yet. Call the resource again after the capture completes.`,
          { deviceId, sessionUuid },
        );
      }
      const screenshotError = RealObserveScreen.getRecentCachedScreenshotErrorForDevice(deviceId);
      const message = screenshotError
        ? `No screenshot available for sessionUuid ${sessionUuid}: ${screenshotError}`
        : `No screenshot available for sessionUuid ${sessionUuid}. Call the 'observe' tool again.`;
      return observationResourceError(uri, screenshotCaptureFailureCode(screenshotError), message, {
        deviceId,
        sessionUuid,
      });
    }

    const unavailable = await screenshotNotFileError(
      uri,
      screenshotPath,
      {
        deviceId,
        sessionUuid,
      },
      deps,
    );
    if (unavailable) {
      return unavailable;
    }
    await screenshotPathProtection.protect(screenshotPath);
    const imageBuffer = await screenshotFiles(deps).readFile(screenshotPath);
    const base64Image = imageBuffer.toString("base64");
    const mimeType = screenshotMimeType(screenshotPath, imageBuffer);

    return { uri, mimeType, blob: base64Image };
  } catch (error) {
    logger.warn(
      `[ObservationResources] Failed to get screenshot for session ${sessionUuid}`,
      error,
    );
    return observationResourceError(
      uri,
      screenshotFileFailureCode(error),
      `Failed to retrieve screenshot for sessionUuid ${sessionUuid}: ${errorMessage(String(error))}`,
      { deviceId, sessionUuid },
    );
  }
}

// Session-scoped handler for a fresh screenshot. Every successful read captures
// the screen; it deliberately does not fall back to an observe cache.
async function getFreshSessionScreenshot(
  params: Record<string, string>,
  context: ResourceReadContext,
  deps: ObservationResourceDependencies = {},
): Promise<ResourceContent> {
  const { sessionUuid } = params;
  const uri = `automobile:device-session/${sessionUuid}/screenshot`;
  if (!isAuthorizedSessionResource(context, sessionUuid)) {
    return (
      releasedSessionNotActiveError(uri, context, sessionUuid, deps) ??
      unauthorizedFreshScreenshotError(uri)
    );
  }
  const activeSession = sessionScreenshotDependencies(deps).resolveActiveSession(sessionUuid);
  if (!activeSession) {
    return freshSessionScreenshotError(
      uri,
      "SESSION_NOT_ACTIVE",
      false,
      `No active device session found for sessionUuid ${sessionUuid}.`,
    );
  }

  try {
    const screenshotService = sessionScreenshotDependencies(deps).createScreenshotService(
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

    const currentSession = sessionScreenshotDependencies(deps).resolveActiveSession(sessionUuid);
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

    return readFreshScreenshot(uri, sessionUuid, activeSession, {
      context,
      path: result.path,
      deps,
    });
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
export function registerObservationResources(deps: ObservationResourceDependencies = {}): void {
  // Register latest observation as text/json resource (all devices)
  ResourceRegistry.register(RESOURCE_URIS.LATEST_OBSERVATION, "Latest Observation", {
    description:
      "The hierarchy and unscoped screenshot are a best-effort point-in-time snapshot per read, with no hard cross-read guarantee: another device's newer observation can land between reads. Failures are application/json with code, retryable, error.",
    mimeType: "application/json",
    handler: getLatestObservation,
  });

  // Register latest screenshot as image blob resource (all devices)
  ResourceRegistry.register(RESOURCE_URIS.LATEST_SCREENSHOT, "Latest Screenshot", {
    description:
      "The most recent screen capture as a PNG or WebP image. Updated automatically after each observe() call. Failures are application/json with code, retryable, error.",
    mimeType: "image/png",
    handler: () => getLatestScreenshot(deps),
  });

  // This template has no read context: a known observation identity is readable
  // by any client, but becomes unavailable after a newer device observation evicts it.
  ResourceRegistry.registerTemplate(
    RESOURCE_URIS.OBSERVATION_SCREENSHOT,
    "Observation Screenshot",
    {
      description:
        "Screen capture paired with one immutable device observation identity. Readable by any client and unavailable after that observation is superseded or evicted. Failures are application/json with code, retryable, error. SCREENSHOT_NOT_READY: read the same URI again; OBSERVATION_NOT_RETAINED: observe again.",
      mimeType: "image/png",
      handler: (params: Record<string, string>) => getObservationScreenshot(params, deps),
    },
  );

  // Register session-scoped observation template
  ResourceRegistry.registerTemplateWithReadContext(
    RESOURCE_URIS.SESSION_OBSERVATION,
    "Session Observation",
    {
      description:
        "Cached screen observation for an active device session. Failures are application/json with code, retryable, error.",
      mimeType: "application/json",
      handler: (params: Record<string, string>, context: ResourceReadContext) =>
        getSessionObservation(params, context, deps),
    },
  );

  // Register session-scoped cached screenshot template
  ResourceRegistry.registerTemplateWithReadContext(
    RESOURCE_URIS.SESSION_SCREENSHOT,
    "Session Screenshot",
    {
      description:
        "Cached screen capture for an active device session. Failures are application/json with code, retryable, error.",
      mimeType: "image/png",
      handler: (params: Record<string, string>, context: ResourceReadContext) =>
        getSessionScreenshot(params, context, deps),
    },
  );

  // Register fresh session screenshot template
  ResourceRegistry.registerTemplateWithReadContext(
    RESOURCE_URIS.FRESH_SESSION_SCREENSHOT,
    "Fresh Session Screenshot",
    {
      description:
        "Fresh PNG screen capture for an active device session. Every read captures the current screen. Failures are application/json with code, retryable, error.",
      mimeType: "image/png",
      handler: (params: Record<string, string>, context: ResourceReadContext) =>
        getFreshSessionScreenshot(params, context, deps),
    },
  );

  logger.info("[ObservationResources] Registered observation resources");
}

function screenshotFiles(deps: ObservationResourceDependencies): ScreenshotFileSystem {
  return deps.screenshotFileSystem ?? realFs;
}
function sessionScreenshotDependencies(
  deps: ObservationResourceDependencies,
): SessionScreenshotResourceDependencies {
  return deps.sessionScreenshotResourceDependencies ?? defaultSessionScreenshotResourceDependencies;
}
