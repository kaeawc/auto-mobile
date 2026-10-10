/**
 * Measures the runtime's own clocks over short real sleeps and prints JSON (#11473). Run by the
 * Bun 1.4 nightly canary, whose artifact the owner compares with the clock-semantics table in
 * src/utils/SystemTimer.ts. No wall-clock changes, no privileges, no network.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import {
  MONOTONIC_CLOCK_SEMANTICS_VERIFIED_BUN,
  defaultTimer,
  monotonicClockIncludesHostSleep,
} from "../../src/utils/SystemTimer";
import {
  formatClockSemanticsReport,
  measureClockSemantics,
  parseProcUptimeSeconds,
  type ClockReading,
  type ClockSemanticsReport,
} from "./clockSemanticsReport";

const SLEEP_MS = [50, 100, 150];

function readProcUptime(): number | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    return parseProcUptimeSeconds(readFileSync("/proc/uptime", "utf8"));
  } catch {
    // /proc/uptime is optional on non-standard Linux sandboxes; the field is reported as absent.
    return undefined;
  }
}

function read(): ClockReading {
  const bun = (globalThis as { Bun?: { nanoseconds?: () => number } }).Bun;
  return {
    wallMs: Date.now(),
    performanceMs: performance.now(),
    hrtimeNs: Number(process.hrtime.bigint()),
    bunNanoseconds: bun?.nanoseconds?.(),
    osUptimeSec: os.uptime(),
    processUptimeSec: process.uptime(),
    procUptimeSec: readProcUptime(),
  };
}

const reports: ClockSemanticsReport[] = [];
for (const sleepMs of SLEEP_MS) {
  reports.push(
    await measureClockSemantics({
      read,
      timer: defaultTimer,
      sleepMs,
      platform: process.platform,
      arch: process.arch,
      bunVersion: process.versions.bun,
      nodeVersion: process.version,
      verifiedBunLine: MONOTONIC_CLOCK_SEMANTICS_VERIFIED_BUN,
      tableSaysMonotonicIncludesHostSleep: monotonicClockIncludesHostSleep(process.platform),
    }),
  );
}
process.stdout.write(formatClockSemanticsReport(reports));
