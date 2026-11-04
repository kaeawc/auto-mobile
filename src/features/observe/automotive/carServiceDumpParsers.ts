/** Pure parsers for API 34 CarService dumps; unknown output stays unavailable. */
export function parseDrivingState(output: string): "parked" | "idling" | "moving" | undefined {
  const state = /^\s*Current Driving State:\s*(\d+)\s*$/m.exec(output)?.[1];
  return state === "0" ? "parked" : state === "1" ? "idling" : state === "2" ? "moving" : undefined;
}

export interface UxRestrictions {
  requiresDistractionOptimization: boolean;
  activeRestrictions: number;
}

export function parseUxRestrictions(output: string, displayId: number): UxRestrictions | undefined {
  for (const match of output.matchAll(
    /^\s*Display id:\s*(\d+)\s+UXR:\s*DO:\s*(true|false)\s+UxR:\s*(\d+)\s+time:/gm,
  )) {
    if (Number(match[1]) === displayId && Number.isSafeInteger(Number(match[3]))) {
      return {
        requiresDistractionOptimization: match[2] === "true",
        activeRestrictions: Number(match[3]),
      };
    }
  }
  return undefined;
}

export function parseDoActivities(output: string, packageName: string): Set<string> | undefined {
  const lines = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (lines[0] === `No DO Activities for ${packageName}`) {
    return new Set();
  }
  if (lines[0] !== `DO Activities for ${packageName}`) {
    return undefined;
  }
  const activities = lines.slice(1).filter((line) => line.length > 0);
  if (activities.some((line) => !/^[\w$]+(?:\.[\w$]+)+$/.test(line))) {
    return undefined;
  }
  return new Set(activities);
}
