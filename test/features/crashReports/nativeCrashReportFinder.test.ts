import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AndroidDropboxCrashReportFinder } from "../../../src/features/crashReports/AndroidDropboxCrashReportFinder";
import {
  IosSimulatorCrashReportFinder,
  type CrashReportFileSystem,
} from "../../../src/features/crashReports/IosSimulatorCrashReportFinder";
import {
  createNativeCrashReportFinder,
  createNativeCrashReportReader,
  IOS_SIMULATOR_CRASH_REPORT_POLL_DELAYS_MS,
  PHYSICAL_IOS_CRASH_REPORTS_UNSUPPORTED_REASON,
  PollingCrashReportFinder,
} from "../../../src/features/crashReports/NativeCrashReportFinder";
import type {
  NativeCrashReportFinder,
  NativeCrashReportLookup,
} from "../../../src/features/crashReports/NativeCrashReport";
import { recordNativeCrashReport } from "../../../src/features/crashReports/recordNativeCrashReport";
import type { RecordCrashInput } from "../../../src/features/failures/FailureRecorder";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/crashReports", name), "utf8");

const SIMULATOR = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const OTHER_SIMULATOR = "11111111-2222-3333-4444-555555555555";
const REPORTS = "/reports";
const CRASHED_AT = Date.parse("2026-10-21T10:00:00.000Z");
const IPS = fixture("ios-simulator-sigabrt.ips");

class MemoryReports implements CrashReportFileSystem {
  readonly files = new Map<string, { text: string; mtimeMs: number }>();
  readonly reads: string[] = [];

  add(name: string, text: string, mtimeMs = CRASHED_AT + 500): void {
    this.files.set(`${REPORTS}/${name}`, { text, mtimeMs });
  }

