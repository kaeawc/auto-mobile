import { ActionableError } from "../../models/ActionableError";
import {
  getSessionToolSelectionService,
  type SessionToolSelectionService,
} from "./SessionToolSelectionService";
import { SET_TOOL_ENABLED_TOOL_NAME } from "./toolSelectionControl";

type ToolSelectionReader = Pick<SessionToolSelectionService, "isEnabled"> &
  Partial<Pick<SessionToolSelectionService, "getOverride">>;

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
