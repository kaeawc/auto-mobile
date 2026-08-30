import { describe, expect, test } from "bun:test";
import {
  findAndroidPackageProcessId,
  findAndroidPackageProcesses,
  isAndroidPackageRunning,
} from "../../../src/utils/android-cmdline-tools/androidProcessState";

describe("androidProcessState", () => {
  test("finds the main process PID for the selected app user", () => {
    const output = [
      "*APP* UID u0a123 ProcessRecord{aaa 111:com.example.app/u0a123}",
      "*APP* UID u10a123 ProcessRecord{bbb 222:com.example.app/u10a123}",
    ].join("\n");

    expect(findAndroidPackageProcessId(output, "com.example.app", 10)).toBe(222);
    expect(isAndroidPackageRunning(output, "com.example.app", 10)).toBe(true);
  });

  test("maps numeric system UIDs to their Android user", () => {
    const output = "*APP* UID 1000 ProcessRecord{aaa 30779:com.android.settings/1000}";

    expect(findAndroidPackageProcessId(output, "com.android.settings", 0)).toBe(30779);
    expect(findAndroidPackageProcessId(output, "com.android.settings", 10)).toBeNull();
  });

  test("prefers the main process over a secondary package process", () => {
    const output = [
      "*APP* UID u0a123 ProcessRecord{aaa 444:com.example.app:worker/u0a123}",
      "*APP* UID u0a123 ProcessRecord{bbb 555:com.example.app/u0a123}",
    ].join("\n");

    expect(findAndroidPackageProcessId(output, "com.example.app", 0)).toBe(555);
  });

  test("returns a secondary process when it is the package's only running process", () => {
    const output = "*APP* UID u0a123 ProcessRecord{aaa 444:com.example.app:worker/u0a123}";

    expect(findAndroidPackageProcessId(output, "com.example.app", 0)).toBe(444);
  });

  test("lists package-owned process identities across Android users", () => {
    const output = [
      "*APP* UID u0a123 ProcessRecord{aaa 111:com.example.app/u0a123}",
      "*APP* UID u0a123 ProcessRecord{bbb 222:com.example.app:worker/u0a123}",
      "*APP* UID u10a123 ProcessRecord{ccc 333:com.example.app/u10a123}",
      "*APP* UID u10i42 ProcessRecord{ddd 444:com.example.app:isolated/u10i42}",
    ].join("\n");

    expect(findAndroidPackageProcesses(output, "com.example.app")).toEqual([
      { pid: 111, processName: "com.example.app", userId: 0 },
      { pid: 222, processName: "com.example.app:worker", userId: 0 },
      { pid: 333, processName: "com.example.app", userId: 10 },
      { pid: 444, processName: "com.example.app:isolated", userId: 10 },
    ]);
  });

  test("finds a package running only in a fully qualified custom process", () => {
    const output = [
      "*APP* UID u10a123 ProcessRecord{aaa 777:com.example.shared/u10a123}",
      "    packageList={com.example.app, com.example.library}",
      "*APP* UID u0a456 ProcessRecord{bbb 888:com.example.other/u0a456}",
      "    packageList={com.example.other}",
    ].join("\n");

    expect(findAndroidPackageProcesses(output, "com.example.app")).toEqual([
      { pid: 777, processName: "com.example.shared", userId: 10 },
    ]);
    expect(isAndroidPackageRunning(output, "com.example.app", 10)).toBe(true);
    expect(findAndroidPackageProcessId(output, "com.example.app", 10)).toBe(777);
  });
});
