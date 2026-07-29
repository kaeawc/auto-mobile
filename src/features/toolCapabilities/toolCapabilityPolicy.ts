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

/**
 * UNION capability semantics for a derived device-label session (issue #4611
 * Gap B, product decision). A tool is enabled when EITHER the base OR the
 * derived (`${base}:${label}`) session grants the capability. This is
 * deliberately permissive: a derived label may re-enable a tool that the base
 * session narrowed away. Sessions that collapse to the same UUID (a plain base
 * session, or a deviceId whose owning session has no label) reduce to a single
 * check.
 *
 * When no candidate session is bound yet, the initial surface is preserved
 * (returns `true`), matching `isToolEnabledForSession`'s undefined-session
 * behavior — otherwise `tools/list` before a device session binds would filter
 * incorrectly.
 */
export async function isToolEnabledForAnySession(
  toolName: string,
  sessionUuids: ReadonlyArray<string | undefined>,
  sessionToolProfileService?: ToolProfileReader,
): Promise<boolean> {
  const capability = TOOL_CAPABILITY_BY_NAME.get(toolName);
  if (!capability) {
    return true;
  }
  const candidates = Array.from(
    new Set(sessionUuids.filter((uuid): uuid is string => Boolean(uuid)))
  );
  if (candidates.length === 0) {
    return true;
  }
  const service = sessionToolProfileService ?? getSessionToolProfileService();
  for (const sessionUuid of candidates) {
    if (await service.isEnabled(sessionUuid, capability)) {
      return true;
    }
  }
  return false;
}

export async function assertToolEnabledForAnySession(
  toolName: string,
  sessionUuids: ReadonlyArray<string | undefined>,
  sessionToolProfileService?: ToolProfileReader,
): Promise<void> {
  if (await isToolEnabledForAnySession(toolName, sessionUuids, sessionToolProfileService)) {
    return;
  }
  const capability = TOOL_CAPABILITY_BY_NAME.get(toolName);
  const target = Array.from(new Set(sessionUuids.filter((uuid): uuid is string => Boolean(uuid)))).join(" / ")
    || "(not yet bound)";
  throw new ActionableError(
    `Tool ${toolName} requires the '${capability}' capability for device session ${target}.`
  );
}
