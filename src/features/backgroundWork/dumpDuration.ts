const TOKEN = /(\d+)(ms|d|h|m|s)/g;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parses `TimeUtils.formatDuration` text from a dumpsys, e.g. `+1h2m3s4ms`, `-5s` or `0`, into
 * milliseconds. Returns undefined for `none`, `unspecified` or anything else that is not a duration.
 */
export function parseDumpDurationMs(text: string | undefined): number | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "0") {
    return 0;
  }
  const match = /^([+-]?)((?:\d+(?:ms|d|h|m|s))+)$/.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const total = [...match[2].matchAll(TOKEN)].reduce(
    (sum, token) => sum + Number(token[1]) * UNIT_MS[token[2]],
    0,
  );
  return match[1] === "-" ? -total : total;
}
