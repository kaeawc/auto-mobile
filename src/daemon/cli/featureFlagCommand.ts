import { ActionableError } from "../../models/ActionableError";
import { FEATURE_FLAG_DEFINITIONS, type FeatureFlagKey } from "../../models/FeatureFlagDefinitions";
import { parseBooleanFlagValue } from "../../utils/flagTokens";
import type { DaemonMethodCallOptions } from "../client/client";

/** The daemon route the IDE plugin's settings page uses; the CLI calls the same one (#16882). */
export const SET_FEATURE_FLAG_METHOD = "ide/setFeatureFlag";

export const SET_FEATURE_FLAG_COMMAND_USAGE = "Usage: set-feature-flag <key> <true|false> [--json]";

export interface FeatureFlagCommandClient {
  connect(): Promise<void>;
  callDaemonMethod(
    method: string,
    params: Record<string, unknown>,
    options?: DaemonMethodCallOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface SetFeatureFlagArgs {
  key: FeatureFlagKey;
  enabled: boolean;
}

function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return FEATURE_FLAG_DEFINITIONS.some((definition) => definition.key === value);
}

/** Parse `<key> <true|false>`; an unknown key names every key the daemon accepts. */
export function parseSetFeatureFlagArgs(positionals: readonly string[]): SetFeatureFlagArgs {
  if (positionals.length !== 2) {
    throw new ActionableError(SET_FEATURE_FLAG_COMMAND_USAGE);
  }
  const [key, value] = positionals;
  if (!isFeatureFlagKey(key)) {
    const known = FEATURE_FLAG_DEFINITIONS.map((definition) => definition.key).join(", ");
    throw new ActionableError(`Unknown feature flag: ${key}. Known flags: ${known}`);
  }
  const enabled = parseBooleanFlagValue(value);
  if (enabled === undefined) {
    throw new ActionableError(
      `Invalid value for feature flag ${key}: ${value}; expected true or false`,
    );
  }
  return { key, enabled };
}

/**
 * Set a feature flag on the running daemon, the headless counterpart of the IDE plugin's
 * settings toggle. The daemon persists it, so it survives a daemon restart.
 */
export async function setDaemonFeatureFlag(
  args: SetFeatureFlagArgs,
  client: FeatureFlagCommandClient,
): Promise<unknown> {
  try {
    await client.connect();
    return await client.callDaemonMethod(SET_FEATURE_FLAG_METHOD, {
      key: args.key,
      enabled: args.enabled,
    });
  } finally {
    await client.close();
  }
}
