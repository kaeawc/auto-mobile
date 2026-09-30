import type { DeviceDisplays, DisplayPanel, PanelRole, Posture } from "../../models/DisplayPanel";
import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";
import { parseAndroidDisplayInfos, parseSurfaceFlingerDisplayIds } from "./AndroidDisplayParsers";

interface AndroidDisplayRecord {
  key: string;
  type: "INTERNAL" | "EXTERNAL" | "VIRTUAL";
  sizePx: DisplayPanel["sizePx"];
}

const STATE_POSTURES: Record<string, Posture> = {
  CLOSED: "closed",
  CLOSE: "closed",
  HALF_OPENED: "half_opened",
  HALF_FOLDED: "half_opened",
  OPENED: "opened",
  OPEN: "opened",
  FLAT: "opened",
  REAR_DISPLAY_STATE: "rear_display",
  REAR_DISPLAY_MODE: "rear_display",
  FLIPPED: "flipped",
  TENT: "tent",
};

export interface AndroidDeviceState {
  identifier: number;
  name: string;
  posture: Posture;
}

/** Parse the DeviceState rows printed by `cmd device_state print-states`. */
export function parseAndroidDeviceStates(output: string): AndroidDeviceState[] {
  const states: AndroidDeviceState[] = [];
  for (const line of output.split(/\r?\n/)) {
    const rowStart = line.indexOf("DeviceState{");
    const rowEnd = line.indexOf("}", rowStart);
    if (rowStart < 0 || rowEnd < 0) {
      continue;
    }
    const fields = new Map<string, string>();
    for (const field of line.slice(rowStart + "DeviceState{".length, rowEnd).split(",")) {
      const separator = field.indexOf("=");
      if (separator < 0) {
        continue;
      }
      const key = field.slice(0, separator).trim();
      const rawValue = field.slice(separator + 1).trim();
      const value =
        rawValue.startsWith("'") && rawValue.endsWith("'") ? rawValue.slice(1, -1) : rawValue;
      fields.set(key, value);
    }
    const identifier = Number(fields.get("identifier"));
    const name = fields.get("name");
    if (!Number.isInteger(identifier) || !name) {
      continue;
    }
    states.push({ identifier, name, posture: STATE_POSTURES[name] ?? "unknown" });
  }
  return states;
}

export function parseAndroidPostures(output: string): Posture[] {
  const postures = new Set(parseAndroidDeviceStates(output).map((state) => state.posture));
  return postures.size ? [...postures] : ["unknown"];
}

/** Join SurfaceFlinger physical IDs to display service sizes and types. */
export function parseAndroidDeviceDisplays(
  physicalIdsOutput: string,
  displayInfosOutput: string,
  statesOutput: string,
): DeviceDisplays | undefined {
  const ids = parseSurfaceFlingerDisplayIds(physicalIdsOutput);
  const records: AndroidDisplayRecord[] = parseAndroidDisplayInfos(displayInfosOutput).flatMap(
    (record) => {
      const key = /^(?:local|external|virtual):(.+)$/.exec(record.uniqueId ?? "")?.[1];
      if (!record.hasDisplayInfo || !key || !record.sizePx || !record.type || !ids.has(key)) {
        return [];
      }
      return [{ key, type: record.type, sizePx: record.sizePx }];
    },
  );
  // Single-screen devices retain their pre-existing inventory JSON shape.
  if (records.length < 2) {
    return undefined;
  }
  const internal = records.filter((record) => record.type === "INTERNAL");
  const areas = internal.map((record) => record.sizePx.width * record.sizePx.height);
  const largest = Math.max(...areas);
  const smallest = Math.min(...areas);
  const panels: DisplayPanel[] = records.map((record) => {
    let role: PanelRole = "unknown";
    if (record.type !== "INTERNAL") {
      role = "external";
    } else if (internal.length > 1 && largest > smallest) {
      const area = record.sizePx.width * record.sizePx.height;
      role = area === largest ? "inner" : area === smallest ? "cover" : "unknown";
    }
    return { key: record.key, role, sizePx: record.sizePx };
  });
  return { panels, postures: parseAndroidPostures(statesOutput) };
}

/** Optional, bounded inventory enrichment through the device-bound ADB seam. */
export async function readAndroidDeviceDisplays(
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
): Promise<DeviceDisplays | undefined> {
  const commands = [
    "shell dumpsys SurfaceFlinger --display-id",
    "shell cmd display get-displays",
    "shell cmd device_state print-states",
  ] as const;
  const results = await Promise.allSettled(
    commands.map((command) => adb.executeCommand(command, 2000, undefined, true, signal)),
  );
  signal?.throwIfAborted();
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      // Display metadata is optional; older devices may lack these shell commands.
      logger.debug(
        `Android display inventory '${commands[index]}' unavailable: ${errorMessage(result.reason)}`,
      );
    }
  }
  const output = (index: number): string =>
    results[index].status === "fulfilled" ? results[index].value.stdout : "";
  return parseAndroidDeviceDisplays(output(0), output(1), output(2));
}
