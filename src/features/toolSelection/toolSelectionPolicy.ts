import { ActionableError } from "../../models/ActionableError";
import {
  getSessionToolSelectionService,
  type SessionToolSelectionService,
} from "./SessionToolSelectionService";
import { SET_TOOL_ENABLED_TOOL_NAME } from "./toolSelectionControl";

type ToolSelectionReader = Pick<SessionToolSelectionService, "isEnabled"> &
  Partial<Pick<SessionToolSelectionService, "getOverride">>;

/**
 * Builds the copy-pasteable `setToolEnabled` remediation call for a disabled-tool error.
 *
 * `resolveSelectionSessionUuid` (src/server/toolSelectionTools.ts) only accepts a
 * `sessionUuid` that matches the caller's current connection or routing profile — never an
 * arbitrary display string. So this only ever names a real, resolvable session uuid when
 * exactly one is known; otherwise it omits `sessionUuid` entirely, which updates the
 * connection profile and is always valid.
 */
function formatSetToolEnabledRemediation(
  toolName: string,
  realSessionUuid: string | undefined,
  remediationMethodName: string = SET_TOOL_ENABLED_TOOL_NAME,
): string {
  const sessionUuidArg = realSessionUuid ? `, sessionUuid: "${realSessionUuid}"` : "";
  return `${remediationMethodName} { toolName: "${toolName}", enabled: true${sessionUuidArg} }`;
}

/**
 * Builds the remediation sentence for `assertToolEnabledForAnySession`, distinguishing three
 * cases so the advertised call is always one the retry will actually recheck:
 *
 * 1. One or more session candidates — name a real candidate `sessionUuid` (the sole one, or
 *    the first/base-preferring one the caller's ordering rechecks when there is no
 *    `connectionProfileUuid` to fall back to).
 * 2. A `connectionProfileUuid` is part of what gets rechecked — omit `sessionUuid` entirely,
 *    which updates the connection profile the retry rechecks.
 * 3. Zero candidates AND no `connectionProfileUuid`, on the IDE-socket channel (e.g. an IDE
 *    storage request against a booted device with no owning daemon session) — that channel has
 *    no MCP connection profile to create, so there is nothing `ide/setSessionToolEnabled` could
 *    enable that the retry would recheck. Tell the caller to acquire a device session first.
 *
 *    On the MCP channel this same zero/zero state is a BRAND-NEW connection that has not yet
 *    called `setToolEnabled` at all (issue #6259 follow-up) — `src/server/index.ts:512-536`
 *    creates the connection profile lazily, the first time `setToolEnabled` is called
 *    sessionless, so the sessionless form IS real remediation here and case 3 must not apply.
 *    It naturally falls through to case 2's omitted-`sessionUuid` form below.
 */
function formatToolEnabledRemediationSentence(
  toolName: string,
  candidates: readonly string[],
  connectionProfileUuid: string | undefined,
  remediationMethodName: string = SET_TOOL_ENABLED_TOOL_NAME,
): string {
  if (
    candidates.length === 0 &&
    connectionProfileUuid === undefined &&
    remediationMethodName !== SET_TOOL_ENABLED_TOOL_NAME
  ) {
    return (
      `No device session owns this device yet, so there is nothing ${remediationMethodName} could enable ` +
      "that a retry would recheck. Acquire a device session with getAndroid { deviceId } " +
      "(or getApple { deviceId }), then enable the tool with " +
      `${formatSetToolEnabledRemediation(toolName, "<uuid from getAndroid/getApple>", remediationMethodName)}.`
    );
  }
  const realSessionUuid =
    candidates.length === 1
      ? candidates[0]
      : connectionProfileUuid === undefined
        ? candidates[0]
        : undefined;
  return `Enable it with ${formatSetToolEnabledRemediation(toolName, realSessionUuid, remediationMethodName)}.`;
}

async function explicitOverrideResult(
  service: ToolSelectionReader,
  sessionUuids: readonly string[],
  toolName: string,
): Promise<boolean | undefined> {
  if (!service.getOverride) {
    return undefined;
  }
  let explicitlyDisabled = false;
  for (const sessionUuid of sessionUuids) {
    const override = await service.getOverride(sessionUuid, toolName);
    if (override === true) {
      return true;
    }
    explicitlyDisabled ||= override === false;
  }
  return explicitlyDisabled ? false : undefined;
}

