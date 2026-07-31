import { ActionableError } from "../../models/ActionableError";
import {
  getEnvironmentDefaultToolCapabilities,
  getSessionToolProfileService,
  type SessionToolProfileService,
} from "./SessionToolProfileService";
import { TOOL_CAPABILITY_BY_NAME } from "./toolCapabilityMap";

type ToolProfileReader = Pick<SessionToolProfileService, "isEnabled"> &
  Partial<Pick<SessionToolProfileService, "getOverride">>;

async function connectionOverrideResult(
  service: ToolProfileReader,
  connectionProfileUuid: string | undefined,
  capability: NonNullable<ReturnType<typeof TOOL_CAPABILITY_BY_NAME.get>>,
  candidateSessions: readonly string[],
): Promise<boolean | undefined> {
  if (!connectionProfileUuid || !service.getOverride) {
    return undefined;
  }
  const connectionOverride = await service.getOverride(connectionProfileUuid, capability);
  if (connectionOverride !== false) {
    return connectionOverride;
  }
  for (const sessionUuid of candidateSessions.filter(uuid => uuid !== connectionProfileUuid)) {
    if (await service.getOverride(sessionUuid, capability) === true) {
      return true;
    }
  }
  return false;
}

export async function isToolEnabledForSession(
  toolName: string,
  sessionUuid: string | undefined,
  sessionToolProfileService?: ToolProfileReader,
): Promise<boolean> {
  const capability = TOOL_CAPABILITY_BY_NAME.get(toolName);
  if (!capability) {
    return true;
  }
  if (!sessionUuid) {
    // The initial tools/list has no session override to read. Consult the
    // process default directly so discovery does not construct the file-backed
    // profile repository merely to hide opt-in tools.
    return sessionToolProfileService
      ? sessionToolProfileService.isEnabled(undefined, capability)
      : getEnvironmentDefaultToolCapabilities().has(capability);
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
 * When no candidate session is bound yet, use the same process-level core
 * default as a sessionless `tools/list` or `tools/call`.
 */
export async function isToolEnabledForAnySession(
  toolName: string,
  sessionUuids: ReadonlyArray<string | undefined>,
  sessionToolProfileService?: ToolProfileReader,
  connectionProfileUuid?: string,
): Promise<boolean> {
  const capability = TOOL_CAPABILITY_BY_NAME.get(toolName);
  if (!capability) {
    return true;
  }
  const candidates = Array.from(
    new Set(sessionUuids.filter((uuid): uuid is string => Boolean(uuid)))
  );
  if (candidates.length === 0) {
    return isToolEnabledForSession(toolName, undefined, sessionToolProfileService);
  }
  const service = sessionToolProfileService ?? getSessionToolProfileService();
  // A connection-level setting is a deliberate choice for the transport, so a
  // later device binding must not overturn an explicit disable through that
  // device session's inherited process default. Explicit routing-profile
  // enables still participate in the normal base/derived union.
  const connectionOverride = await connectionOverrideResult(
    service,
    connectionProfileUuid,
    capability,
    candidates,
  );
  if (connectionOverride !== undefined) {
    return connectionOverride;
  }
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
  connectionProfileUuid?: string,
): Promise<void> {
  if (await isToolEnabledForAnySession(
    toolName,
    sessionUuids,
    sessionToolProfileService,
    connectionProfileUuid,
  )) {
    return;
  }
  const capability = TOOL_CAPABILITY_BY_NAME.get(toolName);
  const target = Array.from(new Set(sessionUuids.filter((uuid): uuid is string => Boolean(uuid)))).join(" / ")
    || "(not yet bound)";
  throw new ActionableError(
    `Tool ${toolName} requires the '${capability}' capability for device session ${target}.`
  );
}
