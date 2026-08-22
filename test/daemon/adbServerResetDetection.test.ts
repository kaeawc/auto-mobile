import { describe, expect, test } from "bun:test";
import { isProcessWideAdbServerReset } from "../../src/daemon/daemon";
import type { PooledDevice } from "../../src/daemon/devicePool";

function ownedAndroidEmulator(id: string): PooledDevice {
  return {
    id,
    name: `Unknown (${id})`,
    platform: "android",
    sessionId: "session-1",
    status: "busy",
    lastUsedAt: 0,
    assignmentCount: 1,
    errorCount: 0,
    avdName: "Pixel_8_API_35",
    androidImage: {
      name: "Pixel_8_API_35",
      platform: "android",
      isRunning: true,
      source: "local",
    },
    incarnation: 1,
  };
}

describe("ADB server reset detection", () => {
  test("requires every AutoMobile-owned Android emulator to disappear together", () => {
    const first = ownedAndroidEmulator("emulator-5554");
    const second = ownedAndroidEmulator("emulator-5556");

    expect(isProcessWideAdbServerReset(new Set([first.id, second.id]), [first, second])).toBe(true);
    expect(isProcessWideAdbServerReset(new Set([first.id]), [first, second])).toBe(false);
  });

  test("does not infer an ADB reset from physical Android devices", () => {
    const physical: PooledDevice = {
      ...ownedAndroidEmulator("physical-serial"),
      id: "physical-serial",
      avdName: undefined,
      androidImage: undefined,
    };

    expect(isProcessWideAdbServerReset(new Set([physical.id]), [physical])).toBe(false);
  });
});
