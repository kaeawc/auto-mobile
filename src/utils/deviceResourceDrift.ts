import { createHash } from "node:crypto";
import type { DeviceResourceStatus } from "../models/DeviceResource";
import type {
  ConfigurableDeviceResource,
  DeviceResourceConfiguration,
  RequestedDeviceResourceState,
} from "../models/DeviceResourceConfiguration";
import type {
  DeviceResourceDrift,
  SimulatorWorkloadProfile,
} from "../models/DeviceResourceReconciliation";
import { stableStringify } from "./stableStringify";

type ObservedResources = Partial<Record<ConfigurableDeviceResource, DeviceResourceStatus>>;

function entries(
  configuration: DeviceResourceConfiguration,
): [ConfigurableDeviceResource, RequestedDeviceResourceState][] {
  return (Object.keys(configuration) as ConfigurableDeviceResource[]).flatMap((resource) => {
    const state = configuration[resource];
    return state === undefined ? [] : [[resource, state]];
  });
}

/** Content identity of a workload profile; key order and omitted entries do not matter. */
export function deviceResourceProfileFingerprint(profile: SimulatorWorkloadProfile): string {
  return createHash("sha256")
    .update(stableStringify(Object.fromEntries(entries(profile.resources))))
    .digest("hex");
}

const missingEvidence: DeviceResourceStatus = {
  state: "unknown",
  reason: "The observation did not report this resource.",
};

/**
 * Requested-versus-observed comparison. Only an exact observed match is in sync;
 * unknown evidence is reported as a command failure, never as a guessed state.
 * Owned extras are recorded AutoMobile overrides outside this profile that are
 * still observed in effect.
 */
export function computeDeviceResourceDrift(
  requested: DeviceResourceConfiguration,
  observed: ObservedResources,
  owned: DeviceResourceConfiguration = {},
): DeviceResourceDrift[] {
  const drift: DeviceResourceDrift[] = [];
  for (const [resource, expected] of entries(requested)) {
    const status = observed[resource] ?? missingEvidence;
    if (status.state === expected) {
      continue;
    }
    const kind =
      status.state === "unsupported"
        ? "unsupported"
        : status.state === "unknown"
          ? "commandFailure"
          : "missingRequested";
    drift.push({ resource, kind, expected, observed: status });
  }
  for (const [resource, expected] of entries(owned)) {
    const status = observed[resource];
    if (requested[resource] === undefined && status?.state === expected) {
      drift.push({ resource, kind: "ownedExtra", expected, observed: status });
    }
  }
  return drift;
}

/**
 * Next owned-override set: prior records plus disabled resources AutoMobile changed,
 * minus resources AutoMobile re-enabled. An entry is dropped only on proof that the
 * override is gone (observed enabled or unsupported); unknown evidence keeps it.
 */
export function nextOwnedOverrides(
  prior: DeviceResourceConfiguration,
  requested: DeviceResourceConfiguration,
  changed: readonly ConfigurableDeviceResource[],
  observed: ObservedResources,
): DeviceResourceConfiguration {
  const owned: DeviceResourceConfiguration = { ...prior };
  for (const resource of changed) {
    if (requested[resource] === "disabled") {
      owned[resource] = "disabled";
    } else if (requested[resource] === "enabled") {
      delete owned[resource];
    }
  }
  return Object.fromEntries(
    entries(owned).filter(([resource, state]) => {
      const observedState = observed[resource]?.state;
      return state === "disabled" && observedState !== "enabled" && observedState !== "unsupported";
    }),
  );
}
