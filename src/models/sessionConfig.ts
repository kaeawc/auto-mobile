import { z } from "zod";
import {
  parseSessionDeviceRequirement,
  type SessionDeviceRequirement,
} from "../devices/sessionRequirements";
import { errorMessage } from "../utils/describeUnknownError";
import { ActionableError } from "./ActionableError";

export const SESSION_CONFIG_FLAG = "--session-config";
export const SESSION_CONFIG_ENV = "AUTOMOBILE_SESSION_CONFIG";
export const SESSION_BROKER_V1_CAPABILITY = "session-broker/v1";
export const SESSION_EXPERIMENTAL_CAPABILITY = "automobile/session";

export interface SessionConfig {
  contractVersion: 1;
  requestId: string;
  device: SessionDeviceRequirement;
  preparationTimeoutMs?: number;
  idleTimeoutMs?: number;
  executionOwnerPid?: number;
}

export class SessionConfigError extends ActionableError {
  readonly code = "session_config_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(`session_config_invalid: ${message}`, options);
    this.name = "SessionConfigError";
  }
}

const schema = z
  .object({
    contractVersion: z.literal(1),
    requestId: z.string().trim().min(1).max(256),
    device: z.unknown(),
    preparationTimeoutMs: z.number().int().positive().optional(),
    idleTimeoutMs: z.number().int().min(120_000).max(3_600_000).optional(),
    executionOwnerPid: z.number().int().positive().optional(),
  })
  .strict();

/** Versioned launcher input: device intent and execution identity, with no allocation controls. */
export function parseSessionConfig(input: unknown): SessionConfig {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new SessionConfigError(`Invalid session configuration: ${parsed.error.message}`);
  }
  const requirement = parseSessionDeviceRequirement(parsed.data.device);
  if (!requirement.ok) {
    throw new SessionConfigError(`${requirement.error.code}: ${requirement.error.message}`);
  }
  return { ...parsed.data, device: requirement.value };
}

/** Parses an inline JSON object or a path to a JSON file without echoing malformed input. */
export function parseSessionConfigSource(
  source: string,
  readFile: (path: string) => string,
): SessionConfig {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new SessionConfigError("session config value is empty; pass inline JSON or a file path");
  }
  let text = trimmed;
  if (!trimmed.startsWith("{")) {
    try {
      text = readFile(trimmed);
    } catch (error) {
      throw new SessionConfigError(
        `cannot read session config file ${trimmed}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new SessionConfigError(
      `session config ${trimmed.startsWith("{") ? "inline value" : `file ${trimmed}`} is not valid JSON`,
    );
  }
  return parseSessionConfig(decoded);
}

export interface SessionConfigLaunch {
  flagValue?: string;
  envValue?: string;
  readFile: (path: string) => string;
  hasInitialSessionUuid?: boolean;
  hasManagedSlotConfig?: boolean;
  noProxy?: boolean;
}

/** Resolves trusted per-proxy launch state. An explicit flag wins over the environment. */
export function resolveSessionConfig(launch: SessionConfigLaunch): SessionConfig | undefined {
  const source = launch.flagValue ?? launch.envValue;
  if (source === undefined) {
    return undefined;
  }
  if (launch.hasInitialSessionUuid || launch.hasManagedSlotConfig || launch.noProxy) {
    throw new SessionConfigError(
      "session config is incompatible with managed-slot config, --initial-session-uuid, and --no-proxy",
    );
  }
  return parseSessionConfigSource(source, launch.readFile);
}

/** Refuses a stale or mistyped supervising process before daemon acquisition starts. */
export function assertSessionOwnerRunning(
  config: SessionConfig | undefined,
  isProcessRunning: (pid: number) => boolean,
): void {
  const ownerPid = config?.executionOwnerPid;
  if (ownerPid !== undefined && !isProcessRunning(ownerPid)) {
    throw new SessionConfigError(`executionOwnerPid ${ownerPid} is not a running process`);
  }
}

export function daemonSupportsSessionBroker(capabilities: readonly string[]): boolean {
  return capabilities.includes(SESSION_BROKER_V1_CAPABILITY);
}
