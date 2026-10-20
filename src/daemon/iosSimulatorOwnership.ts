import type { IosSimulatorOwnershipReader } from "../features/iosSimFleet/CapacityGate";
import type { SessionManager } from "./sessionManager";
import type { BindingExclusion } from "./sessionBroker/provisioning/exclusion";

/** Reuses the broker's read-only snapshot of bindings, journals and managed devices. */
export function createIosSimulatorOwnershipReader(
  bindings: Pick<BindingExclusion, "refresh" | "stableIdsFor">,
  sessions: () => Pick<SessionManager, "getAssignedDevices"> | undefined,
): IosSimulatorOwnershipReader {
  return {
    refresh: () => bindings.refresh({ fresh: true, requireCurrent: true }),
    isAutoMobileOwned: (udid) =>
      bindings.stableIdsFor("ios").has(udid) ||
      (sessions()?.getAssignedDevices().has(udid) ?? false),
  };
}
