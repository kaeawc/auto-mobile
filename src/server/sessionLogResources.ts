import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { resolveActiveSessionDevice, type ActiveSessionResolver } from "./activeSessionDevice";
import {
  getRequestedResourceUri,
  ResourceRegistry,
  type ResourceContent,
  type ResourceReadContext,
} from "./resourceRegistry";
import {
  SESSION_LOG_RESOURCE_TEMPLATE,
  buildSessionLogResourceUri,
  parseSessionLogQuery,
} from "./sessionLogContract";
import { getSessionLogService, type SessionLogService } from "./sessionLogService";

export interface SessionLogResourceDependencies {
  resolveActiveSession: ActiveSessionResolver;
  service: () => SessionLogService;
}

const defaultDependencies: SessionLogResourceDependencies = {
  resolveActiveSession: resolveActiveSessionDevice,
  service: getSessionLogService,
};

/** A malformed percent-escape can never name a bound session; keep it verbatim so it fails the binding check. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    logger.debug(`[SessionLogResources] undecodable session segment ${value}: ${error}`);
    return value;
  }
}

function jsonError(uri: string, code: string, error: string): ResourceContent {
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify({ code, error }, null, 2),
  };
}

function createSessionLogHandler(deps: SessionLogResourceDependencies) {
  return async (
    params: Record<string, string>,
    context: ResourceReadContext,
  ): Promise<ResourceContent> => {
    const { sessionUuid: rawSessionUuid, appId, ...query } = params;
    const sessionUuid = safeDecode(rawSessionUuid);
    const requestedUri =
      getRequestedResourceUri(params) ??
      `automobile:device-session/${rawSessionUuid}/apps/${appId}/logs`;

    // Session binding comes first, and before any parsing: a caller that does not
    // own this session learns nothing about the device, and no device client is
    // ever constructed for a read the session cannot make.
    if (context.sessionUuid !== sessionUuid) {
      return jsonError(
        requestedUri,
        "SESSION_NOT_BOUND",
        "This resource can only be read by its bound device session.",
      );
    }
    const activeSession = deps.resolveActiveSession(sessionUuid);
    if (!activeSession) {
      return jsonError(
        requestedUri,
        "SESSION_NOT_ACTIVE",
        `No active device session found for sessionUuid ${sessionUuid}.`,
      );
    }

    let request;
    try {
      request = parseSessionLogQuery(appId, query);
    } catch (error) {
      return jsonError(requestedUri, "INVALID_REQUEST", errorMessage(error));
    }

    const uri = buildSessionLogResourceUri(sessionUuid, request);
    try {
      const result = await deps.service().collect({
        sessionUuid,
        device: activeSession.device,
        request,
        signal: context.signal,
      });
      return { uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) };
    } catch (error) {
      // Per-source failures are already outcomes; only a failure to reach the
      // service at all (unsupported platform, cancelled read) lands here.
      logger.warn(
        `[SessionLogResources] collection failed for session ${sessionUuid}: ${errorMessage(error)}`,
        error,
      );
      return jsonError(uri, "COLLECTION_FAILED", errorMessage(error));
    }
  };
}

export function registerSessionLogResources(
  overrides: Partial<SessionLogResourceDependencies> = {},
): void {
  const deps = { ...defaultDependencies, ...overrides };
  ResourceRegistry.registerTemplateWithReadContext(
    SESSION_LOG_RESOURCE_TEMPLATE,
    "Session Execution Logs",
    "Collect bounded execution logs for an app on the device owned by the caller's session: " +
      "named app-container log files (`container`, `paths`), iOS Simulator App Group files " +
      "(`groupId`, `groupPaths`), and an app-scoped unified-log window (`lastSeconds`, `level`). " +
      "Each source reports its own outcome; `maxBytes` bounds every entry.",
    "application/json",
    createSessionLogHandler(deps),
  );
}
