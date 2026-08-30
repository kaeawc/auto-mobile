import { describe, expect, test } from "bun:test";
import {
  findAndroidPackageProcessId,
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
});
