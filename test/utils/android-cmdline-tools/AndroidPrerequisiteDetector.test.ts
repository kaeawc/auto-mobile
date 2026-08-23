import { beforeEach, describe, expect, test } from "bun:test";
import { DefaultAndroidPrerequisiteDetector } from "../../../src/utils/android-cmdline-tools/AndroidPrerequisiteDetector";
import { FakeSystemDetection } from "../../fakes/FakeSystemDetection";

describe("DefaultAndroidPrerequisiteDetector", function () {
  let system: FakeSystemDetection;

  beforeEach(function () {
    system = new FakeSystemDetection();
    system.setPlatform("linux");
  });

  test("returns true when adb is on PATH", async function () {
    system.setExecResponse("which adb", "/usr/bin/adb\n");

    const detector = new DefaultAndroidPrerequisiteDetector(system);

    expect(await detector.hasAndroidPrerequisites()).toBe(true);
  });

  test("returns true when ANDROID_HOME points at a real platform-tools/adb", async function () {
    system.setEnvVar("ANDROID_HOME", "/opt/android-sdk");
    system.addExistingFile("/opt/android-sdk");
    system.addExistingFile("/opt/android-sdk/platform-tools/adb");

    const detector = new DefaultAndroidPrerequisiteDetector(system);

    expect(await detector.hasAndroidPrerequisites()).toBe(true);
  });

  test("returns true when cmdline-tools are detected via ANDROID_HOME", async function () {
    system.setEnvVar("ANDROID_HOME", "/opt/android-sdk");
    system.addExistingFile("/opt/android-sdk");
    const binDir = "/opt/android-sdk/cmdline-tools/latest/bin";
    system.addExistingFile("/opt/android-sdk/cmdline-tools/latest");
    system.addExistingFile(binDir);
    system.addExistingFile(`${binDir}/sdkmanager`);

    const detector = new DefaultAndroidPrerequisiteDetector(system);

    expect(await detector.hasAndroidPrerequisites()).toBe(true);
  });

  test("returns false when no adb and no SDK tooling exist", async function () {
    // No exec response for `which adb` -> FakeSystemDetection throws (not found).
    // No env vars, no files.
    const detector = new DefaultAndroidPrerequisiteDetector(system);

    expect(await detector.hasAndroidPrerequisites()).toBe(false);
  });

  test("returns false when an SDK env var is set but platform-tools/adb is absent", async function () {
    system.setEnvVar("ANDROID_HOME", "/opt/android-sdk");
    system.addExistingFile("/opt/android-sdk");
    // platform-tools/adb intentionally not added, and no cmdline-tools present.

    const detector = new DefaultAndroidPrerequisiteDetector(system);

    expect(await detector.hasAndroidPrerequisites()).toBe(false);
  });
});
