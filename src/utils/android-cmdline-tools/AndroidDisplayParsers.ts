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
    records.push({
      logicalId: header[1],
      uniqueId,
      type,
      sizePx: size ? { width: Number(size[1]), height: Number(size[2]) } : undefined,
      hasDisplayInfo: line.includes("DisplayInfo{"),
    });
  }
  return records;
}

/** Map a physical panel key back to Android's current logical display id. */
export function logicalDisplayIdForPanel(
  infos: readonly AndroidDisplayInfo[],
  panelKey: string,
): number | undefined {
  const info = infos.find((entry) => entry.uniqueId?.split(":").slice(1).join(":") === panelKey);
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
