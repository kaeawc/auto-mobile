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
      (uniqueIdIndex >= 0 ? tokens[uniqueIdIndex + 1] : undefined);
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
