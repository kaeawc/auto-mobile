import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Real `ps -p <pid> -o lstart=` output for ONE macOS process (macOS 26.6.2),
 * captured in a single pass under `LC_ALL=C` with only `TZ` varying. The same
 * start instant is therefore printed three ways. The bytes are verbatim,
 * including the trailing padding `ps` emits (issue #10116).
 */
function readLstartFixture(name: string): string {
  return readFileSync(join(__dirname, "../fixtures/daemon-ps-lstart", `${name}.txt`), "utf-8");
}

export const LSTART_UTC = readLstartFixture("utc");
export const LSTART_AMERICA_CHICAGO = readLstartFixture("america-chicago");
export const LSTART_ASIA_TOKYO = readLstartFixture("asia-tokyo");
/** The captured process's start instant (07:35:51 UTC on 2026-10-06). */
export const CAPTURED_START_EPOCH_MS = Date.UTC(2026, 9, 6, 7, 35, 51);

const LSTART_BY_ZONE: Record<string, string> = {
  UTC: LSTART_UTC,
  "America/Chicago": LSTART_AMERICA_CHICAGO,
  "Asia/Tokyo": LSTART_ASIA_TOKYO,
};

/** The same collapse `darwinProcessGenerationToken` applies to an lstart. */
export function normalizeLstart(lstart: string): string {
  return lstart.trim().replace(/\s+/g, " ");
}

/**
 * Renders an instant the way macOS `ps lstart` does (`%a %b %e %H:%M:%S %Y`) in
 * an IANA zone, using Intl so the test never mutates `process.env.TZ`. It is
 * checked against the captured fixtures above (see processGeneration.test.ts),
 * so it is only used to place OTHER instants in the captured format.
 */
export function renderLstart(epochMs: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      year: "numeric",
    })
      .formatToParts(new Date(epochMs))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.weekday} ${parts.month} ${parts.day?.padStart(2, " ")} ${parts.hour}:${parts.minute}:${parts.second} ${parts.year}`;
}

/** The captured fixture for `timeZone`; `ps` falls back to the host zone when `TZ` is unset. */
export function capturedLstartFor(timeZone: string | undefined, hostZone: string): string {
  const lstart = LSTART_BY_ZONE[timeZone ?? hostZone];
  if (lstart === undefined) {
    throw new Error(`no captured lstart for ${timeZone ?? hostZone}`);
  }
  return lstart;
}

/** The token an older build wrote: local wall time under the retired `darwin:` prefix. */
export function legacyLocalToken(lstart: string): string {
  return `darwin:${normalizeLstart(lstart)}`;
}
