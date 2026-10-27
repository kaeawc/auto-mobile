import { describe, expect, test } from "bun:test";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { ExecResult } from "../../../src/models";
import type { BootedDevice } from "../../../src/models";
import {
  createBatteryFaultInjector,
  createDozeFaultInjector,
  createLowPowerFaultInjector,
  createThermalFaultInjector,
  resolvePowerFaultInjector,
} from "../../../src/features/deviceCondition/powerFaultInjectors";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

/** adb joins argv with spaces, so a substring pattern matches the shell command. */
function adbWith(responses: Record<string, string>): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  for (const [pattern, stdout] of Object.entries(responses)) {
    adb.setCommandResponse(pattern, execResult(stdout));
  }
  return adb;
}

const BATTERY_DUMP = "Current Battery Service state:\n  AC powered: true\n  level: 100";
const BATTERY_UNPLUGGED =
  "Current Battery Service state:\n  AC powered: false\n  USB powered: false";

describe("power fault injectors (#14063)", () => {
  test("battery unplug applies, and reset restores a live power source", async () => {
    const adb = adbWith({ "dumpsys battery": BATTERY_DUMP });
    const injector = createBatteryFaultInjector(adb);
    const outcome = await injector.apply("unplug");
    expect(outcome.status).toBe("applied");
    expect(adb.getExecutedCommands()).toContain("shell dumpsys battery unplug");

    expect(outcome.reset).toBeDefined();
    await outcome.reset?.();
    expect(adb.getExecutedCommands()).toContain("shell dumpsys battery reset");
    // Clean read: a powered source is reported again.
    expect(await injector.isClean()).toBe(true);
  });

  test("battery low sets a 15% level while unplugged", async () => {
    const adb = adbWith({ "dumpsys battery": BATTERY_DUMP });
    await createBatteryFaultInjector(adb).apply("low");
    expect(adb.getExecutedCommands()).toContain("shell dumpsys battery unplug");
    expect(adb.getExecutedCommands()).toContain("shell dumpsys battery set level 15");
  });

  test("battery isClean is false while unplugged with no power source", async () => {
    const adb = adbWith({ "dumpsys battery": BATTERY_UNPLUGGED });
    expect(await createBatteryFaultInjector(adb).isClean()).toBe(false);
  });

  test("battery rejects an unknown value before touching the device", async () => {
    const adb = adbWith({ "dumpsys battery": BATTERY_DUMP });
    await expect(createBatteryFaultInjector(adb).apply("explode")).rejects.toThrow(
      /Invalid faults.battery/,
    );
  });

  test("battery reports unsupported when dumpsys returns no battery dump", async () => {
    const adb = adbWith({ "dumpsys battery": "" });
    await expect(createBatteryFaultInjector(adb).apply("unplug")).rejects.toThrow(
      /unsupported on this image/,
    );
  });

  test("lowPower captures the baseline and restores it", async () => {
    const adb = adbWith({ "settings get global low_power": "0" });
    const injector = createLowPowerFaultInjector(adb);
    const outcome = await injector.apply("on");
    expect(adb.getExecutedCommands()).toContain("shell settings put global low_power 1");
    await outcome.reset?.();
    expect(adb.getExecutedCommands()).toContain("shell settings put global low_power 0");
  });

  test("lowPower deletes the setting when the baseline was unset (null)", async () => {
    const adb = adbWith({ "settings get global low_power": "null" });
    const outcome = await createLowPowerFaultInjector(adb).apply("on");
    await outcome.reset?.();
    expect(adb.getExecutedCommands()).toContain("shell settings delete global low_power");
  });

  test("doze probes the verb, forces deep idle, and unforces on reset", async () => {
    const adb = adbWith({
      "dumpsys deviceidle -h": "usage: deviceidle force-idle|unforce",
      "dumpsys deviceidle get deep": "ACTIVE",
    });
    const injector = createDozeFaultInjector(adb);
    const outcome = await injector.apply("on");
    expect(adb.getExecutedCommands()).toContain("shell dumpsys deviceidle force-idle deep");
    await outcome.reset?.();
    expect(adb.getExecutedCommands()).toContain("shell dumpsys deviceidle unforce");
    expect(await injector.isClean()).toBe(true); // ACTIVE, not IDLE
  });

  test("doze reports unsupported when force-idle is absent", async () => {
    const adb = adbWith({ "dumpsys deviceidle -h": "usage: nothing here" });
    await expect(createDozeFaultInjector(adb).apply("on")).rejects.toThrow(
      /unsupported on this image/,
    );
  });

  test("thermal maps severities and resets the override", async () => {
    const adb = adbWith({
      "cmd thermalservice": "thermalservice commands:\n  override-status\n  reset",
      "dumpsys thermalservice": "is status override: false",
    });
    const injector = createThermalFaultInjector(adb);
    await injector.apply("critical");
    expect(adb.getExecutedCommands()).toContain("shell cmd thermalservice override-status 4");
    await injector.apply("throttling");
    expect(adb.getExecutedCommands()).toContain("shell cmd thermalservice override-status 3");
    expect(await injector.isClean()).toBe(true);
  });

  test("thermal reports unsupported when override-status is absent", async () => {
    const adb = adbWith({ "cmd thermalservice": "unknown service" });
    await expect(createThermalFaultInjector(adb).apply("critical")).rejects.toThrow(
      /unsupported on this image/,
    );
  });

  describe("resolvePowerFaultInjector", () => {
    const android: BootedDevice = {
      name: "emulator-5554",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const ios: BootedDevice = { name: "sim", platform: "ios", deviceId: "UDID" };
    const adbFactory = { create: () => new FakeAdbExecutor() };

    test("builds each power-fault injector on Android", () => {
      expect(resolvePowerFaultInjector(android, "faults.battery", { adbFactory })?.key).toBe(
        "faults.battery",
      );
      expect(resolvePowerFaultInjector(android, "faults.lowPower", { adbFactory })?.key).toBe(
        "faults.lowPower",
      );
      expect(resolvePowerFaultInjector(android, "faults.doze", { adbFactory })?.key).toBe(
        "faults.doze",
      );
      expect(resolvePowerFaultInjector(android, "faults.thermal", { adbFactory })?.key).toBe(
        "faults.thermal",
      );
    });

    test("returns undefined for a non-power key and for iOS", () => {
      expect(resolvePowerFaultInjector(android, "rootState", { adbFactory })).toBeUndefined();
      expect(resolvePowerFaultInjector(android, "faults.unknown", { adbFactory })).toBeUndefined();
      expect(resolvePowerFaultInjector(ios, "faults.battery", { adbFactory })).toBeUndefined();
    });
  });
});
