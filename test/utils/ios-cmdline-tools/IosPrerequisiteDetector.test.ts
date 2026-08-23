import { beforeEach, describe, expect, test } from "bun:test";
import { DefaultIosPrerequisiteDetector } from "../../../src/utils/ios-cmdline-tools/IosPrerequisiteDetector";
import { FakeSystemDetection } from "../../fakes/FakeSystemDetection";

describe("DefaultIosPrerequisiteDetector", function () {
  let system: FakeSystemDetection;

  beforeEach(function () {
    system = new FakeSystemDetection();
    system.setPlatform("darwin");
  });

  test("returns true when xcrun is runnable", async function () {
    system.setExecResponse("xcrun --version", "xcrun version 70\n");

    const detector = new DefaultIosPrerequisiteDetector(system);

    expect(await detector.hasIosPrerequisites()).toBe(true);
  });

  test("returns true when only xcodebuild is runnable", async function () {
    // xcrun probe fails (default), xcodebuild succeeds.
    system.setExecResponse("xcodebuild -version", "Xcode 16.0\n");

    const detector = new DefaultIosPrerequisiteDetector(system);

    expect(await detector.hasIosPrerequisites()).toBe(true);
  });

  test("returns false on macOS when neither xcrun nor xcodebuild is runnable", async function () {
    // No exec responses -> FakeSystemDetection throws for both probes.
    const detector = new DefaultIosPrerequisiteDetector(system);

    expect(await detector.hasIosPrerequisites()).toBe(false);
  });

  test("returns false when not running on macOS, without probing tools", async function () {
    system.setPlatform("linux");
    // Even if the tools would somehow answer, a non-darwin host cannot run iOS work.
    system.setExecResponse("xcrun --version", "xcrun version 70\n");

    const detector = new DefaultIosPrerequisiteDetector(system);

    expect(await detector.hasIosPrerequisites()).toBe(false);
  });
});
