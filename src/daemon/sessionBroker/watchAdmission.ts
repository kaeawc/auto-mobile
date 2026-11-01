import {
  matchWatchSessionDevice,
  normalizeWatchSessionDeviceRequirement,
  type SessionDeviceRequirement,
} from "../../devices/sessionRequirements";
import type { SessionConfig } from "../../devices/sessionConfig";
import type { SessionBrokerReadiness } from "../../devices/sessionBrokerResult";
import { ActionableError } from "../../models/ActionableError";
import type { SessionBrokerOptions } from "./brokerOptions";
import { unwrap } from "./devicePort";
import { nativeProfile, poolProfile } from "./profile";
import { WATCH_BOOTED_READINESS } from "./provisioning/bindingReadiness";
import type { BrokerAdmissionInput, BrokerExportIdentity, BrokerResourceRecord } from "./store";

/**
 * Admission for an exact Apple Watch request (#15882): validated against the installed watch
 * catalog before anything is reserved, it reuses only a pooled watch with the same runtime and
 * device type and otherwise creates exactly that watch. Watches have no host defaults or
 * capabilities. A watch counts against the same `totalDeviceCap` as every other device.
 */
export async function watchAdmissionInput(
  options: Pick<SessionBrokerOptions, "catalog" | "owner" | "limits">,
  config: SessionConfig,
  {
    fingerprint,
    signal,
    exportIdentity,
  }: { fingerprint: string; signal: AbortSignal; exportIdentity?: BrokerExportIdentity },
): Promise<BrokerAdmissionInput> {
  const device: SessionDeviceRequirement = config.device;
  if (device.platform !== "watchos") {
    throw new ActionableError("Watch admission requires a watchOS session request");
  }
  const catalog = await options.catalog("watchos", signal);
  if (catalog.platform !== "watchos") {
    throw new ActionableError(
      "The session broker's watch catalog reader returned another platform",
    );
  }
  const requirement = unwrap(normalizeWatchSessionDeviceRequirement(device, catalog));
  return {
    requestId: config.requestId,
    fingerprint,
    parameters: config,
    owner: options.owner,
    export: exportIdentity,
    limits: options.limits,
    matches: (profile) =>
      matchWatchSessionDevice(requirement, poolProfile(profile)).kind === "match",
    // Stored like an iOS/Android resolution: the exact profile under `profile`, beside its request.
    resolveCreation: () => ({ platform: "watchos", requirement, profile: requirement.profile }),
  };
}

/**
 * A ready watch session's readiness: booted, reported with provisionDevice's watch values. Android
 * and iOS receipts carry no readiness field, so their shape is unchanged.
 */
export function sessionReadiness(
  active: boolean,
  resource: Pick<BrokerResourceRecord, "profile"> | undefined,
): { readiness?: SessionBrokerReadiness } {
  return active && resource && nativeProfile(resource).platform === "watchos"
    ? { readiness: { ...WATCH_BOOTED_READINESS } }
    : {};
}
