import { z } from "zod/v4";
import { logger } from "../../utils/logger";

const frontBoardEventSchema = z.object({
  subsystem: z.literal("com.apple.FrontBoard"),
  timestamp: z.string(),
  eventMessage: z.string(),
});

interface SceneReadyTiming {
  requestTimestampMs: number | null;
  ttidMs: number | null;
}

function parseTimestampMs(timestamp: string): number {
  const match = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)\.(\d{6})([+-]\d\d)(\d\d)$/.exec(timestamp);
  if (!match) {
    return NaN;
  }
  const [, date, time, micros, offsetHours, offsetMinutes] = match;
  // Date.parse keeps only integer milliseconds. Add the fractional seconds separately.
  return Date.parse(`${date}T${time}${offsetHours}:${offsetMinutes}`) + Number(micros) / 1000;
}

function parseFrontBoardEvent(line: string) {
  if (!line.trimStart().startsWith("{")) {
    return null;
  }
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch (error) {
    // A malformed line is safe to skip; every NDJSON event is independently framed.
    logger.debug(`[measureStartup] Skipping malformed Simulator log line: ${error}`);
    return null;
  }
  const parsed = frontBoardEventSchema.safeParse(event);
  return parsed.success ? parsed.data : null;
}

const SCENE_SUFFIX =
  "(?:default|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Take the latest FrontBoard open request and the first subsequent ready event for the app's
 * main scene: `<bundleId>-default`, or a session-backed `<bundleId>-<UUID>` (e.g. Safari).
 */
export function parseIosSceneReady(output: string, bundleId: string): SceneReadyTiming {
  const requestMessage = `Received request to open "${bundleId}"`;
  const readyPattern = new RegExp(
    `:sceneID:${escapeRegExp(bundleId)}-${SCENE_SUFFIX}\\] scene content state changed: ready$`,
  );
  let requestTimestampMs: number | null = null;
  const readyTimestampsMs: number[] = [];

  for (const line of output.split(/\r?\n/)) {
    const event = parseFrontBoardEvent(line);
    if (!event) {
      continue;
    }
    const timestampMs = parseTimestampMs(event.timestamp);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }
    if (event.eventMessage.includes(requestMessage)) {
      requestTimestampMs = Math.max(requestTimestampMs ?? -Infinity, timestampMs);
    } else if (readyPattern.test(event.eventMessage)) {
      readyTimestampsMs.push(timestampMs);
    }
  }

  let firstReadyMs = Infinity;
  if (requestTimestampMs !== null) {
    for (const timestampMs of readyTimestampsMs) {
      if (timestampMs > requestTimestampMs) {
        firstReadyMs = Math.min(firstReadyMs, timestampMs);
      }
    }
  }
  return {
    requestTimestampMs,
    ttidMs:
      requestTimestampMs !== null && Number.isFinite(firstReadyMs)
        ? Math.round(firstReadyMs - requestTimestampMs)
        : null,
  };
}