export async function isToolEnabledForSession(
  toolName: string,
  declaredDefault: boolean,
  sessionUuid: string | undefined,
  sessionToolSelectionService?: ToolSelectionReader,
): Promise<boolean> {
  if (toolName === SET_TOOL_ENABLED_TOOL_NAME) {
    return true;
  }
  return (sessionToolSelectionService ?? getSessionToolSelectionService()).isEnabled(
    sessionUuid,
    toolName,
    declaredDefault,
  );
}

export async function assertToolEnabledForSession(
  toolName: string,
  declaredDefault: boolean,
  sessionUuid: string | undefined,
  sessionToolSelectionService?: ToolSelectionReader,
): Promise<void> {
  if (
    await isToolEnabledForSession(
      toolName,
      declaredDefault,
      sessionUuid,
      sessionToolSelectionService,
    )
  ) {
    return;
  }
  const target = sessionUuid ?? "(not yet bound)";
  throw new ActionableError(
    `Tool ${toolName} is disabled for device session ${target}. ` +
      `Enable it with ${formatSetToolEnabledRemediation(toolName, sessionUuid)}.`,
  );
}

export async function isToolEnabledForAnySession(
  toolName: string,
  declaredDefault: boolean,
  sessionUuids: ReadonlyArray<string | undefined>,
  sessionToolSelectionService?: ToolSelectionReader,
  connectionProfileUuid?: string,
): Promise<boolean> {
  const candidates = Array.from(
    new Set(sessionUuids.filter((uuid): uuid is string => Boolean(uuid))),
  );
  if (candidates.length === 0) {
    return isToolEnabledForSession(
      toolName,
      declaredDefault,
      undefined,
      sessionToolSelectionService,
    );
  }

  const service = sessionToolSelectionService ?? getSessionToolSelectionService();
  if (service.getOverride) {
    const connectionOverride = connectionProfileUuid
      ? await service.getOverride(connectionProfileUuid, toolName)
      : undefined;
    const routingOverride = await explicitOverrideResult(
      service,
      candidates.filter((sessionUuid) => sessionUuid !== connectionProfileUuid),
      toolName,
    );
    if (connectionOverride === true || routingOverride === true) {
      return true;
    }
    if (connectionOverride === false || routingOverride === false) {
      return false;
    }
    return service.isEnabled(undefined, toolName, declaredDefault);
  }
  for (const sessionUuid of candidates) {
    if (await service.isEnabled(sessionUuid, toolName, declaredDefault)) {
      return true;
    }
  }
  return false;
}

export async function isToolEnabledForAnyRoute(
  toolName: string,
  declaredDefault: boolean,
  routingSessionRoutes: ReadonlyArray<ReadonlyArray<string | undefined>>,
  sessionToolSelectionService?: ToolSelectionReader,
  connectionProfileUuid?: string,
): Promise<boolean> {
  const routes = routingSessionRoutes.length > 0 ? routingSessionRoutes : [[]];
  for (const routingSessions of routes) {
    if (
      await isToolEnabledForAnySession(
        toolName,
        declaredDefault,
        [connectionProfileUuid, ...routingSessions],
        sessionToolSelectionService,
        connectionProfileUuid,
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * @param remediationMethodName The callable the remediation sentence names — the MCP
 * `setToolEnabled` tool by default. Pass `IDE_SET_SESSION_TOOL_ENABLED_METHOD` from a rejection
 * raised on the direct IDE socket channel (see `assertSocketToolEnabled` in
 * src/daemon/socketServer.ts): that caller cannot invoke an MCP tool, only the socket's own
 * `ide/setSessionToolEnabled` method (issue #6259).
 */
export async function assertToolEnabledForAnySession(
  toolName: string,
  declaredDefault: boolean,
  sessionUuids: ReadonlyArray<string | undefined>,
  sessionToolSelectionService?: ToolSelectionReader,
  connectionProfileUuid?: string,
  remediationMethodName: string = SET_TOOL_ENABLED_TOOL_NAME,
): Promise<void> {
  if (
    await isToolEnabledForAnySession(
      toolName,
      declaredDefault,
      sessionUuids,
      sessionToolSelectionService,
      connectionProfileUuid,
    )
  ) {
    return;
  }
  const candidates = Array.from(
    new Set(sessionUuids.filter((uuid): uuid is string => Boolean(uuid))),
  );
  const target = candidates.join(" / ") || "(not yet bound)";
  throw new ActionableError(
    `Tool ${toolName} is disabled for device session ${target}. ` +
      formatToolEnabledRemediationSentence(
        toolName,
        candidates,
        connectionProfileUuid,
        remediationMethodName,
      ),
  );
}
