import { appendFileSync } from "node:fs";

export type TimingEvent =
  | { event: "start"; file: string; t: number }
  | { event: "end"; file: string; t: number; elapsedMs: number };

export function appendTimingEvent(
  logPath: string | undefined,
  event: TimingEvent,
  append: (path: string, data: string) => void = appendFileSync,
): void {
  if (!logPath) {
    return;
  }
  try {
    append(logPath, `${JSON.stringify(event)}\n`);
  } catch (error) {
    // Losing optional diagnostics must not change the result of the observed test.
    console.warn(`Unable to append test file timing to ${logPath}: ${error}`);
  }
}
