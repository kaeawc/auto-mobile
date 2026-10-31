import { describe, expect, test } from "bun:test";
import {
  AndroidDeviceTraitsReader,
  DEVICE_TRAITS_CACHE_TTL_MS,
  isAutomotive,
  isWatch,
  parseAndroidEmulatorFlag,
  parseLeanbackFeature,
  parseTraitFormFactor,
  readAndroidEmulatorFlag,
} from "../../../src/utils/android-cmdline-tools/deviceTraits";
import { createExecResult } from "../../../src/utils/execResult";
import type {
  AdbCommandRunner,
  AdbExecuteOptions,
} from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

function samsungAdb(): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("0\n", ""));
  adb.setCommandResponse("getprop ro.product.model", createExecResult("SM-S921B\n", ""));
  adb.setCommandResponse("getprop ro.build.version.sdk", createExecResult("34\n", ""));
  adb.setCommandResponse("getprop ro.product.cpu.abi", createExecResult("arm64-v8a\n", ""));
  adb.setCommandResponse("getprop ro.product.manufacturer", createExecResult("samsung\n", ""));
  adb.setCommandResponse("getprop ro.product.brand", createExecResult("samsung\n", ""));
  return adb;
}

const qemuReads = (adb: FakeAdbExecutor): number =>
  adb.getExecutedCommands().filter((command) => command.includes("ro.kernel.qemu")).length;

describe("parseAndroidEmulatorFlag", () => {
  test.each([
    ["1", true],
    ["1\n", true],
    ["0", false],
    ["", false],
    ["\n", false],
    ["garbage", null],
  ] as const)("%j -> %p", (raw, expected) => {
    expect(parseAndroidEmulatorFlag(raw)).toBe(expected);
  });

  test("readAndroidEmulatorFlag asks the runner for ro.kernel.qemu", async () => {
    const asked: string[] = [];
    const flag = await readAndroidEmulatorFlag(async (prop) => {
      asked.push(prop);
      return "1";
    });
    expect(flag).toBe(true);
    expect(asked).toEqual(["ro.kernel.qemu"]);
  });
});

