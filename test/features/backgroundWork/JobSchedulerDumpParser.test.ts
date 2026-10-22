import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AospJobSchedulerDumpParser } from "../../../src/features/backgroundWork/JobSchedulerDumpParser";
import { parseDumpDurationMs } from "../../../src/features/backgroundWork/dumpDuration";

// Hand-reconstructed from the AOSP dump code, not device captures;
// see test/fixtures/android-jobscheduler/README.md.
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/android-jobscheduler/${name}.txt`, import.meta.url),
    "utf8",
  );
}

const APP = "dev.example.playground";
const WM_SERVICE = `${APP}/androidx.work.impl.background.systemjob.SystemJobService`;
const parser = new AospJobSchedulerDumpParser();

describe("AospJobSchedulerDumpParser", () => {
  test("API 29: a WorkManager periodic job and a plain service job", () => {
    const jobs = parser.parse(fixture("dumpsys-jobscheduler-api29-periodic"), APP);

    expect(jobs).toEqual([
      {
        jobId: 7,
        userId: 0,
        service: WM_SERVICE,
        workManager: true,
        periodic: true,
        intervalMs: 900_000,
        flexMs: 900_000,
        requiredConstraints: ["BATTERY_NOT_LOW", "TIMING_DELAY", "DEADLINE", "CONNECTIVITY"],
        unsatisfiedConstraints: ["TIMING_DELAY", "BATTERY_NOT_LOW"],
        networkType: "any",
        earliestRunInMs: 776_544,
        latestRunInMs: 1_676_544,
      },
      {
        jobId: 12,
        userId: 0,
        service: `${APP}/dev.example.playground.sync.LegacySyncService`,
        workManager: false,
        periodic: false,
        requiredConstraints: [
          "CHARGING",
          "DEVICE_IDLE",
          "TIMING_DELAY",
          "DEADLINE",
          "IDLE",
          "UNMETERED",
        ],
        unsatisfiedConstraints: ["TIMING_DELAY", "CHARGING", "IDLE", "UNMETERED"],
        networkType: "unmetered",
        earliestRunInMs: 3_596_000,
        latestRunInMs: 7_196_000,
      },
    ]);
  });

  test("API 34: filters other packages, ignores hex suffixes, marks queue state", () => {
    const jobs = parser.parse(fixture("dumpsys-jobscheduler-api34-running"), APP);

    expect(jobs.map((job) => job.jobId)).toEqual([7, 9]);
    const [periodic, queued] = jobs;
    expect(periodic.requiredConstraints).toEqual([
      "BATTERY_NOT_LOW",
      "CONNECTIVITY",
      "TIMING_DELAY",
      "DEADLINE",
    ]);
    expect(periodic.unsatisfiedConstraints).toEqual(["TIMING_DELAY"]);
    expect(periodic.pending).toBeUndefined();
    expect(queued).toMatchObject({
      workManager: true,
      periodic: false,
      requiredConstraints: ["CONNECTIVITY"],
      unsatisfiedConstraints: [],
      pending: true,
      running: true,
    });
    expect(queued.earliestRunInMs).toBeUndefined();
  });

  test("the other package's job is reported when asked for it", () => {
    expect(
      parser.parse(fixture("dumpsys-jobscheduler-api34-running"), "dev.example.other"),
    ).toMatchObject([{ jobId: 3, workManager: false, requiredConstraints: ["CHARGING"] }]);
  });

  test("no jobs and unrelated text yield an empty list", () => {
    expect(parser.parse(fixture("dumpsys-jobscheduler-api34-none"), APP)).toEqual([]);
    expect(parser.parse("", APP)).toEqual([]);
    expect(parser.parse("Can't find service: jobscheduler", APP)).toEqual([]);
  });
});

describe("parseDumpDurationMs", () => {
  test.each([
    ["+1h2m3s4ms", 3_723_004],
    ["-5s", -5000],
    ["+1d", 86_400_000],
    ["+250ms", 250],
    ["0", 0],
  ])("%s", (text, expected) => {
    expect(parseDumpDurationMs(text)).toBe(expected);
  });

  test.each(["none", "", "unspecified", "12", undefined])("%p is not a duration", (text) => {
    expect(parseDumpDurationMs(text)).toBeUndefined();
  });
});
