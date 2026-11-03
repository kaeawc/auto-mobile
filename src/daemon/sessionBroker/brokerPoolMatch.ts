import {
  androidProfileDefault,
  androidRequirementMemoryMb,
} from "../../devices/sessionRequirements/resolution";
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
 * fold device or the reverse; an exact-profile request matches only its own profile and the
 * `memoryMb` that profile is sized with. A foldable archetype without a host mapping is refused
 * here, before pool selection or reservation; phone and tablet keep resolving lazily so a pooled
 * device can serve them.
 */
export function poolMatcher(
  requirement: NormalizedSessionDeviceRequirement,
  defaults: SessionRequirementDefaults,
): (profile: unknown) => boolean {
  if (requirement.platform !== "android" || defaults.platform !== "android") {
    return (profile) => matchSessionDevice(requirement, poolProfile(profile)).kind === "match";
  }
  const hardware = requirement.effective.hardware;
  if (hardware.kind === "archetype" && hardware.archetype === "foldable") {
    unwrap(androidProfileDefault(requirement, defaults));
  }
  const sizing = androidRequirementMemoryMb(requirement, defaults);
  const memoryMb = sizing.ok ? sizing.value : undefined;
  return (profile) => {
    const candidate = poolProfile(profile);
    return (
      matchSessionDevice(requirement, candidate).kind === "match" &&
      candidate.platform === "android" &&
      candidate.memoryMb === memoryMb
    );
  };
}
