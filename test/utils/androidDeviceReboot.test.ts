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

    await expect(
      recovery.run(target, async () => {
        attempts++;
      }),
    ).resolves.toBe(true);

    expect(attempts).toBe(1);
  });

  it("stops after the configured number of failed attempts", async () => {
    let attempts = 0;
    const recovery = new BoundedAndroidDeviceReboot(new FakeTimer(), 1);

    await expect(
      recovery.run(target, async () => {
        attempts++;
        throw new Error("emulator unavailable");
      }),
    ).resolves.toBe(false);

    expect(attempts).toBe(1);
  });

  it("backs off once before its final retry", async () => {
    let attempts = 0;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const recovery = new BoundedAndroidDeviceReboot(timer, 2);

    await expect(
      recovery.run(target, async () => {
        attempts++;
        throw new Error("emulator unavailable");
      }),
    ).resolves.toBe(false);

    expect(attempts).toBe(2);
    expect(timer.getSleepHistory()).toEqual([1_000]);
  });

  it("exhausts the target budget for back-to-back crash-recovery cycles inside the window", async () => {
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

  it("allows recovery again once earlier attempts age out of the window (#7545)", async () => {
    let attempts = 0;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const recovery = new BoundedAndroidDeviceReboot(timer, 2, 60 * 60 * 1000);
    const reboot = async (): Promise<void> => {
      attempts++;
    };

    await expect(recovery.run(target, reboot)).resolves.toBe(true);
    await expect(recovery.run(target, reboot)).resolves.toBe(true);

    timer.advanceTime(24 * 60 * 60 * 1000);

    // Today this would return false without calling reboot; both prior
    // attempts have aged out of the window so the AVD may recover again.
    await expect(recovery.run(target, reboot)).resolves.toBe(true);
    expect(attempts).toBe(3);
  });

  it("does not charge a recovery that was cancelled before touching the emulator (#7545)", async () => {
    let attempts = 0;
    const timer = new FakeTimer();
    const recovery = new BoundedAndroidDeviceReboot(timer, 1);

    await expect(
      recovery.run(target, async () => {
        attempts++;
        return "cancelled";
      }),
    ).resolves.toBe(false);
    expect(attempts).toBe(1);

    // The cancelled attempt must not have spent the budget: a genuine
    // recovery right after it should still be allowed.
    await expect(
      recovery.run(target, async () => {
        attempts++;
      }),
    ).resolves.toBe(true);
    expect(attempts).toBe(2);
  });

  it("clears the tracked budget for a target, e.g. after its AVD is deleted (#7545)", async () => {
    let attempts = 0;
    const timer = new FakeTimer();
    const recovery = new BoundedAndroidDeviceReboot(timer, 1);
    const reboot = async (): Promise<void> => {
      attempts++;
    };

    await expect(recovery.run(target, reboot)).resolves.toBe(true);
    await expect(recovery.run(target, reboot)).resolves.toBe(false);

    recovery.clear(target);

    await expect(recovery.run(target, reboot)).resolves.toBe(true);
    expect(attempts).toBe(2);
  });
});
