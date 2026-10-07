import { DUMPSYS_MAX_BUFFER } from "./dumpsysLimits";
import type { DeviceDisplays, DisplayPanel, PanelRole, Posture } from "../../models/DisplayPanel";
import type { DisplayInventoryOutcome } from "../../models/DeviceInfo";
import type { AdbExecutor } from "./interfaces/AdbExecutor";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";
import { parseSurfaceFlingerDisplayIds } from "./AndroidDisplayParsers";

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

function splitDisplayDeviceFields(line: string, start: number): string[] {
  const fields: string[] = [];
  let fieldStart = start;
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < line.length; index++) {
    const character = line[index];
    if (quote !== undefined) {
      quote = isUnescapedQuoteEnd(character, line[index - 1], quote) ? undefined : quote;
      continue;
    }
    if (isQuote(character)) {
      quote = character;
      continue;
    }
    if (character === "}" && depth === 0) {
      fields.push(line.slice(fieldStart, index));
      break;
    }
    depth += delimiterDepthChange(character);
    if (character === "," && depth === 0) {
      fields.push(line.slice(fieldStart, index));
      fieldStart = index + 1;
    }
  }
  return fields;
}

function isQuote(character: string): boolean {
  return character === '"' || character === "'";
}

function isUnescapedQuoteEnd(
  character: string,
  previous: string | undefined,
  quote: string,
): boolean {
  return character === quote && previous !== "\\";
}

function delimiterDepthChange(character: string): number {
  switch (character) {
    case "{":
    case "[":
    case "(":
      return 1;
    case "}":
    case "]":
    case ")":
      return -1;
    default:
      return 0;
  }
}

function parseDisplayType(value: string | undefined): AndroidDisplayRecord["type"] | undefined {
  switch (value) {
    case "INTERNAL":
    case "EXTERNAL":
    case "VIRTUAL":
      return value;
    default:
      return undefined;
  }
}

function parseAndroidDisplayDeviceInfo(line: string): AndroidDisplayRecord | undefined {
  const marker = line.indexOf("DisplayDeviceInfo{");
  if (marker < 0) {
    return undefined;
  }
  const start = marker + "DisplayDeviceInfo{".length;
  const fields = splitDisplayDeviceFields(line, start).map((field) => field.trim());
  // API 36 separates the quoted display name from the fields with a colon,
  // while older output (and some vendors) use a comma. Keep splitting only at
  // top-level commas, then anchor on the structured uniqueId token so either
  // separator works and punctuation inside the quoted name is ignored.
  const uniqueId = fields
    .map((field) => /(?:^|\s)uniqueId="([^"]+)"/.exec(field)?.[1])
    .find((value): value is string => value !== undefined);
  const type = parseDisplayType(fields.find((field) => field.startsWith("type "))?.slice(5));
  const dimensions = /^(\d+)\s+x\s+(\d+)$/.exec(
    fields.find((field) => /^(\d+)\s+x\s+(\d+)$/.test(field)) ?? "",
  );
  const sizePx = dimensions
    ? { width: Number(dimensions[1]), height: Number(dimensions[2]) }
    : undefined;
  const key = /^(?:local|external|virtual):(.+)$/.exec(uniqueId ?? "")?.[1];
  return key && type && sizePx ? { key, type, sizePx } : undefined;
}

/** Read DisplayDeviceInfo records' structured top-level fields. */
function parseAndroidDisplayDeviceInfos(output: string): AndroidDisplayRecord[] {
  return output
    .split(/\r?\n/)
    .map(parseAndroidDisplayDeviceInfo)
    .filter((record): record is AndroidDisplayRecord => record !== undefined);
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

/** Read the committed identifier from `state` or the numeric `print-state` output. */
export function parseAndroidCommittedStateIdentifier(output: string): number | undefined {
  const trimmed = output.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const committed = output
    .split(/\r?\n/)
    .find((line) => line.trimStart().startsWith("Committed state:"));
  return committed === undefined ? undefined : parseAndroidDeviceStates(committed)[0]?.identifier;
}

export function parseAndroidPostures(output: string): Posture[] {
  const postures = new Set(parseAndroidDeviceStates(output).map((state) => state.posture));
  return postures.size ? [...postures] : ["unknown"];
}

/** Join SurfaceFlinger physical IDs to display service physical-panel records. */
export function parseAndroidDeviceDisplays(
  physicalIdsOutput: string,
  displayDeviceInfosOutput: string,
  statesOutput: string,
): DeviceDisplays | undefined {
  const ids = parseSurfaceFlingerDisplayIds(physicalIdsOutput);
  const records = parseAndroidDisplayDeviceInfos(displayDeviceInfosOutput).filter((record) =>
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

/** Distinguish a proven single panel from a failed physical-display join. */
export function parseAndroidDeviceDisplayOutcome(
  physicalIdsOutput: string,
  displayDeviceInfosOutput: string,
  statesOutput: string,
): DisplayInventoryOutcome {
  const ids = parseSurfaceFlingerDisplayIds(physicalIdsOutput);
  const matched = parseAndroidDisplayDeviceInfos(displayDeviceInfosOutput).filter((record) =>
    ids.has(record.key),
  );
  if (matched.length === 0) {
    return { kind: "unreadable", reason: "no matched physical display records" };
  }
  if (matched.length === 1) {
    return { kind: "single" };
  }
  // The existing parser owns panel roles and posture extraction.
  return parseAndroidDeviceDisplays(physicalIdsOutput, displayDeviceInfosOutput, statesOutput)
    ? { kind: "multi" }
    : { kind: "unreadable", reason: "physical display records could not be parsed" };
}

/** Optional, bounded inventory enrichment through the device-bound ADB seam. */
export async function readAndroidDeviceDisplays(
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
): Promise<DeviceDisplays | undefined> {
  return (await readAndroidDeviceDisplaysChecked(adb, signal)).displays;
}

export async function readAndroidDeviceDisplaysChecked(
  adb: Pick<AdbExecutor, "executeCommand">,
  signal?: AbortSignal,
): Promise<{ displays?: DeviceDisplays; degraded: boolean; outcome: DisplayInventoryOutcome }> {
  const commands = [
    "shell dumpsys SurfaceFlinger --display-id",
    "shell dumpsys display",
    "shell cmd device_state print-states",
  ] as const;
  const results = await Promise.allSettled(
    commands.map((command) =>
      adb.executeCommand(
        command,
        2000,
        command.startsWith("shell dumpsys ") ? DUMPSYS_MAX_BUFFER : undefined,
        true,
        signal,
      ),
    ),
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
  const failedCommand = results.findIndex(
    (result, index) => index < 2 && result.status === "rejected",
  );
  const failedResult = results[failedCommand];
  const outcome =
    failedResult?.status === "rejected"
      ? {
          kind: "unreadable" as const,
          reason: `${commands[failedCommand]} failed: ${errorMessage(failedResult.reason)}`,
        }
      : parseAndroidDeviceDisplayOutcome(output(0), output(1), output(2));
  if (outcome.kind === "unreadable") {
    logger.warn(`Android display inventory could not be read: ${outcome.reason}`);
  }
  return {
    displays:
      outcome.kind === "multi"
        ? parseAndroidDeviceDisplays(output(0), output(1), output(2))
        : undefined,
    degraded: results[0].status === "rejected" || results[1].status === "rejected",
    outcome,
  };
}
