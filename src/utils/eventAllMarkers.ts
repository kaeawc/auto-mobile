import { firstFlagValue } from "./cliArgs";

export const EVENT_ALL_MARKERS_FLAG = "--event-all-markers";
export const EVENT_ALL_MARKERS_ENV = "AUTOMOBILE_EVENT_ALL_MARKERS";

export function hasEventAllMarkersCliOverride(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith(`${EVENT_ALL_MARKERS_FLAG}=`)) {
      return true;
    }
    if (arg === EVENT_ALL_MARKERS_FLAG) {
      const value = args[i + 1];
      return value !== undefined && !value.startsWith("--");
    }
  }
  return false;
}

/**
 * Split a comma-separated marker string into a normalized marker list.
 * Trims each entry and drops empties so `"@, /, #"` and `"@,/,#"` are equal.
 */
export function splitMarkers(value: string): string[] {
  return value
    .split(",")
    .map((marker) => marker.trim())
    .filter((marker) => marker.length > 0);
}

/**
 * Resolve the configured event-all marker list from CLI args (winning) or the
 * `AUTOMOBILE_EVENT_ALL_MARKERS` env var. Returns an empty array when unset,
 * which leaves marker-based auto-promotion disabled.
 */
export function parseEventAllMarkersConfig(args: string[], env: NodeJS.ProcessEnv): string[] {
  const raw = firstFlagValue(args, [EVENT_ALL_MARKERS_FLAG]) ?? env[EVENT_ALL_MARKERS_ENV];
  if (!raw) {
    return [];
  }
  return splitMarkers(raw);
}
