import type {
  DeviceAwareToolHandler,
  DeviceAwareToolRegistration,
} from "../../src/server/toolRegistry";

/** The handler a `registerDeviceAware` call passed: a bare handler or `{ handler, ...options }`. */
export function deviceAwareHandler<T>(
  registration: DeviceAwareToolHandler<T> | DeviceAwareToolRegistration<T>,
): DeviceAwareToolHandler<T> {
  return typeof registration === "function" ? registration : registration.handler;
}
