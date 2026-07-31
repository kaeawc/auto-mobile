import { describe, expect, it } from "bun:test";
import { BoundedAndroidDeviceReboot } from "../../src/utils/androidDeviceReboot";
import { FakeTimer } from "../fakes/FakeTimer";

const target = {
  name: "Pixel 8",
  platform: "android" as const,
  isRunning: false,
};

describe("BoundedAndroidDeviceReboot", () => {
  it("reports success after a successful reboot", async () => {
    let attempts = 0;
    const recovery = new BoundedAndroidDeviceReboot(new FakeTimer(), 1);

    await expect(recovery.run(target, async () => {
      attempts++;
    })).resolves.toBe(true);

    expect(attempts).toBe(1);
  });

  it("stops after the configured number of failed attempts", async () => {
    let attempts = 0;
    const recovery = new BoundedAndroidDeviceReboot(new FakeTimer(), 1);

    await expect(recovery.run(target, async () => {
      attempts++;
      throw new Error("emulator unavailable");
    })).resolves.toBe(false);

    expect(attempts).toBe(1);
  });

  it("backs off once before its final retry", async () => {
    let attempts = 0;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const recovery = new BoundedAndroidDeviceReboot(timer, 2);

    await expect(recovery.run(target, async () => {
      attempts++;
      throw new Error("emulator unavailable");
    })).resolves.toBe(false);

    expect(attempts).toBe(2);
    expect(timer.getSleepHistory()).toEqual([1_000]);
  });

  it("exhausts the target budget across successful crash-recovery cycles", async () => {
    let attempts = 0;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const recovery = new BoundedAndroidDeviceReboot(timer, 2);
    const reboot = async (): Promise<void> => {
      attempts++;
    };

    await expect(recovery.run(target, reboot)).resolves.toBe(true);
    await expect(recovery.run(target, reboot)).resolves.toBe(true);
    await expect(recovery.run(target, reboot)).resolves.toBe(false);

    expect(attempts).toBe(2);
    expect(timer.getSleepHistory()).toEqual([1_000]);
  });
});