describe("AndroidDeviceTraitsReader", () => {
  test("reads manufacturer, brand and the existing identifying props", async () => {
    const reader = new AndroidDeviceTraitsReader(new FakeTimer());

    const traits = await reader.read(samsungAdb(), "R5CW123");

    expect(traits).toEqual({
      isEmulator: false,
      model: "SM-S921B",
      sdk: 34,
      abi: "arm64-v8a",
      manufacturer: "samsung",
      brand: "samsung",
      skin: null,
      formFactor: null,
    });
  });

  test("never retries a getprop and bounds each one", async () => {
    const options: Array<AdbExecuteOptions | undefined> = [];
    const adb = samsungAdb();
    const runner: AdbCommandRunner = {
      executeCommand: (command, option) => {
        options.push(option);
        return adb.executeCommand(command, option);
      },
    };

    await new AndroidDeviceTraitsReader(new FakeTimer()).read(runner, "R5CW123", {
      timeoutMs: 750,
    });

    expect(options).toHaveLength(7);
    expect(options.every((option) => option?.noRetry === true && option.timeoutMs === 750)).toBe(
      true,
    );
  });

  test("reads each device once while its cached read is fresh", async () => {
    const timer = new FakeTimer();
    const reader = new AndroidDeviceTraitsReader(timer);
    const adb = samsungAdb();

    await reader.read(adb, "R5CW123");
    timer.advanceTime(DEVICE_TRAITS_CACHE_TTL_MS - 1);
    await reader.read(adb, "R5CW123");

    expect(qemuReads(adb)).toBe(1);
  });

  test("shares one in-flight read between concurrent callers", async () => {
    const reader = new AndroidDeviceTraitsReader(new FakeTimer());
    const adb = samsungAdb();

    const [first, second] = await Promise.all([
      reader.read(adb, "R5CW123"),
      reader.read(adb, "R5CW123"),
    ]);

    expect(second).toBe(first);
    expect(qemuReads(adb)).toBe(1);
  });

  test("re-reads after the TTL so a reused serial reports the new device", async () => {
    const timer = new FakeTimer();
    const reader = new AndroidDeviceTraitsReader(timer);
    const adb = samsungAdb();

    await reader.read(adb, "emulator-5554");
    timer.advanceTime(DEVICE_TRAITS_CACHE_TTL_MS);
    adb.setCommandResponse("getprop ro.product.model", createExecResult("Pixel 9\n", ""));
    const traits = await reader.read(adb, "emulator-5554");

    expect(qemuReads(adb)).toBe(2);
    expect(traits.model).toBe("Pixel 9");
  });

  test("caches per device", async () => {
    const reader = new AndroidDeviceTraitsReader(new FakeTimer());
    const adb = samsungAdb();

    await reader.read(adb, "R5CW123");
    await reader.read(adb, "R5CW456");

    expect(qemuReads(adb)).toBe(2);
  });

  test("forget drops a cached read", async () => {
    const reader = new AndroidDeviceTraitsReader(new FakeTimer());
    const adb = samsungAdb();

    await reader.read(adb, "R5CW123");
    reader.forget("R5CW123");
    await reader.read(adb, "R5CW123");

    expect(qemuReads(adb)).toBe(2);
  });

  test("a failed emulator-flag read rejects and is not cached", async () => {
    const reader = new AndroidDeviceTraitsReader(new FakeTimer());
    const adb = samsungAdb();
    adb.setCommandError("getprop ro.kernel.qemu", new Error("device offline"));

    await expect(reader.read(adb, "R5CW123")).rejects.toThrow("device offline");

    const recovered = samsungAdb();
    expect((await reader.read(recovered, "R5CW123")).manufacturer).toBe("samsung");
  });

  test("a failed descriptive prop leaves only that field null", async () => {
    const reader = new AndroidDeviceTraitsReader(new FakeTimer());
    const adb = samsungAdb();
    adb.setCommandError("getprop ro.product.brand", new Error("timed out"));

    const traits = await reader.read(adb, "R5CW123");

    expect(traits.brand).toBeNull();
    expect(traits.manufacturer).toBe("samsung");
  });

  test("empty props read as null and an unparsable sdk as null", async () => {
    const reader = new AndroidDeviceTraitsReader(new FakeTimer());
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("1\n", ""));
    adb.setCommandResponse("getprop ro.build.version.sdk", createExecResult("REL\n", ""));

    const traits = await reader.read(adb, "emulator-5554");

    expect(traits).toEqual({
      isEmulator: true,
      model: null,
      sdk: null,
      abi: null,
      manufacturer: null,
      brand: null,
      skin: null,
      formFactor: null,
    });
  });

  test.each([
    ["emulator,automotive\n", "automotive"],
    ["watch\n", "watch"],
    ["tv,nosdcard\n", "tv"],
    ["nosdcard\n", null],
    ["\n", null],
  ] as const)("ro.build.characteristics %j reads as form factor %p", async (raw, expected) => {
    const adb = samsungAdb();
    adb.setCommandResponse("getprop ro.build.characteristics", createExecResult(raw, ""));

    const traits = await new AndroidDeviceTraitsReader(new FakeTimer()).read(adb, "emulator-5554");

    expect(traits.formFactor).toBe(expected);
  });

  test.each([
    ["true\n", "tv"],
    ["false\n", null],
  ] as const)("emulator leanback feature %j reads as form factor %p", async (raw, expected) => {
    const timer = new FakeTimer();
    const adb = samsungAdb();
    adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("1\n", ""));
    adb.setCommandResponse("getprop ro.build.characteristics", createExecResult("emulator", ""));
    adb.setCommandResponse("pm has-feature android.software.leanback", createExecResult(raw, ""));
    const options: Array<AdbExecuteOptions | undefined> = [];
    const runner: AdbCommandRunner = {
      executeCommand: (command, option) => {
        options.push(option);
        return adb.executeCommand(command, option);
      },
    };

    const traits = await new AndroidDeviceTraitsReader(timer).read(runner, "emulator-5554", {
      timeoutMs: 750,
    });

    expect(traits.formFactor).toBe(expected);
    expect(adb.getExecutedCommands()).toContain("shell pm has-feature android.software.leanback");
    expect(options).toHaveLength(8);
    expect(options.every((option) => option?.noRetry === true && option.timeoutMs === 750)).toBe(
      true,
    );
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("physical handhelds never probe the leanback feature", async () => {
    const adb = samsungAdb();
    adb.setCommandResponse(
      "getprop ro.build.characteristics",
      createExecResult("tablet,nosdcard", ""),
    );

    const traits = await new AndroidDeviceTraitsReader(new FakeTimer()).read(adb, "R5CW123");

    expect(traits.formFactor).toBeNull();
    expect(adb.getExecutedCommands().some((command) => command.includes("pm has-feature"))).toBe(
      false,
    );
  });

  test.each(["automotive", "watch", "tv"] as const)(
    "emulator characteristics %s win without a leanback probe",
    async (formFactor) => {
      const adb = samsungAdb();
      adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("1", ""));
      adb.setCommandResponse("getprop ro.build.characteristics", createExecResult(formFactor, ""));

      const traits = await new AndroidDeviceTraitsReader(new FakeTimer()).read(
        adb,
        "emulator-5554",
      );

      expect(traits.formFactor).toBe(formFactor);
      expect(adb.getExecutedCommands().some((command) => command.includes("pm has-feature"))).toBe(
        false,
      );
    },
  );

  test("a failed leanback probe leaves the form factor null without failing the read", async () => {
    const timer = new FakeTimer();
    const adb = samsungAdb();
    adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("1", ""));
    adb.setCommandResponse("getprop ro.build.characteristics", createExecResult("emulator", ""));
    adb.setCommandError("pm has-feature android.software.leanback", new Error("timed out"));

    const traits = await new AndroidDeviceTraitsReader(timer).read(adb, "emulator-5554");

    expect(traits).toMatchObject({ isEmulator: true, formFactor: null, manufacturer: "samsung" });
    expect(adb.getExecutedCommands()).toContain("shell pm has-feature android.software.leanback");
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("a failed ro.build.characteristics read leaves the form factor null without failing the read", async () => {
    const adb = samsungAdb();
    const runner: AdbCommandRunner = {
      executeCommand: (command, option) =>
        command.includes("ro.build.characteristics")
          ? Promise.reject(new Error("device offline"))
          : adb.executeCommand(command, option),
    };

    const traits = await new AndroidDeviceTraitsReader(new FakeTimer()).read(runner, "R5CW123");

    expect(traits).toMatchObject({ isEmulator: false, formFactor: null });
  });
});

