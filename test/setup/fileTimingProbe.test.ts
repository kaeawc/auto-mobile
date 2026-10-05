import { afterAll, beforeAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  appendTimingEvent(path, {
    event: "end",
    file: "example.test.ts",
    t: 115,
    elapsedMs: 15,
    rss: 123456,
  });
  expect(
    readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  ).toEqual([
    { event: "start", file: "example.test.ts", t: 100 },
    { event: "end", file: "example.test.ts", t: 115, elapsedMs: 15, rss: 123456 },
  ]);
});

// Exercise the actual preload in a tiny child with no repository-wide preloads.
// Setup is outside the per-test budget; assertions inspect data, not wall time.
let probeDir: string;
let probeEvents: { event: string; file: string; rss?: number }[];
beforeAll(() => {
  probeDir = mkdtempSync(join(tmpdir(), "file-timing-preload-"));
  const fixture = join(probeDir, "probe.spec.ts");
  const logPath = join(probeDir, "events.ndjson");
  writeFileSync(fixture, 'import { test } from "bun:test"; test("fixture", () => {});\n');
  writeFileSync(join(probeDir, "bunfig.toml"), "[test]\n");
  const result = Bun.spawnSync(
    [
      process.execPath,
      "test",
      "--isolate",
      "--preload",
      resolve("test/setup/fileTimingProbe.ts"),
      fixture,
    ],
    { cwd: probeDir, env: { ...process.env, AUTOMOBILE_TEST_TIMING_LOG: logPath } },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Timing preload fixture failed: ${result.stderr.toString()}`);
  }
  probeEvents = readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
});
afterAll(() => rmSync(probeDir, { recursive: true, force: true }));

test("actual preload END event includes RSS bytes without changing START", () => {
  expect(probeEvents).toHaveLength(2);
  expect(probeEvents[0].event).toBe("start");
  expect(probeEvents[0].rss).toBeUndefined();
  expect(probeEvents[1].event).toBe("end");
  expect(typeof probeEvents[1].rss).toBe("number");
  expect(probeEvents[1].rss).toBeGreaterThan(0);
});
