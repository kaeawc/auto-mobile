import { ENV as ENV_SPECS } from "../config/env";
import { z } from "zod";
import {
  parseSessionDeviceRequirement,
  type SessionDeviceRequirement,
} from "./sessionRequirements";
import { errorMessage } from "../utils/describeUnknownError";
import type { LockOwnerGenerationProbe } from "../utils/fileLock";
import { ActionableError } from "../models/ActionableError";
import {
  compareExecutionOwnerIdentity,
  type ExecutionOwnerIdentityVerdict,
} from "../models/executionOwnerIdentity";

export const SESSION_CONFIG_FLAG = "--session-config";
export const SESSION_CONFIG_ENV = ENV_SPECS.SESSION_CONFIG.name;
export const SESSION_BROKER_V1_CAPABILITY = "session-broker/v1";
export const SESSION_EXPERIMENTAL_CAPABILITY = "automobile/session";

export interface SessionConfig {
  contractVersion: 1;
  requestId: string;
  device: SessionDeviceRequirement;
  preparationTimeoutMs?: number;
  idleTimeoutMs?: number;
  executionOwnerPid?: number;
  /** Proxy-only process start token; never forwarded to the daemon. */
  executionOwnerStartIdentity?: string;
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
    executionOwnerStartIdentity: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine(
    (config) =>
      config.executionOwnerStartIdentity === undefined || config.executionOwnerPid !== undefined,
    {
      message: "executionOwnerStartIdentity requires executionOwnerPid",
      path: ["executionOwnerStartIdentity"],
    },
  );

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
  noProxy?: boolean;
}

/** Resolves trusted per-proxy launch state. An explicit flag wins over the environment. */
export function resolveSessionConfig(launch: SessionConfigLaunch): SessionConfig | undefined {
  const source = launch.flagValue ?? launch.envValue;
  if (source === undefined) {
    return undefined;
  }
  if (launch.hasInitialSessionUuid || launch.noProxy) {
    throw new SessionConfigError(
      "session config is incompatible with --initial-session-uuid, and --no-proxy",
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

/** Refuses a supervising PID that now belongs to a different process. */
export function assertSessionOwnerIdentity(
  config: SessionConfig | undefined,
  compare: LockOwnerGenerationProbe["compare"],
): ExecutionOwnerIdentityVerdict | undefined {
  const pid = config?.executionOwnerPid;
  if (pid === undefined) {
    return undefined;
  }
  const verdict = compareExecutionOwnerIdentity(pid, config?.executionOwnerStartIdentity, compare);
  if (verdict === "different") {
    throw new SessionConfigError(
      `executionOwnerPid ${pid} no longer names the process described by executionOwnerStartIdentity (the PID was reused)`,
    );
  }
  return verdict;
}

/** Validates the execution owner before capturing the generation watched by the proxy. */
export function resolveSessionOwnerGenerationToken(
  config: SessionConfig | undefined,
  ports: {
    isProcessRunning: (pid: number) => boolean;
    probe: LockOwnerGenerationProbe;
  },
): string | undefined {
  const pid = config?.executionOwnerPid;
  if (pid === undefined) {
    return undefined;
  }
  assertSessionOwnerRunning(config, ports.isProcessRunning);
  const verdict = assertSessionOwnerIdentity(config, (ownerPid, recorded) =>
    ports.probe.compare(ownerPid, recorded),
  );
  return verdict === "same" ? config?.executionOwnerStartIdentity : ports.probe.current(pid);
}

export function daemonSupportsSessionBroker(capabilities: readonly string[]): boolean {
  return capabilities.includes(SESSION_BROKER_V1_CAPABILITY);
}
