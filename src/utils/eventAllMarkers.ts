export const EVENT_ALL_MARKERS_FLAG = "--event-all-markers";
export const EVENT_ALL_MARKERS_ENV = "AUTOMOBILE_EVENT_ALL_MARKERS";

/**
 * Split a comma-separated marker string into a normalized marker list.
 * Trims each entry and drops empties so `"@, /, #"` and `"@,/,#"` are equal.
 */
function splitMarkers(value: string): string[] {
  return value
    .split(",")
    .map(marker => marker.trim())
    .filter(marker => marker.length > 0);
}

/**
 * Read the raw CLI value for `--event-all-markers`, supporting both the
 * `--event-all-markers=<csv>` and `--event-all-markers <csv>` forms.
 */
function firstFlagValue(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === EVENT_ALL_MARKERS_FLAG) {
      const value = args[i + 1];
      // Guard against a following flag being mistaken for the value.
      if (!value || value.startsWith("--")) {
        return undefined;
      }
      return value;
    }
    if (arg.startsWith(`${EVENT_ALL_MARKERS_FLAG}=`)) {
      return arg.slice(EVENT_ALL_MARKERS_FLAG.length + 1);
    }
  }
  return undefined;
}

/**
 * Resolve the configured event-all marker list from CLI args (winning) or the
 * `AUTOMOBILE_EVENT_ALL_MARKERS` env var. Returns an empty array when unset,
 * which leaves marker-based auto-promotion disabled.
 */
export function parseEventAllMarkersConfig(
  args: string[],
  env: NodeJS.ProcessEnv
): string[] {
  const raw = firstFlagValue(args) ?? env[EVENT_ALL_MARKERS_ENV];
  if (!raw) {
    return [];
  }
  return splitMarkers(raw);
}
