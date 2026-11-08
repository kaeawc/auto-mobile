import { DUMPSYS_MAX_BUFFER } from "./dumpsysLimits";
import type { DeviceDisplays, DisplayPanel, PanelRole, Posture } from "../../models/DisplayPanel";
import type { DisplayInventoryOutcome } from "../../models/DeviceInfo";
import type { AdbCommandRunner } from "./interfaces/AdbExecutor";
import { logger } from "../logger";
import { errorMessage } from "../describeUnknownError";
import { BUILD_CHARACTERISTICS_PROP, parseTraitFormFactor } from "./deviceTraits";
import {
  parseSurfaceFlingerDisplayIds,
  virtualDisplayKey,
  virtualDisplayOwnerPackage,
} from "./AndroidDisplayParsers";

interface AndroidDisplayRecord {
  key: string;
  type: "INTERNAL" | "EXTERNAL" | "VIRTUAL" | "OVERLAY";
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
    case "OVERLAY":
      return value;
    default:
      return undefined;
  }
}

/**
 * Overlay displays keep their whole `overlay:<n>` id, app-created virtual displays key as
 * `virtual:<package>:<name>`, and physical panels key by the bare id.
 */
function displayRecordKey(
  type: AndroidDisplayRecord["type"] | undefined,
  uniqueId: string,
): string | undefined {
  if (type === "OVERLAY") {
    return /^overlay:.+$/.exec(uniqueId)?.[0];
  }
  return (
    (type === "VIRTUAL" ? virtualDisplayKey(uniqueId) : undefined) ??
    /^(?:local|external|virtual):(.+)$/.exec(uniqueId)?.[1]
  );
}

/**
 * Owners of AutoMobile's own virtual displays. The video server runs under `app_process` as the
 * shell uid, so its recording display is owned by `com.android.shell`; listing it would change the
 * inventory, and every inventory-keyed cache, each time a recording starts or stops.
 */
const SELF_OWNED_VIRTUAL_DISPLAY_PACKAGES: readonly string[] = ["com.android.shell"];
const SELF_OWNED_VIRTUAL_DISPLAY_PACKAGE_PREFIX = "dev.jasonpearson.automobile";

function isSelfOwnedVirtualDisplay(key: string): boolean {
  const owner = virtualDisplayOwnerPackage(key);
  return (
    owner !== undefined &&
    (SELF_OWNED_VIRTUAL_DISPLAY_PACKAGES.includes(owner) ||
      owner === SELF_OWNED_VIRTUAL_DISPLAY_PACKAGE_PREFIX ||
      owner.startsWith(`${SELF_OWNED_VIRTUAL_DISPLAY_PACKAGE_PREFIX}.`))
  );
}

/**
 * App-created virtual displays that tools may target. AutoMobile's own displays are left out, and
 * so is any key two live displays share (one app showing two same-named displays), because a key
 * that names two displays cannot target either.
 */
