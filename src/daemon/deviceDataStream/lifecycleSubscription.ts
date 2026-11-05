/** The frames a lifecycle-only subscription receives (see `DeviceDataFilter.lifecycleOnly`). */
export const LIFECYCLE_FRAME_TYPES: ReadonlySet<string> = new Set([
  "device_session_started",
  "device_session_ended",
]);

/** Validate the subscribe request's optional `lifecycleOnly` flag. */
export function parseLifecycleOnly(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new Error("lifecycleOnly must be a boolean");
  }
  return value;
}
