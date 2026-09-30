import type { DeviceDisplays, DisplayPanel, PanelRole, Posture } from "../../models/DisplayPanel";
import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";

/** Parse physical IDs as strings: JavaScript numbers cannot represent them exactly. */
export function parsePhysicalDisplayIds(output: string): Set<string> {
  const ids = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^Display (\d+) \(HWC display \d+\):/.exec(line.trim());
    if (match) {
      ids.add(match[1]);
    }
  }
  return ids;
}

interface AndroidDisplayRecord {
  key: string;
  type: "INTERNAL" | "EXTERNAL" | "VIRTUAL";
  sizePx: DisplayPanel["sizePx"];
}

/** Read each DisplayInfo record's named fields, never its changing logical display id. */
export function parseAndroidDisplayInfos(output: string): AndroidDisplayRecord[] {
  const records: AndroidDisplayRecord[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("DisplayInfo{")) {
      continue;
    }
    const id = /\buniqueId "(?:local|external|virtual):([^\"]+)"/.exec(line);
    const type = /\btype (INTERNAL|EXTERNAL|VIRTUAL)\b/.exec(line)?.[1];
    const size = /\breal (\d+) x (\d+)\b/.exec(line);
    if (!id || !size || (type !== "INTERNAL" && type !== "EXTERNAL" && type !== "VIRTUAL")) {
      continue;
    }
    records.push({
      key: id[1],
      type,
      sizePx: { width: Number(size[1]), height: Number(size[2]) },
    });
  }
  return records;
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

export function parseAndroidPostures(output: string): Posture[] {
  const postures = new Set<Posture>();
  for (const line of output.split(/\r?\n/)) {
    const name = /\bDeviceState\{[^}\n]*\bname='([^']+)'/.exec(line)?.[1];
    if (name) {
      postures.add(STATE_POSTURES[name] ?? "unknown");
    }
  }
  return postures.size ? [...postures] : ["unknown"];
}

/** Join SurfaceFlinger physical IDs to display service sizes and types. */
export function parseAndroidDeviceDisplays(
  physicalIdsOutput: string,
  displayInfosOutput: string,
  statesOutput: string,
): DeviceDisplays | undefined {
  const ids = parsePhysicalDisplayIds(physicalIdsOutput);
  const records = parseAndroidDisplayInfos(displayInfosOutput).filter((record) =>
    ids.has(record.key),
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
