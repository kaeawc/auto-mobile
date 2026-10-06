import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  AndroidOrientationReader,
  IosOrientationReader,
  orientationFromRotation,
  rotationForOrientation,
} from "../../../src/features/action/OrientationReader";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const device: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "emulator-5554",
};

function result(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (value: string) => stdout.includes(value),
  };
}

describe("OrientationReader", () => {
  test.each(["landscape", "portrait"] as const)(
    "reads %s from the default display while mirroring",
    async (orientation) => {
      const adb = new FakeAdbExecutor();
      const stdout = readFileSync(
        join(
          __dirname,
          "..",
          "observe",
          "windowDumps",
          `dumpsys-window-displays-mirror-${orientation}.txt`,
        ),
        "utf8",
      );
      adb.setCommandResponse("shell dumpsys window displays", result(stdout));
      adb.setCommandResponse("shell wm size", result("Physical size: 1080x2400"));
      expect(await new AndroidOrientationReader(adb).readOrientation(device)).toBe(orientation);
    },
  );

  test("maps WindowManager rotations to portrait and landscape", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell dumpsys window displays",
      result("  mRotation=1 mAltOrientation=false"),
    );
    const reader = new AndroidOrientationReader(adb);

    expect(await reader.readOrientation(device)).toBe("landscape");

    adb.setCommandResponse(
      "shell dumpsys window displays",
      result("  mRotation=2 mAltOrientation=false"),
    );
    expect(await reader.readOrientation(device)).toBe("portrait");
  });

  test("derives orientation from the display's natural axes", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell wm size", result("Physical size: 1080x2400"));
    adb.setCommandResponse(
      "shell dumpsys window displays",
      result("  mRotation=0 mAltOrientation=false"),
    );
    const reader = new AndroidOrientationReader(adb);

    expect(await reader.readOrientation(device)).toBe("portrait");

    adb.setCommandResponse("shell wm size", result("Physical size: 2560x1600"));
    expect(await reader.readOrientation(device)).toBe("landscape");

    adb.setCommandResponse(
      "shell dumpsys window displays",
      result("  mRotation=1 mAltOrientation=false"),
    );
    expect(await reader.readOrientation(device)).toBe("portrait");
  });

  test("forwards an abort signal to both Android orientation commands", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell dumpsys window displays",
      result("  mRotation=0 mAltOrientation=false"),
    );
    adb.setCommandResponse("shell wm size", result("Physical size: 1080x2400"));
    const controller = new AbortController();

    await new AndroidOrientationReader(adb).readOrientation(device, controller.signal);

    expect(adb.getCommandCalls().map((call) => call.signal)).toEqual([
      controller.signal,
      controller.signal,
    ]);
  });

  test("returns null when WindowManager output has no authoritative rotation", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "shell dumpsys window displays",
      result("snapshot=TaskSnapshot{ mRotation=1 }"),
    );

    expect(await new AndroidOrientationReader(adb).readOrientation(device)).toBeNull();
  });

  test("returns null for iOS until CtrlProxy has a read-only orientation query", async () => {
    expect(
      await new IosOrientationReader().readOrientation({ ...device, platform: "ios" }),
    ).toBeNull();
  });

  test.each([null, false, true])(
    "rotationForOrientation inverts orientationFromRotation for natural landscape %s",
    (naturalLandscape) => {
      for (const orientation of ["portrait", "landscape"] as const) {
        const value = rotationForOrientation(orientation, naturalLandscape);
        expect(orientationFromRotation(value, naturalLandscape)).toBe(orientation);
      }
    },
  );

  test("rotationForOrientation picks the rotation from the natural axes", () => {
    expect(rotationForOrientation("portrait", false)).toBe(0);
    expect(rotationForOrientation("landscape", false)).toBe(1);
    expect(rotationForOrientation("portrait", true)).toBe(1);
    expect(rotationForOrientation("landscape", true)).toBe(0);
    expect(rotationForOrientation("portrait", null)).toBe(0);
  });
});
