import { ProvisionDeviceError } from "../../../devices/exactDeviceProvisioning";
import type { DeviceInfo } from "../../../models/index";
import type { BindingProvisionRequest, BindingResolvedSpec } from "./reconcilerContracts";

/**
 * provisionDevice arguments for a broker watch binding (#15882). The watch path adopts the exact
 * watch (name, UDID when reused, runtime, device type) or creates it fresh with `simctl create`,
 * never cloning and never pairing, then boots it through the simulator boot admission and binds a
 * session at readiness `booted`. Readiness `"none"` is the only one watchOS takes: it has no
 * automation runner, and no resources, tool grants or snapshot options apply.
 */
export function watchProvisionToolArgs(
  request: BindingProvisionRequest,
  timeoutMs: number,
): Record<string, unknown> {
  const { runtime, deviceType } = request.spec;
  if (deviceType === undefined) {
    // A watch spec always names its device type (watchBindingSpecSchema); the resolver refuses
    // one that does not before anything reaches here.
    throw new ProvisionDeviceError(
      "unsupported",
      `Apple Watch binding '${request.name}' has no device type to provision.`,
    );
  }
  return {
    device: {
      platform: "watchos",
      name: request.name,
      ...(request.deviceId ? { deviceId: request.deviceId } : {}),
      spec: { runtime, deviceType },
    },
    boot: true,
    readiness: "none",
    timeoutMs,
  };
}

/** A listed watch's own runtime and device type; null when the listing does not say. */
export function readExistingWatchSpec(device: DeviceInfo): BindingResolvedSpec | null {
  if (device.isAvailable === false || !device.runtime || !device.deviceType) {
    return null;
  }
  return { runtime: device.runtime, deviceType: device.deviceType, displayCutout: "unknown" };
}