describe("parseLeanbackFeature", () => {
  test.each([
    ["true\n", "tv"],
    ["false\n", null],
    ["", null],
    [null, null],
  ] as const)("%j -> %p", (raw, expected) => {
    expect(parseLeanbackFeature(raw)).toBe(expected);
  });
});

describe("parseTraitFormFactor", () => {
  test.each([
    ["emulator,automotive", "automotive"],
    ["automotive", "automotive"],
    [" Watch ", "watch"],
    ["emulator, watch", "watch"],
    ["tv", "tv"],
    ["emulator, TV ,nosdcard", "tv"],
    ["tablet,nosdcard", null],
    ["", null],
    [null, null],
  ] as const)("%j -> %p", (raw, expected) => {
    expect(parseTraitFormFactor(raw)).toBe(expected);
  });

  test("matches whole characteristics, not substrings", () => {
    expect(parseTraitFormFactor("watchface,automotiveish")).toBeNull();
    expect(parseTraitFormFactor("tvout,smarttv")).toBeNull();
  });

  test("the gates are positive-match only", () => {
    expect(isAutomotive({ formFactor: "automotive" })).toBe(true);
    expect(isAutomotive({ formFactor: "watch" })).toBe(false);
    expect(isAutomotive({ formFactor: "tv" })).toBe(false);
    expect(isAutomotive({ formFactor: null })).toBe(false);
    expect(isAutomotive(undefined)).toBe(false);
    expect(isWatch({ formFactor: "watch" })).toBe(true);
    expect(isWatch({ formFactor: "tv" })).toBe(false);
    expect(isWatch({})).toBe(false);
    expect(isWatch(undefined)).toBe(false);
  });
});
