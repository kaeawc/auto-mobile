import type { SimulatorInventoryEntry } from "./types";

/** Read-only argv (after `xcrun`) for the device inventory including data sizes. */
export const SIMCTL_LIST_DEVICES_ARGS = ["simctl", "list", "devices", "-j"];

interface RawDevice {
  udid?: unknown;
  name?: unknown;
  state?: unknown;
  isAvailable?: unknown;
  deviceTypeIdentifier?: unknown;
  dataPathSize?: unknown;
}

/** Parses `simctl list devices -j`; throws on malformed JSON so callers report the failure. */
export function parseSimctlInventory(stdout: string): SimulatorInventoryEntry[] {
  const parsed = JSON.parse(stdout) as { devices?: Record<string, RawDevice[]> | null };
  const devices = parsed.devices;
  if (devices === null || typeof devices !== "object") {
    throw new Error("simctl list output has no devices map");
  }
  return Object.entries(devices).flatMap(([runtime, list]) =>
    (Array.isArray(list) ? list : []).flatMap((raw) => toEntry(runtime, raw)),
  );
}

function toEntry(runtime: string, raw: RawDevice): SimulatorInventoryEntry[] {
  if (typeof raw.udid !== "string" || typeof raw.state !== "string") {
    return [];
  }
  return [
    {
      udid: raw.udid,
      name: typeof raw.name === "string" ? raw.name : raw.udid,
      state: raw.state,
      runtime,
      deviceTypeIdentifier:
        typeof raw.deviceTypeIdentifier === "string" ? raw.deviceTypeIdentifier : undefined,
      dataPathSizeBytes: typeof raw.dataPathSize === "number" ? raw.dataPathSize : undefined,
      isAvailable: raw.isAvailable !== false,
    },
  ];
}
