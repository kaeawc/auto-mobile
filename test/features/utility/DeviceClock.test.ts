import { describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { ActionableError } from "../../../src/models/ActionableError";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import {
  AndroidDeviceClockAdapter,
  MAX_DEVICE_CLOCK_ADVANCE_MS,
  MIN_DEVICE_CLOCK_INSTANT_MS,
  MAX_DEVICE_CLOCK_INSTANT_MS,
  writeDeviceClock,
  type DeviceClockRestoreSlot,
  type DeviceClockRestoreState,
  type SetDeviceClockInput,
} from "../../../src/features/utility/DeviceClock";
import { getDeviceStateSchema, setDeviceStateSchema } from "../../../src/server/utilityTools";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeDeviceClockAdapter } from "../../fakes/FakeDeviceClockAdapter";
import { FakeTimer } from "../../fakes/FakeTimer";

const android: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const instant = "2030-01-01T00:00:00Z";
const response = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value) => stdout.includes(value),
});
function harness() {
  const adapter = new FakeDeviceClockAdapter();
  const timer = new FakeTimer();
  timer.setCurrentTime(Date.parse("2026-10-01T12:34:56Z"));
  let recorded: DeviceClockRestoreState | undefined;
  const slot: DeviceClockRestoreSlot = {
    get: () => recorded,
    record: (value) => {
      recorded = value;
    },
    clear: () => {
      recorded = undefined;
    },
  };
  const invalidations: string[] = [];
  const dependencies = {
    hostClock: timer,
    invalidate: (deviceId: string) => {
      invalidations.push(deviceId);
    },
  };
  const write = (input: SetDeviceClockInput) =>
    writeDeviceClock(android, adapter, input, slot, dependencies);
  return { adapter, timer, slot, invalidations, dependencies, write };
}
describe("device clock", () => {
  test("set records restoration ownership before clock mutation, and invalidates caches", async () => {
    const h = harness();
    const result = await h.write({ mode: "set", instant });
    expect(h.slot.get()).toEqual({
      initialAutomaticTime: 1,
      rootedByUs: true,
      clockChangedByUs: true,
    });
    expect(h.adapter.calls).toEqual([
      "root",
      "probeRoot",
      "readInstant",
      "readAuto",
      "auto:0",
      `instant:${Date.parse(instant)}`,
      "readInstant",
      "readAuto",
    ]);
    expect(result).toMatchObject({
      verified: true,
      outcome: "changed",
      automaticTime: false,
      appliedInstant: "2030-01-01T00:00:00.000Z",
    });
    expect(h.invalidations).toEqual([android.deviceId]);
  });
  test("advance derives the target from device time, truncates seconds and invalidates", async () => {
    const h = harness();
    const result = await h.write({ mode: "advance", byMs: 2500 });
    expect(result).toMatchObject({
      verified: true,
      instant: "2001-01-01T00:00:02.000Z",
      requestedInstant: "2001-01-01T00:00:02.500Z",
    });
    expect(h.invalidations).toEqual([android.deviceId]);
  });
  test("a no-op advance cannot be verified by tolerance alone", async () => {
    class NoOpAdapter extends FakeDeviceClockAdapter {
      override async setInstantMs() {}
    }
    const result = await writeDeviceClock(android, new NoOpAdapter(), {
      mode: "advance",
      byMs: 1000,
    });
    expect(result.verified).toBe(false);
  });
  test("set within tolerance reports unchanged without recording or writing clock state", async () => {
    const h = harness();
    const result = await h.write({ mode: "set", instant: "2001-01-01T00:00:01Z" });
    expect(result.outcome).toBe("unchanged");
    expect(result.verified).toBeUndefined();
    expect(h.slot.get()).toBeUndefined();
    expect(h.invalidations).toEqual([]);
    expect(
      h.adapter.calls.some((call) => call.startsWith("auto:") || call.startsWith("instant:")),
    ).toBe(false);
  });
  test.each([0, 1] as const)(
    "reset restores host time and recorded auto_time=%s, then unroots",
    async (value) => {
      const h = harness();
      h.adapter.automaticTime = value;
      await h.write({ mode: "set", instant });
      expect((await h.write({ mode: "reset" })).verified).toBe(true);
      expect(h.adapter.instantMs).toBe(h.timer.now());
      expect(h.adapter.automaticTime).toBe(value);
      expect(h.slot.get()).toBeUndefined();
      expect(h.adapter.calls.at(-1)).toBe("unroot");
      expect(h.invalidations).toEqual([android.deviceId, android.deviceId]);
    },
  );
  test("reset without a slot recovers host time and auto_time=1", async () => {
    const h = harness();
    h.adapter.automaticTime = 0;
    expect((await h.write({ mode: "reset" })).verified).toBe(true);
    expect(h.adapter.instantMs).toBe(h.timer.now());
    expect(h.adapter.automaticTime).toBe(1);
    expect(h.slot.get()).toBeUndefined();
    expect(h.invalidations).toEqual([android.deviceId]);
  });
  test("restore does not unroot an already-root adbd", async () => {
    const h = harness();
    h.adapter.rootedByUs = false;
    await h.write({ mode: "set", instant });
    await h.write({ mode: "reset" });
    expect(h.adapter.calls).not.toContain("unroot");
  });
  test("unroot failure is logged best-effort and clock restoration still succeeds", async () => {
    class UnrootFailure extends FakeDeviceClockAdapter {
      override async unroot() {
        throw new Error("unroot refused");
      }
    }
    const h = harness();
    const result = await writeDeviceClock(
      android,
      new UnrootFailure(),
      { mode: "reset" },
      h.slot,
      h.dependencies,
    );
    expect(result.verified).toBe(true);
    expect(h.slot.get()).toBeUndefined();
  });
  test("failed restore and newly refused root keep the slot pending", async () => {
    const h = harness();
    await h.write({ mode: "set", instant });
    h.adapter.writeError = new Error("date failed");
    expect((await h.write({ mode: "reset" })).verified).toBe(false);
    expect(h.slot.get()).toBeDefined();
    h.adapter.root = false;
    h.adapter.calls.length = 0;
    expect(await h.write({ mode: "reset" })).toMatchObject({ supported: true, verified: false });
    expect(h.slot.get()).toBeDefined();
    expect(h.adapter.calls).toEqual(["root"]);
  });
  for (const mode of ["set", "advance", "reset"] as const) {
    const input: SetDeviceClockInput =
      mode === "set" ? { mode, instant } : mode === "advance" ? { mode, byMs: 1000 } : { mode };
    test.each([
      { ...android, deviceId: "physical-android" },
      {
        platform: "ios" as const,
        name: "simulator",
        deviceId: "12345678-1234-1234-1234-123456789ABC",
      },
      { platform: "ios" as const, name: "physical", deviceId: "00008120-0012345678901234" },
    ])(`${mode} unsupported target $name issues no commands`, async (device) => {
      const adapter = new FakeDeviceClockAdapter();
      expect(await writeDeviceClock(device, adapter, input)).toMatchObject({
        supported: false,
        capability: "unsupported",
      });
      expect(adapter.calls).toEqual([]);
    });
    test(`${mode} Play Store root refusal issues only root probes, no settings/date commands`, async () => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("shell id", response("uid=2000(shell)"));
      adb.setCommandResponse("shell getprop ro.debuggable", response("0"));
      adb.setCommandError("root", new Error("Root refused"));
      expect(
        await writeDeviceClock(android, new AndroidDeviceClockAdapter(adb), input),
      ).toMatchObject({ supported: false, verified: false });
      expect(
        adb
          .getExecutedCommands()
          .every((command) =>
            ["shell id", "shell getprop ro.debuggable", "root", "wait-for-device"].includes(
              command,
            ),
          ),
      ).toBe(true);
    });
  }
  test.each([
    { mode: "set", instant: "bad" },
    { mode: "set", instant: "2026-01-01T00:00:00" },
    { mode: "set", instant: "2026-02-30T00:00:00Z" },
    { mode: "set", instant: "1999-12-31T23:59:59Z" },
    { mode: "set", instant: "2100-01-01T00:00:01Z" },
    { mode: "advance", byMs: 0 },
    { mode: "advance", byMs: 500 },
    { mode: "advance", byMs: 999 },
    { mode: "advance", byMs: -1 },
    { mode: "advance", byMs: 1.5 },
    { mode: "advance", byMs: MAX_DEVICE_CLOCK_ADVANCE_MS + 1 },
    { mode: "unknown" },
  ])("invalid $mode input throws before any field or command", async (input) => {
    const h = harness();
    const adb = new FakeAdbExecutor();
    const state = new DeviceState(android, {
      clockAdapter: h.adapter,
      adbFactory: new FakeAdbClientFactory(adb),
      timer: h.timer,
    });
    await expect(
      state.setState({ doNotDisturb: { enabled: true }, clock: input as SetDeviceClockInput }),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(h.adapter.calls).toEqual([]);
    expect(setDeviceStateSchema.safeParse({ clock: input }).success).toBe(false);
  });
  test.each([MIN_DEVICE_CLOCK_INSTANT_MS, MAX_DEVICE_CLOCK_INSTANT_MS])(
    "set accepts inclusive window boundary %s",
    async (boundary) => {
      const h = harness();
      expect(
        (await h.write({ mode: "set", instant: new Date(boundary).toISOString() })).verified,
      ).toBe(true);
    },
  );
  test.each([MAX_DEVICE_CLOCK_INSTANT_MS, MIN_DEVICE_CLOCK_INSTANT_MS - 2000])(
    "advance outside window %s rejects before root and other field mutation",
    async (current) => {
      const h = harness();
      h.adapter.instantMs = current;
      const adb = new FakeAdbExecutor();
      const state = new DeviceState(android, {
        clockAdapter: h.adapter,
        adbFactory: new FakeAdbClientFactory(adb),
        timer: h.timer,
      });
      await expect(
        state.setState({ doNotDisturb: { enabled: true }, clock: { mode: "advance", byMs: 1000 } }),
      ).rejects.toBeInstanceOf(ActionableError);
      expect(h.adapter.calls).toEqual(["probeRoot", "readInstant"]);
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );
  test("advance to upper boundary is allowed", async () => {
    const h = harness();
    h.adapter.instantMs = MAX_DEVICE_CLOCK_INSTANT_MS - 1000;
    expect((await h.write({ mode: "advance", byMs: 1000 })).verified).toBe(true);
  });
  test.each([
    { connectivity: {} },
    { location: { mode: "static" as const, latitude: 100, longitude: 0 } },
    { networkCondition: { profile: "offline" as const, delayMs: 200 } },
    { networkCondition: { profile: "3g" as const, expiresInSeconds: -1 } },
  ])("invalid other field rejects combined request before applying clock or DND", async (other) => {
    const h = harness();
    const adb = new FakeAdbExecutor();
    const state = new DeviceState(android, {
      timer: h.timer,
      clockAdapter: h.adapter,
      adbFactory: new FakeAdbClientFactory(adb),
    });
    await expect(
      state.setState({
        ...other,
        doNotDisturb: { enabled: true },
        clock: { mode: "set", instant },
      }),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(h.adapter.calls).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });
  test("schema accepts offsets and clock read selection", () => {
    expect(
      setDeviceStateSchema.safeParse({
        clock: { mode: "set", instant: "2001-01-01T01:00:00+01:00" },
      }).success,
    ).toBe(true);
    expect(getDeviceStateSchema.safeParse({ include: ["clock"] }).success).toBe(true);
  });
  test("get reads physical Android without root and iOS without commands", async () => {
    const h = harness();
    expect(
      (
        await new DeviceState(
          { ...android, deviceId: "physical" },
          { clockAdapter: h.adapter },
        ).getState(["clock"])
      ).clock?.readBack,
    ).toBe(true);
    expect(h.adapter.calls).toEqual(["readInstant", "readAuto"]);
    h.adapter.calls.length = 0;
    expect(
      (
        await new DeviceState(
          { ...android, platform: "ios" },
          { clockAdapter: h.adapter },
        ).getState(["clock"])
      ).unsupported,
    ).toEqual(["clock"]);
    expect(h.adapter.calls).toEqual([]);
  });
  test("adapter uses bounded epoch commands and probes id before root", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell id", [
      response("uid=2000(shell)"),
      response("uid=0(root)"),
    ]);
    const adapter = new AndroidDeviceClockAdapter(adb);
    expect(await adapter.ensureRoot()).toEqual({ success: true, rootedByUs: true });
    await adapter.setInstantMs(Date.parse(instant));
    await adapter.unroot();
    expect(adb.getExecutedCommands()).toEqual([
      "shell id",
      "root",
      "wait-for-device",
      "shell id",
      `shell date -u @${Date.parse(instant) / 1000}`,
      "unroot",
      "wait-for-device",
    ]);
  });
  test("already-root adbd skips root/restart, and unroot returned errors are surfaced to best-effort logging", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell id", response("uid=0(root)"));
    const adapter = new AndroidDeviceClockAdapter(adb);
    expect(await adapter.ensureRoot()).toEqual({ success: true, rootedByUs: false });
    expect(adb.getExecutedCommands()).toEqual(["shell id"]);
    adb.setCommandResponse("unroot", {
      ...response(""),
      stderr: "unroot failed",
      error: new Error("unroot failed"),
    });
    await expect(adapter.unroot()).rejects.toBeInstanceOf(ActionableError);
    expect(adb.getExecutedCommands()).not.toContain("wait-for-device");
  });
  test("invalid device epoch is a typed field failure with no clock mutation", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell id", response("uid=0(root)"));
    adb.setCommandResponse("shell date +%s", response(""));
    const result = await writeDeviceClock(android, new AndroidDeviceClockAdapter(adb), {
      mode: "advance",
      byMs: 1000,
    });
    expect(result).toMatchObject({ supported: true, verified: false });
    expect(adb.getExecutedCommands()).toEqual(["shell id", "shell date +%s"]);
  });
  test("removal aborts an in-flight command and prevents subsequent clock commands", async () => {
    const adb = new FakeAdbExecutor();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const execute = adb.executeCommand.bind(adb);
    const command = spyOn(adb, "executeCommand").mockImplementation(async (...args) => {
      const result = await execute(...args);
      started.resolve();
      await finish.promise;
      return result;
    });
    try {
      const adapter = new AndroidDeviceClockAdapter(adb, controller.signal);
      const unroot = adapter.unroot();
      await started.promise;
      controller.abort();
      finish.resolve();
      await expect(unroot).rejects.toThrow();
      expect(adb.getExecutedCommands()).toEqual(["unroot"]);
      await expect(adapter.setInstantMs(Date.parse(instant))).rejects.toThrow();
      expect(adb.getExecutedCommands()).toEqual(["unroot"]);
    } finally {
      finish.resolve();
      command.mockRestore();
    }
  });
  test("mismatched read-back and command errors return typed failures", async () => {
    const h = harness();
    h.adapter.readOffsetMs = 5000;
    expect((await h.write({ mode: "set", instant })).verified).toBe(false);
    h.adapter.writeError = new Error("date rejected");
    expect(await h.write({ mode: "set", instant: "2031-01-01T00:00:00Z" })).toMatchObject({
      supported: true,
      verified: false,
      error: expect.stringContaining("date rejected"),
    });
  });
});
