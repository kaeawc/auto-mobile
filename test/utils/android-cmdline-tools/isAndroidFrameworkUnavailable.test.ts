import { describe, expect, test } from "bun:test";
import { isAndroidFrameworkUnavailable } from "../../../src/utils/android-cmdline-tools/isAndroidFrameworkUnavailable";

describe("isAndroidFrameworkUnavailable", () => {
  test.each([
    "cmd: Can't find service: package",
    "Can't find service: settings\n",
    "Cannot find service: package",
    new Error("runner setup failed: Can't find service: settings; retry later"),
  ])("recognizes an unavailable package/settings service: %s", (diagnostic) => {
    expect(isAndroidFrameworkUnavailable(diagnostic)).toBe(true);
  });

  test.each([
    "Permission denied",
    "adb: device offline",
    "device unauthorized",
    "INSTALL_FAILED_INVALID_APK",
    "Can't find service: accessibility",
    "Can't find service: package_installer",
    "Can't find service: settings_backup",
    "Package not found",
    "settings permission denied",
    undefined,
  ])("does not retry unrelated failures: %s", (diagnostic) => {
    expect(isAndroidFrameworkUnavailable(diagnostic)).toBe(false);
  });
});
