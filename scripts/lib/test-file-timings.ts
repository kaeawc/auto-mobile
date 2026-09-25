import { readFileSync } from "node:fs";

type TimingEvent = { event: "start" | "end"; file: string; elapsedMs?: number };

const [mode, path] = process.argv.slice(2);
if ((mode !== "active" && mode !== "summary") || !path) {
  throw new Error("Usage: bun scripts/lib/test-file-timings.ts <active|summary> <timing.ndjson>");
}

const events: TimingEvent[] = [];
for (const line of readFileSync(path, "utf8").split("\n")) {
  if (!line) {
    continue;
  }
  try {
    const event: unknown = JSON.parse(line);
    if (typeof event === "object" && event !== null && "event" in event && "file" in event) {
      if ((event.event === "start" || event.event === "end") && typeof event.file === "string") {
        events.push({
          event: event.event,
          file: event.file,
          elapsedMs:
            "elapsedMs" in event && typeof event.elapsedMs === "number"
              ? event.elapsedMs
              : undefined,
        });
      }
    }
  } catch (error) {
    // A kill may truncate the final diagnostic line; earlier complete lines remain usable.
    console.warn(`Skipping incomplete timing event: ${error}`);
  }
}

if (mode === "active") {
  const started: string[] = [];
  for (const event of events) {
    if (event.event === "start") {
      started.push(event.file);
    }
    if (event.event === "end") {
      const index = started.lastIndexOf(event.file);
      if (index !== -1) {
        started.splice(index, 1);
      }
    }
  }
  if (started.length > 0) {
    console.log(started[started.length - 1]);
  }
} else {
  const completed = events.filter(
    (event): event is TimingEvent & { elapsedMs: number } =>
      event.event === "end" && typeof event.elapsedMs === "number",
  );
  if (completed.length > 0) {
    const total = completed.reduce((sum, event) => sum + event.elapsedMs, 0);
    console.log(`Completed test-file time: ${total} ms (sum of elapsedMs)`);
    console.log("10 slowest test files:");
    for (const event of completed.sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 10)) {
      console.log(`${event.elapsedMs} ms ${event.file}`);
    }
  }
}
