import type { SessionBrokerOptions } from "./brokerOptions";
import type { SessionConfig } from "../../devices/sessionConfig";
import type { BrokerAdmissionInput, BrokerExportIdentity } from "./store";
import { poolMatcher } from "./brokerPoolMatch";
import { watchAdmissionInput } from "./watchAdmission";
import { unwrap } from "./devicePort";
import { assertDeviceProfileEmulatable, requestedDeviceProfile } from "./deviceProfile";
import {
  normalizeSessionDeviceRequirement,
  resolveSessionDeviceProfile,
} from "../../devices/sessionRequirements";

export async function brokerAdmissionInput(
  options: SessionBrokerOptions,
  config: SessionConfig,
  {
    fingerprint,
    signal,
    exportIdentity,
  }: {
    fingerprint: string;
    signal: AbortSignal;
    exportIdentity?: BrokerExportIdentity;
  },
): Promise<BrokerAdmissionInput> {
  signal.throwIfAborted();
  if (config.device.platform === "watchos") {
    return watchAdmissionInput(options, config, { fingerprint, signal, exportIdentity });
  }
  const catalog = await options.catalog(config.device.platform, signal);
  const defaults = options.defaults(config.device.platform);
  const capabilities = options.capabilities ?? {};
  const requirement = unwrap(
    normalizeSessionDeviceRequirement(config.device, defaults, catalog, capabilities),
  );
  assertDeviceProfileEmulatable(requestedDeviceProfile(config));
  return {
    requestId: config.requestId,
    fingerprint,
    parameters: config,
    owner: options.owner,
    export: exportIdentity,
    limits: options.limits,
    matches: poolMatcher(requirement, defaults),
    resolveCreation: () =>
      unwrap(resolveSessionDeviceProfile(requirement, defaults, catalog, capabilities)),
  };
}
