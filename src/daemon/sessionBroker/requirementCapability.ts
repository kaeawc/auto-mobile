import {
  parseSessionDeviceRequirement,
  querySessionRequirementCapability,
  watchRequirementCapabilityRefusal,
  type RequirementResult,
  type SessionRequirementCapability,
  type SessionRequirementDefaults,
} from "../../devices/sessionRequirements";
import { failure } from "../../devices/sessionRequirements/result";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { SessionBrokerOptions } from "./brokerOptions";

function hostDefaults(
  options: Pick<SessionBrokerOptions, "defaults">,
  platform: "ios" | "android",
): RequirementResult<SessionRequirementDefaults> {
  try {
    return { ok: true, value: options.defaults(platform) };
  } catch (error) {
    logger.warn(`Requirement capability: no ${platform} defaults: ${errorMessage(error)}`);
    return failure("invalid_config", errorMessage(error), { field: "platform" });
  }
}

/**
 * Read-only capability query (#18180): reads the host catalog and defaults the broker admits
 * with and runs the shared requirement resolution. No lock, no request row, no device.
 */
export async function brokerRequirementCapability(
  options: Pick<SessionBrokerOptions, "catalog" | "defaults">,
  device: unknown,
  signal?: AbortSignal,
): Promise<RequirementResult<SessionRequirementCapability>> {
  signal?.throwIfAborted();
  const parsed = parseSessionDeviceRequirement(device);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value.platform === "watchos") {
    return watchRequirementCapabilityRefusal();
  }
  const defaults = hostDefaults(options, parsed.value.platform);
  if (!defaults.ok) {
    return defaults;
  }
  const catalog = await options.catalog(parsed.value.platform, signal);
  return querySessionRequirementCapability(parsed.value, defaults.value, catalog);
}
