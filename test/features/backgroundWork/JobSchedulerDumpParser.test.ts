import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AospJobSchedulerDumpParser } from "../../../src/features/backgroundWork/JobSchedulerDumpParser";
import { parseDumpDurationMs } from "../../../src/features/backgroundWork/dumpDuration";

// Captured with `adb shell dumpsys jobscheduler <package>` on emulators; see
// test/fixtures/android-jobscheduler/README.md.
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../fixtures/android-jobscheduler/${name}.txt`, import.meta.url),
    "utf8",
  );
}

const WM_SERVICE =
  "com.google.android.apps.wellbeing/androidx.work.impl.background.systemjob.SystemJobService";
const parser = new AospJobSchedulerDumpParser();

/**
 * Jobs a dump attributes to `pkg`, counted without the parser: the first `Source: ... pkg=<pkg>`
 * line after each `JOB #` line. A job can name another package's service (the download provider's
 * jobs are sourced from `android`), and `dumpsys jobscheduler android` also lists the jobs of
 * other packages that share the system uid, so the source line says whose job it is.
 */
function jobLineCount(dump: string, pkg: string): number {
  let count = 0;
  let awaitingSource = false;
  for (const line of dump.split("\n")) {
    if (/^\s*JOB #\S+: /.test(line)) {
      awaitingSource = true;
    } else if (awaitingSource && /^\s*Source: /.test(line)) {
      awaitingSource = false;
      count += new RegExp(` pkg=${pkg}\\s*$`).test(line) ? 1 : 0;
    }
  }
  return count;
}

describe("AospJobSchedulerDumpParser", () => {
  test.each([
    "phone-api30",
    "phone-api33",
    "phone-api34",
    "phone-api35",
    "phone-api37",
    "watch-api37",
    "tv-api36",
    "automotive-api34",
  ])("%s: every job of the android package is parsed", (device) => {
    const dump = fixture(`dumpsys-jobscheduler-android-${device}`);
    const jobs = parser.parse(dump, "android");

    expect(jobs.length).toBe(jobLineCount(dump, "android"));
    expect(jobs.length).toBeGreaterThan(5);
    for (const job of jobs) {
      expect(job.service).toMatch(/^[\w.]+\//);
      expect(job.requiredConstraints.length).toBeGreaterThan(0);
      expect(job.workManager).toBe(false);
    }
  });

  test("API 30 prints every package's jobs whatever the filter, so the parser filters", () => {
    const dump = fixture("dumpsys-jobscheduler-android-phone-api30");
    const wellbeing = parser.parse(dump, "com.google.android.apps.wellbeing");

    expect(jobLineCount(dump, "android")).toBeGreaterThan(0);
    expect(parser.parse(dump, "android").length).toBe(jobLineCount(dump, "android"));
    expect(
      wellbeing.every((job) => job.service.startsWith("com.google.android.apps.wellbeing/")),
    ).toBe(true);
  });

  test("API 34: a periodic job reports interval, flex and both run times", () => {
    const job = parser
      .parse(fixture("dumpsys-jobscheduler-android-phone-api34"), "android")
      .find((candidate) => candidate.jobId === 765_123);

    expect(job).toEqual({
      jobId: 765_123,
      userId: 0,
      service: "android/com.android.server.PruneInstantAppsJobService",
      workManager: false,
      periodic: true,
      intervalMs: 86_400_000,
      flexMs: 86_400_000,
      requiredConstraints: ["DEVICE_IDLE", "TIMING_DELAY", "DEADLINE", "IDLE"],
      unsatisfiedConstraints: ["DEADLINE", "IDLE"],
      earliestRunInMs: -2_241_547,
      latestRunInMs: 84_158_453,
    });
  });

  test("API 34: WorkManager jobs are flagged and keep their constraint names", () => {
    const jobs = parser.parse(
      fixture("dumpsys-jobscheduler-wellbeing-phone-api34"),
      "com.google.android.apps.wellbeing",
    );

    expect(jobs.length).toBe(6);
    expect(jobs.every((job) => job.workManager && job.service === WM_SERVICE)).toBe(true);
    expect(jobs[0]).toEqual({
      jobId: 0,
      userId: 0,
      service: WM_SERVICE,
      workManager: true,
      periodic: false,
      requiredConstraints: ["TIMING_DELAY"],
      unsatisfiedConstraints: ["TIMING_DELAY"],
      earliestRunInMs: 2_134_066,
    });
    expect(jobs[1]).toMatchObject({
      requiredConstraints: ["CHARGING", "TIMING_DELAY"],
      unsatisfiedConstraints: ["TIMING_DELAY"],
    });
  });

  test("another package's jobs are not reported", () => {
    expect(parser.parse(fixture("dumpsys-jobscheduler-wellbeing-phone-api34"), "android")).toEqual(
      [],
    );
  });

  test("an unknown package, an empty dump and a missing service yield an empty list", () => {
    expect(
      parser.parse(fixture("dumpsys-jobscheduler-invalid-package-phone-api34"), "dev.example.none"),
    ).toEqual([]);
    expect(parser.parse("", "android")).toEqual([]);
    expect(parser.parse("Can't find service: jobscheduler", "android")).toEqual([]);
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
