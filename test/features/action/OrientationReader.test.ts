import { describe, expect, test } from "bun:test";
import {
  AndroidOrientationReader,
  IOSOrientationReader,
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
  test("maps WindowManager rotations to portrait and landscape", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      'shell dumpsys window | grep -i "mRotation="',
      result("  mRotation=1 mAltOrientation=false"),
    );
    const reader = new AndroidOrientationReader(adb);

    expect(await reader.readOrientation(device)).toBe("landscape");

    adb.setCommandResponse(
      'shell dumpsys window | grep -i "mRotation="',
      result("  mRotation=2 mAltOrientation=false"),
    );
    expect(await reader.readOrientation(device)).toBe("portrait");
  });

  test("returns null when WindowManager output has no authoritative rotation", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      'shell dumpsys window | grep -i "mRotation="',
      result("snapshot=TaskSnapshot{ mRotation=1 }"),
    );

    expect(await new AndroidOrientationReader(adb).readOrientation(device)).toBeNull();
  });

  test("returns null for iOS until CtrlProxy has a read-only orientation query", async () => {
    expect(
      await new IOSOrientationReader().readOrientation({ ...device, platform: "ios" }),
    ).toBeNull();
  });
});