  async readdir(path: string): Promise<Array<{ name: string }>> {
    if (path !== REPORTS) {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
    return [...this.files.keys()].map((key) => ({ name: key.slice(REPORTS.length + 1) }));
  }

  async stat(path: string) {
    const file = this.files.get(path.replace(/\\/g, "/"))!;
    return { size: file.text.length, mtime: new Date(file.mtimeMs), isFile: () => true };
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    const key = path.replace(/\\/g, "/");
    this.reads.push(key);
    return Buffer.from(this.files.get(key)!.text);
  }
}

const query = { appId: "com.example.app", processId: 4321, notBeforeTimestampMs: CRASHED_AT };

describe("iOS Simulator .ips finder (#14103)", () => {
  test("finds the report for this Simulator, app and process", async () => {
    const reports = new MemoryReports();
    reports.add("Playground-2026-10-21-100001.ips", IPS);

    const lookup = await new IosSimulatorCrashReportFinder(SIMULATOR, reports, REPORTS).find(query);

    expect(lookup).toMatchObject({
      status: "found",
      report: { exceptionType: "EXC_CRASH (SIGABRT)", processId: 4321 },
    });
  });

  test("never attributes reports from another Simulator, another app, another pid, or before the crash", async () => {
    const reports = new MemoryReports();
    reports.add("other-sim.ips", IPS.replaceAll(SIMULATOR, OTHER_SIMULATOR));
    reports.add("other-app.ips", IPS.replaceAll("com.example.app", "com.other.app"));
    reports.add("other-pid.ips", IPS.replace('"pid" : 4321', '"pid" : 999'));
    reports.add(
      "stale-capture.ips",
      IPS.replace("2026-10-21 10:00:00.8123 +0000", "2026-10-21 09:00:00.0000 +0000"),
    );
    reports.add("stale-file.ips", IPS, CRASHED_AT - 60_000);
    reports.add("not-a-report.txt", IPS);

    const lookup = await new IosSimulatorCrashReportFinder(SIMULATOR, reports, REPORTS).find(query);

    expect(lookup).toEqual({ status: "notFound" });
    expect(reports.reads.map((path) => path.split("/").at(-1)).sort()).toEqual([
      "other-app.ips",
      "other-pid.ips",
      "other-sim.ips",
      "stale-capture.ips",
    ]);
  });

  test("tolerates the duplicate .000.ips ReportCrash can write in the same second", async () => {
    const captured = fixture("ios-simulator-playground-sigabrt-captured.ips");
    const capturedSimulator = "B131B3E7-52E7-4FC9-B698-0A73E66BB494";
    const crashedAt = Date.parse("2026-10-30T15:17:10-05:00");
    const writtenAt = Date.parse("2026-10-30T15:17:29-05:00");
    const reports = new MemoryReports();
    reports.add("Playground-2026-10-30-151729.ips", captured, writtenAt);
    reports.add("Playground-2026-10-30-151729.000.ips", captured, writtenAt);
    const finder = new IosSimulatorCrashReportFinder(capturedSimulator, reports, REPORTS);

    const lookup = await finder.find({
      appId: "dev.jasonpearson.automobile.Playground",
      processId: 73194,
      notBeforeTimestampMs: crashedAt,
    });

    expect(lookup).toMatchObject({
      status: "found",
      report: { id: "3F55C604-EC99-4CA7-95B5-0E22E44A5EA5", processId: 73194 },
    });
    // One report per crash: the first match ends the lookup, so the copy is never read.
    expect(reports.reads).toHaveLength(1);
    const body = await finder.read("3F55C604-EC99-4CA7-95B5-0E22E44A5EA5");
    expect(body?.text).toBe(captured);
    expect(await finder.read("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  test("finds a crash whose only report is the numbered .000.ips copy", async () => {
    const reports = new MemoryReports();
    reports.add(
      "Playground-2026-10-30-151729.000.ips",
      fixture("ios-simulator-playground-sigabrt-captured.ips"),
      Date.parse("2026-10-30T15:17:29-05:00"),
    );
    const finder = new IosSimulatorCrashReportFinder(
      "B131B3E7-52E7-4FC9-B698-0A73E66BB494",
      reports,
      REPORTS,
    );

    const lookup = await finder.find({
      appId: "dev.jasonpearson.automobile.Playground",
      processId: 73194,
      notBeforeTimestampMs: Date.parse("2026-10-30T15:17:10-05:00"),
    });

    expect(lookup).toMatchObject({
      status: "found",
      report: { id: "3F55C604-EC99-4CA7-95B5-0E22E44A5EA5" },
    });
  });

  test("reports notFound when the DiagnosticReports folder does not exist", async () => {
    const finder = new IosSimulatorCrashReportFinder(SIMULATOR, new MemoryReports(), "/missing");
    expect(await finder.find(query)).toEqual({ status: "notFound" });
  });
});

describe("Android dropbox finder (#14103)", () => {
  function adbWith(appCrash: string, nativeCrash = "", offset = "+0000") {
    const adb = new FakeAdbClient();
    adb.setCommandResult("shell date +%z", offset);
    adb.setCommandResult("shell dumpsys dropbox --print data_app_crash", appCrash);
    adb.setCommandResult("shell dumpsys dropbox --print data_app_native_crash", nativeCrash);
    return adb;
  }

  test("finds the newest fresh entry for the crashed pid, ignoring other apps and stale entries", async () => {
    const adb = adbWith(fixture("android-dropbox-app-crash.txt"));

    const lookup = await new AndroidDropboxCrashReportFinder(adb).find(query);

    expect(lookup).toMatchObject({
      status: "found",
      report: { processId: 4321, exceptionMessage: "shell-induced crash" },
    });
  });

  test("prefers the later native tombstone for the same process", async () => {
    const adb = adbWith(
      fixture("android-dropbox-app-crash.txt"),
      fixture("android-dropbox-native-crash.txt"),
    );

    expect(await new AndroidDropboxCrashReportFinder(adb).find(query)).toMatchObject({
      status: "found",
      report: { exceptionType: "SIGABRT", exceptionMessage: "native boom from JNI" },
    });
  });

  test("applies the device zone so an entry before the crash is not attributed", async () => {
    // At +0200 the 10:00:02 local entry is 08:00:02 UTC, two hours before the crash.
    const adb = adbWith(fixture("android-dropbox-app-crash.txt"), "", "+0200");
    expect(await new AndroidDropboxCrashReportFinder(adb).find(query)).toEqual({
      status: "notFound",
    });
  });

  test("without a device zone, attributes only by exact pid", async () => {
    const adb = adbWith(fixture("android-dropbox-app-crash.txt"), "", "unknown");
    const finder = new AndroidDropboxCrashReportFinder(adb);
    expect(await finder.find(query)).toMatchObject({
      status: "found",
      report: { processId: 4321 },
    });
    expect(await finder.find({ ...query, processId: undefined })).toEqual({ status: "notFound" });
  });
});

describe("crash report readers (#14103)", () => {
  const INCIDENT = "8E5D1F2A-3B4C-4D5E-8F60-718293A4B5C6";

  test("reads an .ips back by incident id, only for this Simulator", async () => {
    const reports = new MemoryReports();
    reports.add("mine.ips", IPS);
    reports.add("theirs.ips", IPS.replaceAll(SIMULATOR, OTHER_SIMULATOR));

    const body = await new IosSimulatorCrashReportFinder(SIMULATOR, reports, REPORTS).read(
      INCIDENT,
    );
    expect(body?.text).toBe(IPS);
    expect(body?.report.appId).toBe("com.example.app");

    const other = await new IosSimulatorCrashReportFinder(OTHER_SIMULATOR, reports, REPORTS).read(
      INCIDENT,
    );
    expect(other?.text).toBe(IPS.replaceAll(SIMULATOR, OTHER_SIMULATOR));
    expect(
      await new IosSimulatorCrashReportFinder(
        "11111111-9999-9999-9999-999999999999",
        reports,
        REPORTS,
      ).read(INCIDENT),
    ).toBeUndefined();
  });

  test("reads one dropbox entry back by id, not its neighbours", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult(
      "shell dumpsys dropbox --print data_app_crash",
      fixture("android-dropbox-app-crash.txt"),
    );

    const body = await new AndroidDropboxCrashReportFinder(adb).read(
      "data_app_crash-20261021T100002-4321",
    );

    expect(body?.report.processId).toBe(4321);
    expect(body?.text).toContain("shell-induced crash");
    expect(body?.text).not.toContain("another app's crash");
    expect(
      await new AndroidDropboxCrashReportFinder(adb).read("data_app_crash-20261021T100002-9999"),
    ).toBeUndefined();
    expect(await new AndroidDropboxCrashReportFinder(adb).read(INCIDENT)).toBeUndefined();
  });

  test("has no reader on physical iOS", () => {
    expect(
      createNativeCrashReportReader(
        { deviceId: "00008110-000A1B2C3D4E5F60", name: "iPhone", platform: "ios" },
        { adb: new FakeAdbClient(), fileSystem: new MemoryReports() },
      ),
    ).toBeUndefined();
  });
});

describe("crash report lookup wiring (#14103)", () => {
  test("polls on the injected timer until a report appears", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const results: NativeCrashReportLookup[] = [
      { status: "notFound" },
      { status: "notFound" },
      { status: "unsupported", reason: "stop" },
    ];
    let calls = 0;
    const inner: NativeCrashReportFinder = {
      find: async () => results[calls++]!,
    };

    expect(await new PollingCrashReportFinder(inner, timer).find(query)).toEqual({
      status: "unsupported",
      reason: "stop",
    });
    expect(calls).toBe(3);
    expect(timer.getSleepHistory()).toEqual([500, 500]);
  });

  const SIMULATOR_DEVICE = { deviceId: SIMULATOR, name: "iPhone 17", platform: "ios" } as const;
  const elapsed = (timer: FakeTimer) => timer.getSleepHistory().reduce((sum, ms) => sum + ms, 0);

  test("waits for a Simulator .ips that ReportCrash writes 12 s after the crash", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const reports = new MemoryReports();
    // The report only exists once 12 s of polling have passed (seen under host load).
    const lateReports: CrashReportFileSystem = {
      readdir: async (path) => {
        if (elapsed(timer) >= 12_000 && reports.files.size === 0) {
          reports.add("late.ips", IPS);
        }
        return reports.readdir(path);
      },
      stat: (path) => reports.stat(path),
      readFileBuffer: (path) => reports.readFileBuffer(path),
    };
    const finder = new PollingCrashReportFinder(
      new IosSimulatorCrashReportFinder(SIMULATOR, lateReports, REPORTS),
      timer,
      IOS_SIMULATOR_CRASH_REPORT_POLL_DELAYS_MS,
    );

    expect(await finder.find(query)).toMatchObject({
      status: "found",
      report: { processId: 4321 },
    });
  });

  test("gives up on a missing Simulator .ips after about 20 s", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const finder = createNativeCrashReportFinder(SIMULATOR_DEVICE, {
      adb: new FakeAdbClient(),
      fileSystem: new MemoryReports(),
      timer,
    });

    expect(await finder.find(query)).toEqual({ status: "notFound" });
    expect(timer.getSleepHistory()).toEqual([...IOS_SIMULATOR_CRASH_REPORT_POLL_DELAYS_MS]);
    expect(elapsed(timer)).toBe(20_000);
  });

