import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { AndroidEmulatorClient } from "../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { AdbClient } from "../../../src/utils/android-cmdline-tools/AdbClient";
import { ExecResult } from "../../../src/models";

describe("AndroidEmulatorClient wakeAndUnlock", () => {
  let emulatorClient: AndroidEmulatorClient;
  let executedCommands: string[] = [];
  let mockWakefulness: "Awake" | "Asleep" | "Dozing" | null = "Asleep";
  let adbGetWakefulnessSpy: ReturnType<typeof spyOn>;
  let adbExecuteCommandSpy: ReturnType<typeof spyOn>;

  const createExecResult = (stdout: string, stderr: string = ""): ExecResult => ({
    stdout,
    stderr,
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  });

  const mockExecAsync = async (_command: string): Promise<ExecResult> => {
    return createExecResult("", "");
  };

  beforeEach(() => {
    executedCommands = [];
    mockWakefulness = "Asleep";

    emulatorClient = new AndroidEmulatorClient(mockExecAsync, null);

    // Spy on AdbClient methods
    adbGetWakefulnessSpy = spyOn(AdbClient.prototype, "getWakefulness").mockImplementation(async () => {
      const result = mockWakefulness;
      // After first call, simulate device becoming awake
      if (mockWakefulness !== "Awake") {
        mockWakefulness = "Awake";
      }
      return result;
    });

    adbExecuteCommandSpy = spyOn(AdbClient.prototype, "executeCommand").mockImplementation(async (command: string) => {
      executedCommands.push(command);
      return createExecResult("", "");
    });
  });

  afterEach(() => {
    // Restore spies to avoid leaking into other tests
    adbGetWakefulnessSpy.mockRestore();
    adbExecuteCommandSpy.mockRestore();
  });

  test("should wake device and dismiss keyguard when device is Asleep", async () => {
    mockWakefulness = "Asleep";
    const device = { name: "test-avd", platform: "android" as const, deviceId: "emulator-5554" };

    // Access the private method using bracket notation for testing
    const wakeAndUnlock = (emulatorClient as any).wakeAndUnlock.bind(emulatorClient);
    await wakeAndUnlock(device);

    // Verify getWakefulness was called
    expect(adbGetWakefulnessSpy).toHaveBeenCalled();

    // Verify KEYCODE_WAKEUP was sent since device was Asleep
    expect(executedCommands.some(cmd => cmd.includes("KEYCODE_WAKEUP"))).toBe(true);

    // Verify keyguard was dismissed
    expect(executedCommands.some(cmd => cmd.includes("wm dismiss-keyguard"))).toBe(true);
  });

  test("should wake device and dismiss keyguard when device is Dozing", async () => {
    mockWakefulness = "Dozing";
    const device = { name: "test-avd", platform: "android" as const, deviceId: "emulator-5554" };

    const wakeAndUnlock = (emulatorClient as any).wakeAndUnlock.bind(emulatorClient);
    await wakeAndUnlock(device);

    // Verify KEYCODE_WAKEUP was sent since device was Dozing
    expect(executedCommands.some(cmd => cmd.includes("KEYCODE_WAKEUP"))).toBe(true);

    // Verify keyguard was dismissed
    expect(executedCommands.some(cmd => cmd.includes("wm dismiss-keyguard"))).toBe(true);
  });

  test("should skip KEYCODE_WAKEUP when device is already Awake", async () => {
    mockWakefulness = "Awake";
    const device = { name: "test-avd", platform: "android" as const, deviceId: "emulator-5554" };

    const wakeAndUnlock = (emulatorClient as any).wakeAndUnlock.bind(emulatorClient);
    await wakeAndUnlock(device);

    // Verify KEYCODE_WAKEUP was NOT sent since device was already Awake
    expect(executedCommands.some(cmd => cmd.includes("KEYCODE_WAKEUP"))).toBe(false);

    // Verify keyguard was still dismissed (always dismiss to be safe)
    expect(executedCommands.some(cmd => cmd.includes("wm dismiss-keyguard"))).toBe(true);
  });

  test("should handle errors gracefully without throwing", async () => {
    mockWakefulness = "Asleep";
    const device = { name: "test-avd", platform: "android" as const, deviceId: "emulator-5554" };

    // Make executeCommand throw an error
    adbExecuteCommandSpy.mockImplementation(async () => {
      throw new Error("Simulated ADB error");
    });

    const wakeAndUnlock = (emulatorClient as any).wakeAndUnlock.bind(emulatorClient);

    // Should not throw
    await expect(wakeAndUnlock(device)).resolves.toBeUndefined();
  });

  test("should still dismiss keyguard when wakefulness check returns null", async () => {
    mockWakefulness = null;
    const device = { name: "test-avd", platform: "android" as const, deviceId: "emulator-5554" };

    const wakeAndUnlock = (emulatorClient as any).wakeAndUnlock.bind(emulatorClient);
    await wakeAndUnlock(device);

    // When wakefulness is null (unknown), should still try to wake the device
    expect(executedCommands.some(cmd => cmd.includes("KEYCODE_WAKEUP"))).toBe(true);

    // Verify keyguard was dismissed
    expect(executedCommands.some(cmd => cmd.includes("wm dismiss-keyguard"))).toBe(true);
  });
});
