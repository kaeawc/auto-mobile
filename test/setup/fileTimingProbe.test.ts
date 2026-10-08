import { afterAll, beforeAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
type ProbeEvent = { event: string; file: string; rss?: number };
let probeDir: string;
let probeFixture: string;
let probeEvents: ProbeEvent[];
let labelledEvents: ProbeEvent[];

function runProbe(logName: string, groupLabel?: string): ProbeEvent[] {
  const logPath = join(probeDir, logName);
  // This suite may itself run in a labelled shared process (#10583); the
  // child sees a label only when a case sets one.
  const env: Record<string, string | undefined> = {
    ...process.env,
    AUTOMOBILE_TEST_TIMING_LOG: logPath,
  };
  delete env.AUTOMOBILE_TEST_TIMING_GROUP_LABEL;
  if (groupLabel) {
    env.AUTOMOBILE_TEST_TIMING_GROUP_LABEL = groupLabel;
  }
  const result = Bun.spawnSync(
    [
      process.execPath,
      "test",
      "--isolate",
      "--preload",
      resolve("test/setup/fileTimingProbe.ts"),
      probeFixture,
    ],
    { cwd: probeDir, env },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Timing preload fixture failed: ${result.stderr.toString()}`);
  }
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

beforeAll(() => {
  // Bun.main is the resolved path (macOS tmpdir is a symlink).
  probeDir = realpathSync(mkdtempSync(join(tmpdir(), "file-timing-preload-")));
  probeFixture = join(probeDir, "probe.spec.ts");
  writeFileSync(probeFixture, 'import { test } from "bun:test"; test("fixture", () => {});\n');
  writeFileSync(join(probeDir, "bunfig.toml"), "[test]\n");
  probeEvents = runProbe("events.ndjson");
  labelledEvents = runProbe("labelled.ndjson", "unit shard 0 shared process (2 files)");
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

test("actual preload names the test file, or the shared-process group when labelled", () => {
  // Windows tmpdir() can be an 8.3 short path (RUNNER~1) while Bun reports the long form.
  const nativePath = (path: string) => realpathSync.native(path);
  const expectedFile = nativePath(probeFixture);
  expect(probeEvents.map((event) => nativePath(event.file))).toEqual([expectedFile, expectedFile]);
  expect(labelledEvents.map((event) => event.file)).toEqual([
    "unit shard 0 shared process (2 files)",
    "unit shard 0 shared process (2 files)",
  ]);
});
