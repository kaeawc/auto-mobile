import { androidProfileDefault } from "../../devices/sessionRequirements/resolution";
import { matchSessionDevice } from "../../devices/sessionRequirements";
import type {
  NormalizedSessionDeviceRequirement,
  SessionRequirementDefaults,
} from "../../devices/sessionRequirements";
import { unwrap } from "./brokerSupport";
import { poolProfile } from "./profile";

/**
 * Idle-pool candidate filter for one request. Android pool reuse also requires the same
 * `memoryMb` the host maps for the archetype, so a RAM-bounded request never takes a default-RAM
 * fold device or the reverse. A foldable without a host mapping is refused here, before pool
 * selection or reservation; phone and tablet keep resolving lazily so a pooled device can serve
 * them.
 */
export function poolMatcher(
  requirement: NormalizedSessionDeviceRequirement,
  defaults: SessionRequirementDefaults,
): (profile: unknown) => boolean {
  if (requirement.platform !== "android" || defaults.platform !== "android") {
    return (profile) => matchSessionDevice(requirement, poolProfile(profile)).kind === "match";
  }
  const mapping = androidProfileDefault(requirement, defaults);
  if (!mapping.ok && requirement.effective.hardware.archetype === "foldable") {
    unwrap(mapping);
  }
  const memoryMb = mapping.ok ? mapping.value.memoryMb : undefined;
  return (profile) => {
    const candidate = poolProfile(profile);
    return (
      matchSessionDevice(requirement, candidate).kind === "match" &&
      candidate.platform === "android" &&
      candidate.memoryMb === memoryMb
    );
  };
}
