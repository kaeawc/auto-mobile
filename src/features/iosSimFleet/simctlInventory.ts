import type { SimulatorInventoryEntry } from "./types";
import { parseSimctlDeviceList } from "../../utils/ios-cmdline-tools/simctlDeviceList";
import type { AppleDevice } from "../../utils/ios-cmdline-tools/SimCtlClient";

/** Read-only simctl args for the device inventory including data sizes. */
export const SIMCTL_LIST_DEVICES_ARGS = ["list", "devices", "--json"];

/**
 * Projects `simctl list devices --json` (parsed by the shared SimCtl reader) into
 * fleet inventory entries; throws on malformed JSON so callers report the failure.
 */
export function parseSimctlInventory(stdout: string): SimulatorInventoryEntry[] {
  const devices = parseSimctlDeviceList(stdout).devices as unknown;
  if (devices === null || typeof devices !== "object") {
    throw new Error("simctl list output has no devices map");
  }
  return Object.entries(devices as Record<string, AppleDevice[] | null>).flatMap(
    ([runtime, list]) => (Array.isArray(list) ? list : []).flatMap((raw) => toEntry(runtime, raw)),
  );
}

function toEntry(runtime: string, raw: Partial<AppleDevice>): SimulatorInventoryEntry[] {
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
