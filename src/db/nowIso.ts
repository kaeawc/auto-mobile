import type { Timer } from "../utils/SystemTimer";

/** The one way a repository stamps a row: the injected Timer's clock as an ISO-8601 string. */
export function nowIso(timer: Timer): string {
  return new Date(timer.now()).toISOString();
}
