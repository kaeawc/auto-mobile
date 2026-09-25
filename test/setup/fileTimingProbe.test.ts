import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendTimingEvent } from "./fileTimingEvents";

let dir: string | undefined;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = undefined;
});

test("timing probe is inert without a log path", () => {
  let writes = 0;
  appendTimingEvent(undefined, { event: "start", file: "example.test.ts", t: 100 }, () => {
    writes += 1;
  });
  expect(writes).toBe(0);
});

test("timing probe appends one NDJSON line per event", () => {
  dir = mkdtempSync(join(tmpdir(), "file-timing-probe-"));
  const path = join(dir, "timing.ndjson");
  appendTimingEvent(path, { event: "start", file: "example.test.ts", t: 100 });
  appendTimingEvent(path, { event: "end", file: "example.test.ts", t: 115, elapsedMs: 15 });
  expect(
    readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  ).toEqual([
    { event: "start", file: "example.test.ts", t: 100 },
    { event: "end", file: "example.test.ts", t: 115, elapsedMs: 15 },
  ]);
});
