import { ActionableError } from "../../models/ActionableError";
import { parseBooleanFlagValue, splitFlagToken } from "../../utils/flagTokens";
import type { DaemonMethodCallOptions } from "../client/client";
import { DAEMON_CAPABILITIES_METHOD } from "../daemonRequestHandlers";

/** A readiness query should fail promptly when the existing daemon cannot answer. */
export const DAEMON_CAPABILITIES_TIMEOUT_MS = 5_000;

export const DAEMON_CAPABILITIES_COMMAND_USAGE = "Usage: capabilities --json";

export interface DaemonCapabilitiesCommandClient {
  connect(): Promise<void>;
  callDaemonMethod(
    method: string,
    params: Record<string, unknown>,
    options: DaemonMethodCallOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export type DaemonCapabilitiesCommandClientFactory = () => DaemonCapabilitiesCommandClient;

export interface DaemonCapabilitiesResult extends Record<string, unknown> {
  capabilities: string[];
}

/** This machine-readable readiness command deliberately has no text output mode. */
export function daemonCapabilitiesCommandArgsAreValid(args: string[]): boolean {
  if (args.length !== 1) {
    return false;
  }
  const { flag, inlineValue } = splitFlagToken(args[0]);
  return flag === "--json" && parseBooleanFlagValue(inlineValue) === true;
}

function isDaemonCapabilitiesResult(value: unknown): value is DaemonCapabilitiesResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const capabilities = (value as Record<string, unknown>).capabilities;
  return (
    Array.isArray(capabilities) &&
    capabilities.every((capability) => typeof capability === "string")
  );
}

/**
 * Query only the existing daemon's self-description. The result is returned whole so additive
 * daemon identity fields are not hidden from release-readiness consumers.
 */
export async function queryExistingDaemonCapabilities(
  args: string[],
  createClient: DaemonCapabilitiesCommandClientFactory,
): Promise<DaemonCapabilitiesResult> {
  if (!daemonCapabilitiesCommandArgsAreValid(args)) {
    throw new ActionableError(DAEMON_CAPABILITIES_COMMAND_USAGE);
  }

  const client = createClient();
  try {
    await client.connect();
    const result = await client.callDaemonMethod(
      DAEMON_CAPABILITIES_METHOD,
      {},
      {
        timeoutMs: DAEMON_CAPABILITIES_TIMEOUT_MS,
      },
    );
    if (!isDaemonCapabilitiesResult(result)) {
      throw new ActionableError("Invalid daemon capabilities result");
    }
    return result;
  } finally {
    await client.close();
  }
}