  test("gates physical iOS with a typed unsupported reason", async () => {
    const finder = createNativeCrashReportFinder(
      { deviceId: "00008110-000A1B2C3D4E5F60", name: "iPhone", platform: "ios" },
      { adb: new FakeAdbClient(), fileSystem: new MemoryReports(), timer: new FakeTimer() },
    );
    expect(await finder.find(query)).toEqual({
      status: "unsupported",
      reason: PHYSICAL_IOS_CRASH_REPORTS_UNSUPPORTED_REASON,
    });
  });

  test("records a report as a crash failure with its frames and termination", async () => {
    const recorded: RecordCrashInput[] = [];
    const lookup = await new IosSimulatorCrashReportFinder(
      SIMULATOR,
      (() => {
        const reports = new MemoryReports();
        reports.add("a.ips", IPS);
        return reports;
      })(),
      REPORTS,
    ).find(query);
    if (lookup.status !== "found") {
      throw new Error("expected a report");
    }

    await recordNativeCrashReport(
      { recordCrash: async (input) => (recorded.push(input), "occ-1") },
      SIMULATOR,
      lookup.report,
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      exceptionType: "EXC_CRASH (SIGABRT)",
      deviceId: SIMULATOR,
      deviceModel: "iOS Simulator",
      appVersion: "1.4.0",
      sessionId: "crash-report:8E5D1F2A-3B4C-4D5E-8F60-718293A4B5C6",
    });
    expect(recorded[0]!.exceptionMessage).toContain("termination: SIGNAL 6: Abort trap: 6");
    expect(recorded[0]!.stackTrace).toHaveLength(6);
  });
});
