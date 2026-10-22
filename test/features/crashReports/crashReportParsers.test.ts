import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dropboxReportId,
  dropboxTagOfReportId,
  parseDropboxCrashReports,
  parseUtcOffsetMinutes,
} from "../../../src/features/crashReports/androidDropboxCrashReport";
import {
  parseIpsCrashReport,
  parseIpsTimestamp,
} from "../../../src/features/crashReports/iosIpsCrashReport";
import { describeFrame } from "../../../src/features/crashReports/NativeCrashReport";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "../../fixtures/crashReports", name), "utf8");

describe(".ips crash reports (#14103)", () => {
  test("extracts exception, termination, crashing-thread frames, version and Simulator UDID", () => {
    const parsed = parseIpsCrashReport(fixture("ios-simulator-sigabrt.ips"), "/r/Playground.ips");

    expect(parsed?.simulatorDeviceId).toBe("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
    expect(parsed?.report).toMatchObject({
      id: "8E5D1F2A-3B4C-4D5E-8F60-718293A4B5C6",
      platform: "ios",
      source: "ios_ips",
      appId: "com.example.app",
      appVersion: "1.4.0",
      processId: 4321,
      timestampMs: Date.parse("2026-10-21T10:00:00.812Z"),
      exceptionType: "EXC_CRASH (SIGABRT)",
      exceptionCode: "0x0000000000000000, 0x0000000000000000",
      exceptionMessage: "abort() called",
      terminationReason: "SIGNAL 6: Abort trap: 6 (by launchctl)",
      reportPath: "/r/Playground.ips",
      deviceModel: "iOS Simulator",
      osVersion: "macOS 15.1 (24B83)",
    });
    expect(parsed?.report.frames.map(describeFrame)).toEqual([
      "__pthread_kill (libsystem_kernel.dylib)",
      "pthread_kill (libsystem_pthread.dylib)",
      "abort (libsystem_c.dylib)",
      "PlaygroundApp.crashButtonTapped() (Playground PlaygroundApp.swift:88)",
      "main (Playground)",
      "start_sim (dyld_sim)",
    ]);
    expect(parsed?.report.frames.map((frame) => frame.isAppCode)).toEqual([
      false,
      false,
      false,
      true,
      true,
      false,
    ]);
  });

  test("skips non-crash .ips kinds and unparseable text", () => {
    const hang = fixture("ios-simulator-sigabrt.ips").replace(
      '"bug_type":"309"',
      '"bug_type":"288"',
    );
    expect(parseIpsCrashReport(hang, "/r/hang.ips")).toBeUndefined();
    expect(
      parseIpsCrashReport("Incident Identifier: legacy text\n...", "/r/old.ips"),
    ).toBeUndefined();
    expect(parseIpsCrashReport("{}", "/r/one-line.ips")).toBeUndefined();
  });

  test("parses capture timestamps with zone offsets", () => {
    expect(parseIpsTimestamp("2026-10-21 03:00:00.50 -0700")).toBe(
      Date.parse("2026-10-21T10:00:00.500Z"),
    );
    expect(parseIpsTimestamp("not a time")).toBeUndefined();
  });
});

describe("Android dropbox crash reports (#14103)", () => {
  test("parses every data_app_crash entry with process, version, exception and frames", () => {
    const reports = parseDropboxCrashReports(fixture("android-dropbox-app-crash.txt"), 0);

    expect(reports.map((parsed) => [parsed.processName, parsed.report.processId])).toEqual([
      ["com.example.app", 1111],
      ["com.other.app", 2222],
      ["com.example.app", 4321],
    ]);
    const latest = reports[2]!.report;
    expect(latest).toMatchObject({
      id: "data_app_crash-20261021T100002-4321",
      platform: "android",
      source: "android_dropbox",
      appId: "com.example.app",
      appVersion: "1.4.0",
      timestampMs: Date.parse("2026-10-21T10:00:02Z"),
      exceptionType: "android.app.RemoteServiceException$CrashedByAdbException",
      exceptionMessage: "shell-induced crash",
      terminationReason: "uncaught exception",
      reportPath: "dumpsys dropbox data_app_crash 2026-10-21 10:00:02",
      deviceModel: "sdk_gphone64_arm64",
      osVersion: "Android 14",
    });
    expect(latest.frames[0]).toEqual({
      className: "android.app.ActivityThread",
      methodName: "throwRemoteServiceException",
      fileName: "ActivityThread.java",
      lineNumber: 2115,
      isAppCode: false,
    });
    expect(latest.frames).toHaveLength(10);
    expect(reports[0]!.report.frames[0]!.isAppCode).toBe(true);
  });

  test("converts device-local entry times with the device UTC offset", () => {
    const [first] = parseDropboxCrashReports(fixture("android-dropbox-app-crash.txt"), 120);
    expect(first!.report.timestampMs).toBe(Date.parse("2026-10-21T07:58:12Z"));
    const [unknownZone] = parseDropboxCrashReports(fixture("android-dropbox-app-crash.txt"));
    expect(unknownZone!.report.timestampMs).toBeUndefined();
  });

  test("parses a native tombstone entry with signal, abort message and backtrace", () => {
    const [parsed] = parseDropboxCrashReports(fixture("android-dropbox-native-crash.txt"));

    expect(parsed!.report).toMatchObject({
      id: "data_app_native_crash-20261021T100003-4321",
      processId: 4321,
      timestampMs: Date.parse("2026-10-21T10:00:03.123Z"),
      exceptionType: "SIGABRT",
      exceptionCode: "signal 6 (SIGABRT), code -6 (SI_TKILL)",
      exceptionMessage: "native boom from JNI",
      terminationReason: "native crash",
    });
    expect(parsed!.report.frames.map(describeFrame)).toEqual([
      "abort+164 (/apex/com.android.runtime/lib64/bionic/libc.so)",
      "Java_com_example_app_Native_crash+48 (/data/app/~~abc==/com.example.app-xyz==/lib/arm64/libnative.so)",
      "art_quick_generic_jni_trampoline+144 (/apex/com.android.art/lib64/libart.so)",
    ]);
    expect(parsed!.report.frames[1]!.isAppCode).toBe(true);
  });

  test("tolerates CRLF output and empty dropbox listings", () => {
    const crlf = fixture("android-dropbox-native-crash.txt").replace(/\n/g, "\r\n");
    expect(parseDropboxCrashReports(crlf)).toHaveLength(1);
    expect(parseDropboxCrashReports("Drop box contents: 0 entries\n")).toEqual([]);
  });

  test("keeps each entry's own text for the full-report resource", () => {
    const reports = parseDropboxCrashReports(fixture("android-dropbox-app-crash.txt"), 0);
    expect(reports[2]!.rawText.startsWith("2026-10-21 10:00:02 data_app_crash (text")).toBe(true);
    expect(reports[2]!.rawText).toContain("shell-induced crash");
    expect(reports[2]!.rawText).not.toContain("another app's crash");
  });

  test("mints URI-safe ids whose tag can be recovered", () => {
    const id = dropboxReportId(
      "data_app_native_crash",
      "2026-10-21 10:00:03",
      "com.example:remote",
    );
    expect(id).toBe("data_app_native_crash-20261021T100003-com.example_remote");
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(dropboxTagOfReportId(id)).toBe("data_app_native_crash");
    expect(dropboxTagOfReportId("data_app_crash-20261021T100003-1")).toBe("data_app_crash");
    expect(dropboxTagOfReportId("8E5D1F2A-3B4C-4D5E-8F60-718293A4B5C6")).toBeUndefined();
  });

  test("reads date +%z offsets", () => {
    expect(parseUtcOffsetMinutes("+0530\n")).toBe(330);
    expect(parseUtcOffsetMinutes("-0700")).toBe(-420);
    expect(parseUtcOffsetMinutes("UTC")).toBeUndefined();
  });
});
