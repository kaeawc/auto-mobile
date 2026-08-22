import { ActionableError } from "../../models/ActionableError";
import {
  getSessionToolSelectionService,
  type SessionToolSelectionService,
} from "./SessionToolSelectionService";
import { SET_TOOL_ENABLED_TOOL_NAME } from "./toolSelectionControl";

type ToolSelectionReader = Pick<SessionToolSelectionService, "isEnabled"> &
  Partial<Pick<SessionToolSelectionService, "getOverride">>;

async function connectionOverrideResult(
  service: ToolSelectionReader,
  connectionProfileUuid: string | undefined,
  toolName: string,
  candidateSessions: readonly string[],
): Promise<boolean | undefined> {
  if (!connectionProfileUuid || !service.getOverride) {
    return undefined;
  }
  const connectionOverride = await service.getOverride(connectionProfileUuid, toolName);
  if (connectionOverride !== false) {
    return connectionOverride;
  }
  for (const sessionUuid of candidateSessions.filter((uuid) => uuid !== connectionProfileUuid)) {
    if ((await service.getOverride(sessionUuid, toolName)) === true) {
      return true;
    }
  }
  return false;
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
  throw new ActionableError(
    `Tool ${toolName} is disabled for device session ${sessionUuid ?? "(not yet bound)"}.`,
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
  const connectionOverride = await connectionOverrideResult(
    service,
    connectionProfileUuid,
    toolName,
    candidates,
  );
  if (connectionOverride !== undefined) {
    return connectionOverride;
  }
  const routingCandidates =
    connectionProfileUuid && service.getOverride
      ? candidates.filter((sessionUuid) => sessionUuid !== connectionProfileUuid)
      : candidates;
  if (routingCandidates.length === 0) {
    return service.isEnabled(connectionProfileUuid, toolName, declaredDefault);
  }
  for (const sessionUuid of routingCandidates) {
    if (await service.isEnabled(sessionUuid, toolName, declaredDefault)) {
      return true;
    }
  }
  return false;
}

export async function assertToolEnabledForAnySession(
  toolName: string,
  declaredDefault: boolean,
  sessionUuids: ReadonlyArray<string | undefined>,
  sessionToolSelectionService?: ToolSelectionReader,
  connectionProfileUuid?: string,
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
  const target =
    Array.from(new Set(sessionUuids.filter((uuid): uuid is string => Boolean(uuid)))).join(" / ") ||
    "(not yet bound)";
  throw new ActionableError(`Tool ${toolName} is disabled for device session ${target}.`);
}
