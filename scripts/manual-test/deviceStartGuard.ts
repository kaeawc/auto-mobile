export const DEVICE_START_TOOLS: readonly string[] = [
  "startDevice",
  "provisionDevice",
  "getAndroid",
  "getApple",
];
export const ALLOW_SELECTOR_FLAG = "--allow-selector";
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Field list pinned to startDeviceParametersSchema/getAndroidSchema/getAppleSchema/provisionDeviceSchema
 * in src/server/deviceTools.ts; importing that module would register the device tools. */
export function deviceStartGuardRefusal(
  tool: string,
  args: unknown,
  options: { allowSelector: boolean },
): string | undefined {
  if (!DEVICE_START_TOOLS.includes(tool)) {
    return undefined;
  }
  const values = object(args);
  if (!values) {
    return `${tool} requires object arguments naming an explicit device; ${ALLOW_SELECTOR_FLAG} only permits object selectors.`;
  }
  if (options.allowSelector) {
    return undefined;
  }
  const device = object(values.device);
  // Match startDeviceSchema preprocessing exactly: top-level keys override legacy device keys.
  const merged = { ...device, ...values };
  const names =
    tool === "startDevice"
      ? [merged.avdName, merged.deviceId]
      : tool === "getAndroid"
        ? [values.avdName, values.deviceId]
        : tool === "getApple"
          ? [values.udid, values.deviceId]
          : [device?.name, device?.deviceId];
  if (names.some((value) => typeof value === "string" && value.trim().length > 0)) {
    return undefined;
  }
  const identifier =
    tool === "startDevice" || tool === "getAndroid"
      ? "avdName (Android) or deviceId (UDID/serial)"
      : tool === "getApple"
        ? "udid or deviceId"
        : "device.name or device.deviceId";
  return `${tool} requires ${identifier}. A selector-only start booted a protected AVD in batch 20261012a; pass ${ALLOW_SELECTOR_FLAG} only to allow that selection deliberately.`;
}
