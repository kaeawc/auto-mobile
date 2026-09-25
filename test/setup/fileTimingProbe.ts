import { afterAll } from "bun:test";
import { appendTimingEvent } from "./fileTimingEvents";

const logPath = process.env.AUTOMOBILE_TEST_TIMING_LOG;
if (logPath) {
  // Bun re-executes preloads per file under --isolate, with Bun.main set to that file.
  const file = Bun.main;
  const started = Date.now();
  appendTimingEvent(logPath, { event: "start", file, t: started });
  afterAll(() => {
    const ended = Date.now();
    appendTimingEvent(logPath, { event: "end", file, t: ended, elapsedMs: ended - started });
  });
}
