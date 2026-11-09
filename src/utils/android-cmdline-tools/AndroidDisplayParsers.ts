import type { DisplayPanel } from "../../models/DisplayPanel";

/** Keep physical IDs as strings: JavaScript numbers cannot represent them exactly. */
export function parseSurfaceFlingerDisplayIds(output: string): Set<string> {
  const ids = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const tokens = line.trim().split(/[\s():]+/);
    if (tokens[0] === "Display" && /^\d+$/.test(tokens[1] ?? "")) {
      ids.add(tokens[1]);
    }
  }
  return ids;
}

export interface AndroidDisplayInfo {
  logicalId: string;
  uniqueId?: string;
  type?: "INTERNAL" | "EXTERNAL" | "VIRTUAL";
  sizePx?: DisplayPanel["sizePx"];
  hasDisplayInfo: boolean;
}

/** Read display-service records once for both default selection and inventory. */
export function parseAndroidDisplayInfos(output: string): AndroidDisplayInfo[] {
  const records: AndroidDisplayInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const header = /^Display id (\d+):/.exec(line.trim());
    if (!header) {
      continue;
    }
    records.push(parseDisplayInfo(header[1], line));
  }
  return records;
}

function parseDisplayInfo(logicalId: string, line: string): AndroidDisplayInfo {
  const tokens = line
    .trim()
    .split(/[\s"{},]+/)
    .filter(Boolean);
  const uniqueIdIndex = tokens.findIndex((token) => token === "uniqueId");
  const uniqueId =
    /\buniqueId "([^"]+)"/.exec(line)?.[1] ??
    // An unterminated quoted value cannot establish a panel's identity.
    (uniqueIdIndex >= 0 && !/\buniqueId\s+"/.test(line) ? tokens[uniqueIdIndex + 1] : undefined);
  const typeToken = /\btype (INTERNAL|EXTERNAL|VIRTUAL)\b/.exec(line)?.[1];
  const type =
    typeToken === "INTERNAL" || typeToken === "EXTERNAL" || typeToken === "VIRTUAL"
      ? typeToken
      : undefined;
  const size = /\breal (\d+) x (\d+)\b/.exec(line);
  return {
    logicalId,
    uniqueId,
    type,
    sizePx: size ? { width: Number(size[1]), height: Number(size[2]) } : undefined,
    hasDisplayInfo: line.includes("DisplayInfo{"),
  };
}

/** Enabled records in dumpsys display's Logical Displays section, including private displays. */
export function parseDumpsysLogicalDisplays(output: string): AndroidDisplayInfo[] {
  const records: AndroidDisplayInfo[] = [];
  let sectionIndent: number | undefined;
  let logicalId: string | undefined;
  let enabled = false;
  let baseInfo: string | undefined;
  const finishRecord = () => {
    if (enabled && logicalId !== undefined && baseInfo !== undefined) {
      records.push(parseDisplayInfo(logicalId, baseInfo));
    }
  };
  for (const line of output.split(/\r?\n/)) {
    if (sectionIndent === undefined) {
      const section = /^( *)Logical Displays:/.exec(line);
      if (section) {
        sectionIndent = section[1].length;
      }
      continue;
    }
    if (/^ *Display \d+:/.test(line)) {
      finishRecord();
      logicalId = undefined;
      enabled = false;
      baseInfo = undefined;
      continue;
    }
    if (line.trim() && line.search(/\S/) <= sectionIndent) {
      break;
    }
    const id = /^ *mDisplayId=(\d+)\s*$/.exec(line);
    if (id) {
      logicalId = id[1];
    }
    const isEnabled = /^ *mIsEnabled=(true|false)\s*$/.exec(line);
    if (isEnabled) {
      enabled = isEnabled[1] === "true";
    }
    if (/^ *mBaseDisplayInfo=DisplayInfo\{/.test(line)) {
      baseInfo = line;
    }
  }
  finishRecord();
  return records;
}

/**
 * The `virtual:<package>:<name>` key of an app-created virtual display, or undefined when the
 * uniqueId is not one. DisplayManager writes `virtual:<package>,<uid>,<name>,<index>` for an
 * ordinary virtual display, dropped here to package and name because the uid and index are not
 * stable across reinstalls and recreations, and `virtual:<package>:<id>` when the app supplied
 * its own unique id, which is already stable and kept whole.
 */
export function virtualDisplayKey(uniqueId: string): string | undefined {
  const generated = /^virtual:([^,:]+),\d+,(.+),\d+$/.exec(uniqueId);
  if (generated) {
    return `virtual:${generated[1]}:${generated[2]}`;
  }
  return /^virtual:[^,:]+:.+$/.test(uniqueId) ? uniqueId : undefined;
}

/** The owning package named by a `virtual:<package>:<name>` key. */
export function virtualDisplayOwnerPackage(key: string): string | undefined {
  return /^virtual:([^,:]+):/.exec(key)?.[1];
}

/**
 * The inventory key for a display-service uniqueId. Physical panels drop the `local:`/`external:`
 * prefix (their key is the bare physical id); overlay displays keep the whole `overlay:<n>` id and
 * app-created virtual displays use `virtual:<package>:<name>`, so neither can collide with a
 * physical id or be mistaken for a logical display id.
 */
export function panelKeyForUniqueId(uniqueId: string): string {
  if (uniqueId.startsWith("overlay:") || !uniqueId.includes(":")) {
    return uniqueId;
  }
  return virtualDisplayKey(uniqueId) ?? uniqueId.slice(uniqueId.indexOf(":") + 1);
}

/** Map an inventory panel key back to Android's current logical display id. */
export function logicalDisplayIdForPanel(
  infos: readonly AndroidDisplayInfo[],
  panelKey: string,
): number | undefined {
  const info = infos.find(
    (entry) => entry.uniqueId !== undefined && panelKeyForUniqueId(entry.uniqueId) === panelKey,
  );
  return info ? Number(info.logicalId) : undefined;
}

/**
 * Map an Android logical display id to the SurfaceFlinger physical display id
 * that `screencap -d` accepts (the digits of a `local:<physicalId>` uniqueId).
 * Virtual and other non-local displays have no physical id.
 */
export function physicalDisplayIdForLogicalId(
  infos: readonly AndroidDisplayInfo[],
  logicalId: number,
): string | undefined {
  const info = infos.find((entry) => entry.logicalId === String(logicalId));
  return /^local:(\d+)$/.exec(info?.uniqueId ?? "")?.[1];
}

/** Logical id of the display holding input focus, from `dumpsys window` `mTopFocusedDisplayId=<n>`. */
export function parseTopFocusedDisplayId(output: string): number | undefined {
  const match = /\bmTopFocusedDisplayId=(\d+)\b/.exec(output);
  return match ? Number(match[1]) : undefined;
}
