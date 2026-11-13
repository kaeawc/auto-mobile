import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { DesktopHeadUnitConsole } from "./DesktopHeadUnit";
import { HEAD_UNIT_DISPLAY } from "./HeadUnitInteraction";

/**
 * The head unit a phone projects to, as `listDevices` reports it (#17840). It is not one of the
 * phone's `displays.panels`: those are the phone's own screens, which posture, `display: "all"` and
 * the session pin choose between. The head unit is addressed only by `display: "headUnit"`.
 */
export interface HeadUnitInventoryEntry {
  /** The `display` value `tapAt` and `pressButton` take to act on this head unit. */
  display: typeof HEAD_UNIT_DISPLAY;
  role: "projected";
  projectedBy: "androidAuto";
  /** The DHU process whose console the daemon owns; it changes when the DHU is restarted. */
  console: string;
  configPath?: string;
  /** Head-unit pixels from the config. Absent when the config could not be read. */
  sizePx?: { width: number; height: number };
}

/** Size the DHU uses when its config sets no resolution (the same as `default.ini`). */
export const DHU_DEFAULT_SIZE_PX = { width: 800, height: 480 } as const;

/** The `NNNp` resolution names the DHU accepts, in landscape head-unit pixels. */
const NAMED_RESOLUTIONS: Readonly<Record<string, { width: number; height: number }>> = {
  "480p": { width: 800, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
  "2160p": { width: 3840, height: 2160 },
};

const SIZE_VALUE = /^(\d+)\s*x\s*(\d+)$/i;

/**
 * The `[general]` `resolution` of a DHU `.ini` config: `WIDTHxHEIGHT` or a name such as `720p`.
 * Comment lines start with `#` or `;`; keys in other sections are ignored. Returns null when the
 * section sets no resolution, and undefined when the value is not one the DHU names.
 */
export function parseDhuConfigResolution(
  text: string,
): { width: number; height: number } | null | undefined {
  const value = generalResolutionValue(text);
  if (value === undefined) {
    return null;
  }
  const named = NAMED_RESOLUTIONS[value.toLowerCase()];
  if (named) {
    return { ...named };
  }
  const size = SIZE_VALUE.exec(value);
  return size ? { width: Number(size[1]), height: Number(size[2]) } : undefined;
}

/** The last `resolution` value in the `[general]` section, if any. */
function generalResolutionValue(text: string): string | undefined {
  let section = "";
  let value: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim().toLowerCase();
      continue;
    }
    const split = line.indexOf("=");
    if (section === "general" && split > 0 && line.slice(0, split).trim() === "resolution") {
      value = line.slice(split + 1).trim();
    }
  }
  return value;
}

export interface HeadUnitInventoryDeps {
  /** The healthy DHU console the daemon owns for a device, if any. */
  consoleFor(deviceId: string): DesktopHeadUnitConsole | undefined;
  readConfig(configPath: string): Promise<string>;
}

/** The head unit the daemon runs for `deviceId`, or undefined when it runs none. */
export async function readHeadUnitInventoryEntry(
  deviceId: string,
  deps: HeadUnitInventoryDeps,
): Promise<HeadUnitInventoryEntry | undefined> {
  const panel = deps.consoleFor(deviceId)?.panel;
  if (!panel) {
    return undefined;
  }
  const entry: HeadUnitInventoryEntry = {
    display: HEAD_UNIT_DISPLAY,
    role: "projected",
    projectedBy: "androidAuto",
    console: panel.instance,
    ...(panel.configPath ? { configPath: panel.configPath } : {}),
  };
  if (!panel.configPath) {
    return entry;
  }
  const sizePx = await configSize(panel.configPath, deps);
  return sizePx ? { ...entry, sizePx } : entry;
}

async function configSize(
  configPath: string,
  deps: HeadUnitInventoryDeps,
): Promise<{ width: number; height: number } | undefined> {
  let text: string;
  try {
    text = await deps.readConfig(configPath);
  } catch (error) {
    logger.warn(`Could not read head unit config ${configPath}: ${errorMessage(error)}`, error);
    return undefined;
  }
  const size = parseDhuConfigResolution(text);
  if (size === undefined) {
    logger.warn(`Head unit config ${configPath} sets a resolution the DHU does not name`);
    return undefined;
  }
  return size ?? { ...DHU_DEFAULT_SIZE_PX };
}

/** Adds `headUnit` to each listed Android entry whose phone projects to a daemon-owned DHU. */
export async function withHeadUnitEntries<
  T extends { platform: string; runtime: { deviceId: string | null } },
>(
  entries: readonly T[],
  read: (deviceId: string) => Promise<HeadUnitInventoryEntry | undefined>,
): Promise<Array<T & { headUnit?: HeadUnitInventoryEntry }>> {
  return Promise.all(
    entries.map(async (entry) => {
      const deviceId = entry.runtime.deviceId;
      if (entry.platform !== "android" || !deviceId) {
        return entry;
      }
      const headUnit = await read(deviceId);
      return headUnit ? { ...entry, headUnit } : entry;
    }),
  );
}
