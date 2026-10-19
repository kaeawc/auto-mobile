import type { Hierarchy, ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import type { ViewHierarchyAndroidCtrlProxy } from "./android/ViewHierarchyAndroidCtrlProxy";

type TransportFailureFields = () => Pick<Hierarchy, "unavailableReason" | "unavailableDetail">;

/** Annotate the prepared response without replacing its hierarchy or capture metadata. */
export function annotateAndroidHierarchyAvailability(
  prepared: ViewHierarchyResult,
  transportFailureFields: TransportFailureFields,
): ViewHierarchyResult {
  if (prepared.hierarchy.transportFailure) {
    Object.assign(prepared.hierarchy, transportFailureFields());
  } else if (prepared.ctrlProxyIncomplete && !prepared.hierarchy.node) {
    prepared.hierarchy.unavailableReason = "incomplete_capture";
  }
  return prepared;
}

export function androidNullHierarchyFailure(
  error: string,
  client: Pick<ViewHierarchyAndroidCtrlProxy, "isConnected" | "isRecoveryInFlight">,
  transportFailureFields: TransportFailureFields,
  signal?: AbortSignal,
): Hierarchy {
  // A confirmed keyguard block is a device state, so rebind cannot repair it.
  const deviceLocked = error.startsWith("Device is locked;");
  const transportFailure = !signal?.aborted && !deviceLocked && client.isConnected?.() === false;
  const hierarchy: Hierarchy = {
    error,
    ...(transportFailure ? { transportFailure: true } : {}),
  };
  if (signal?.aborted) {
    return hierarchy;
  }
  if (deviceLocked) {
    hierarchy.unavailableReason = "device_locked";
  } else if (transportFailure || client.isRecoveryInFlight?.()) {
    Object.assign(hierarchy, transportFailureFields());
  } else {
    hierarchy.unavailableReason = "unknown";
  }
  return hierarchy;
}
