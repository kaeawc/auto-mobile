import {
  parseSessionDeviceRequirement,
  querySessionRequirementCapability,
  watchRequirementCapabilityRefusal,
  type DefaultedSessionDeviceRequirement,
  type RequirementResult,
  type SessionRequirementCapability,
  type SessionRequirementDefaults,
} from "../../devices/sessionRequirements";
import { failure, success } from "../../devices/sessionRequirements/result";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { SessionBrokerOptions } from "./brokerOptions";
import { assertDeviceProfileEmulatable } from "./deviceProfile";
import { SessionBrokerFailureError } from "./devicePort";

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
 * Admission's non-emulatable manufacturer-profile gate (#14058), as the answer's reason: no
 * installed OS can serve the requirement, so every satisfiability flag is false.
 */
function applyDeviceProfileGate(
  request: DefaultedSessionDeviceRequirement,
  answer: RequirementResult<SessionRequirementCapability>,
): RequirementResult<SessionRequirementCapability> {
  if (!answer.ok || request.platform !== "android") {
    return answer;
  }
  try {
    assertDeviceProfileEmulatable(request.deviceProfile);
    return answer;
  } catch (error) {
    if (!(error instanceof SessionBrokerFailureError)) {
      throw error;
    }
    // Expected refusal: reported as the answer's reason, not raised to the caller.
    logger.debug(`Requirement capability: ${error.failure.message}`);
    return success({
      ...answer.value,
      satisfiable: false,
      reason: { code: "requires_real_device", message: error.failure.message, transient: false },
      defaultOsSatisfiable: false,
      anyOsSatisfiable: false,
    });
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
  return applyDeviceProfileGate(
    parsed.value,
    querySessionRequirementCapability(parsed.value, defaults.value, catalog),
  );
}
