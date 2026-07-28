import { ActionableError } from "../../models/ActionableError";
import {
  getSessionToolProfileService,
  type SessionToolProfileService,
} from "./SessionToolProfileService";
import { TOOL_CAPABILITY_BY_NAME } from "./toolCapabilityMap";

type ToolProfileReader = Pick<SessionToolProfileService, "isEnabled">;

export async function isToolEnabledForSession(
  toolName: string,
  sessionUuid: string | undefined,
  sessionToolProfileService?: ToolProfileReader,
): Promise<boolean> {
  const capability = TOOL_CAPABILITY_BY_NAME.get(toolName);
  if (!capability || !sessionUuid) {
    return true;
  }
  return (sessionToolProfileService ?? getSessionToolProfileService()).isEnabled(sessionUuid, capability);
}

export async function assertToolEnabledForSession(
  toolName: string,
  sessionUuid: string | undefined,
  sessionToolProfileService?: ToolProfileReader,
): Promise<void> {
  if (await isToolEnabledForSession(toolName, sessionUuid, sessionToolProfileService)) {
    return;
  }
  const capability = TOOL_CAPABILITY_BY_NAME.get(toolName);
  throw new ActionableError(
    `Tool ${toolName} requires the '${capability}' capability for device session ${sessionUuid ?? "(not yet bound)"}.`
  );
}