function addressableVirtualRecords(
  records: readonly AndroidDisplayRecord[],
): AndroidDisplayRecord[] {
  const virtuals = records.filter(
    (record) =>
      record.type === "VIRTUAL" &&
      record.key.startsWith("virtual:") &&
      !isSelfOwnedVirtualDisplay(record.key),
  );
  const counts = new Map<string, number>();
  for (const record of virtuals) {
    counts.set(record.key, (counts.get(record.key) ?? 0) + 1);
  }
  return virtuals.filter((record) => counts.get(record.key) === 1);
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
  const key = displayRecordKey(type, uniqueId ?? "");
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

/**
 * Split display-service records into SurfaceFlinger-backed physical panels and addressable
 * non-panel displays. Overlay displays (`settings put global overlay_display_devices ...`) and
 * app-created virtual displays (`DisplayManager.createVirtualDisplay`) have no SurfaceFlinger
 * physical id; they are kept so tools can address them by their `overlay:<n>` or
 * `virtual:<package>:<name>` key.
 */
function partitionDisplayRecords(
  physicalIdsOutput: string,
  displayDeviceInfosOutput: string,
): {
  physical: AndroidDisplayRecord[];
  overlays: AndroidDisplayRecord[];
  virtuals: AndroidDisplayRecord[];
} {
  const ids = parseSurfaceFlingerDisplayIds(physicalIdsOutput);
  const records = parseAndroidDisplayDeviceInfos(displayDeviceInfosOutput);
  return {
    physical: records.filter((record) => record.type !== "OVERLAY" && ids.has(record.key)),
    overlays: records.filter((record) => record.type === "OVERLAY"),
    virtuals: addressableVirtualRecords(records),
  };
}

/** Join SurfaceFlinger physical IDs to display service physical-panel records, then overlays. */
/** Inventory parse options that the display dumps alone cannot establish. */
export interface AndroidDisplayParseOptions {
  /** The device positively announced an automotive build (`ro.build.characteristics`). */
  automotive?: boolean;
}

/**
 * Role of each physical record. On a handheld, two differently sized built-in panels are a
 * foldable's inner and cover panels. On a car they are the center display and the instrument
 * cluster: the first largest built-in panel keeps `inner`, every other built-in one is `cluster`.
 */
function physicalPanelRoles(
  records: readonly AndroidDisplayRecord[],
  automotive: boolean,
): PanelRole[] {
  const internal = records.filter((record) => record.type === "INTERNAL");
  const area = (record: AndroidDisplayRecord) => record.sizePx.width * record.sizePx.height;
  const areas = internal.map(area);
  const largest = Math.max(...areas);
  const smallest = Math.min(...areas);
  const primary = internal.find((record) => area(record) === largest);
  return records.map((record) => {
    if (record.type !== "INTERNAL") {
      return "external";
    }
    if (automotive && internal.length > 1) {
      return record === primary ? "inner" : "cluster";
    }
    if (internal.length > 1 && largest > smallest) {
      return area(record) === largest ? "inner" : area(record) === smallest ? "cover" : "unknown";
    }
    return "unknown";
  });
}

export function parseAndroidDeviceDisplays(
  physicalIdsOutput: string,
  displayDeviceInfosOutput: string,
  statesOutput: string,
  options: AndroidDisplayParseOptions = {},
): DeviceDisplays | undefined {
  const {
    physical: records,
    overlays,
    virtuals,
  } = partitionDisplayRecords(physicalIdsOutput, displayDeviceInfosOutput);
  // Single-screen devices without an overlay or virtual display retain their pre-existing
  // inventory JSON shape; those alone (no readable physical panel) cannot establish an inventory.
  if (records.length === 0 || records.length + overlays.length + virtuals.length < 2) {
    return undefined;
  }
  const automotive = options.automotive === true;
  const roles = physicalPanelRoles(records, automotive);
  const panels: DisplayPanel[] = records.map((record, index) => ({
    key: record.key,
    role: roles[index],
    sizePx: record.sizePx,
  }));
  // Physical panels come first so inventory-order fallbacks never land on an overlay or virtual
  // display.
  const nonPanel = (role: PanelRole) => (record: AndroidDisplayRecord) => ({
    key: record.key,
    role,
    sizePx: record.sizePx,
  });
  return {
    panels: [...panels, ...overlays.map(nonPanel("overlay")), ...virtuals.map(nonPanel("virtual"))],
    postures: automotive ? carPostures(statesOutput) : parseAndroidPostures(statesOutput),
  };
}

/**
 * A car reports no fold posture; the `unknown` placeholder a handheld inventory carries would
 * otherwise read as posture support and offer setPosture as a remedy.
 */
function carPostures(statesOutput: string): Posture[] {
  return parseAndroidPostures(statesOutput).filter((posture) => posture !== "unknown");
}

/** Distinguish a proven single panel from a failed physical-display join. */
export function parseAndroidDeviceDisplayOutcome(
  physicalIdsOutput: string,
  displayDeviceInfosOutput: string,
  statesOutput: string,
): DisplayInventoryOutcome {
  const {
    physical: matched,
    overlays,
    virtuals,
  } = partitionDisplayRecords(physicalIdsOutput, displayDeviceInfosOutput);
  if (matched.length === 0) {
    return { kind: "unreadable", reason: "no matched physical display records" };
  }
  if (matched.length === 1 && overlays.length === 0 && virtuals.length === 0) {
    return { kind: "single" };
  }
  // The existing parser owns panel roles and posture extraction.
  return parseAndroidDeviceDisplays(physicalIdsOutput, displayDeviceInfosOutput, statesOutput)
    ? { kind: "multi" }
    : { kind: "unreadable", reason: "physical display records could not be parsed" };
}

/**
 * Only an inventory with two or more built-in panels and no fold posture can be a car's center
 * display plus instrument cluster, so phones and foldables never pay for the build probe.
 */
function mayBeCarDisplays(displays: DeviceDisplays | undefined): boolean {
  const builtIn = displays?.panels.filter(
    (panel) => panel.role === "inner" || panel.role === "cover" || panel.role === "unknown",
  );
  return (
    (builtIn?.length ?? 0) > 1 &&
    displays?.postures.every((posture) => posture === "unknown") === true
  );
}

async function readsAsAutomotive(adb: AdbCommandRunner, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await adb.executeCommand(`shell getprop ${BUILD_CHARACTERISTICS_PROP}`, {
      timeoutMs: 2000,
      noRetry: true,
      signal,
    });
    signal?.throwIfAborted();
    return parseTraitFormFactor(result.stdout) === "automotive";
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    // The build class is advisory: an unreadable prop keeps today's handheld classification.
    logger.warn(
      `Android build characteristics unavailable for display roles: ${errorMessage(error)}`,
    );
    return false;
  }
}

/** Optional, bounded inventory enrichment through the device-bound ADB seam. */
export async function readAndroidDeviceDisplays(
  adb: AdbCommandRunner,
  signal?: AbortSignal,
): Promise<DeviceDisplays | undefined> {
  return (await readAndroidDeviceDisplaysChecked(adb, signal)).displays;
}

export async function readAndroidDeviceDisplaysChecked(
  adb: AdbCommandRunner,
  signal?: AbortSignal,
): Promise<{ displays?: DeviceDisplays; degraded: boolean; outcome: DisplayInventoryOutcome }> {
  const commands = [
    "shell dumpsys SurfaceFlinger --display-id",
    "shell dumpsys display",
    "shell cmd device_state print-states",
  ] as const;
  const results = await Promise.allSettled(
    commands.map((command) =>
      adb.executeCommand(command, {
        timeoutMs: 2000,
        maxBuffer: command.startsWith("shell dumpsys ") ? DUMPSYS_MAX_BUFFER : undefined,
        noRetry: true,
        signal,
      }),
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
  const handheld =
    outcome.kind === "multi"
      ? parseAndroidDeviceDisplays(output(0), output(1), output(2))
      : undefined;
  const automotive = mayBeCarDisplays(handheld) && (await readsAsAutomotive(adb, signal));
  return {
    displays: automotive
      ? parseAndroidDeviceDisplays(output(0), output(1), output(2), { automotive })
      : handheld,
    degraded: results[0].status === "rejected" || results[1].status === "rejected",
    outcome,
  };
}
