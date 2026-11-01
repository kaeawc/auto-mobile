import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { DeviceConditionRegistry } from "../../../src/features/deviceCondition/DeviceConditionRegistry";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import { OwedResetError } from "../../../src/features/deviceCondition/OwedResetError";
import { deviceConditionInputSchema } from "../../../src/features/deviceCondition/DeviceConditionTypes";
import {
  createReadOnlyFilesystemInjector,
  parseEmulatedStorageMount,
  resolveReadOnlyFilesystemInjector,
} from "../../../src/features/deviceCondition/readOnlyFilesystemInjector";

// Verbatim device captures supplied with the lane brief.
const RW =
  "/dev/fuse on /storage/emulated type fuse (rw,lazytime,nosuid,nodev,noexec,noatime,user_id=0,group_id=0,allow_other)";
const RO =
  "/dev/fuse on /storage/emulated type fuse (ro,lazytime,nosuid,nodev,noexec,noatime,user_id=0,group_id=0,allow_other)";
const result = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (s) => stdout.includes(s),
});
function device() {
  const adb = new FakeAdbExecutor();
  const commands: string[] = [];
  const state = {
    mode: "rw",
    debuggable: "1",
    buildType: "userdebug",
    root: "restarting adbd as root",
    ignoreRo: false,
    ignoreRw: false,
    failRw: false,
    failMount: false,
  };
  let gate: Promise<void> | undefined;
  let entered = (): void => {};
  adb.execute = async (args) => {
    const cmd = args.join(" ");
    commands.push(cmd);
    if (cmd === "shell getprop ro.debuggable") {
      return result(state.debuggable);
    }
    if (cmd === "shell getprop ro.build.type") {
      return result(state.buildType);
    }
    if (cmd === "root") {
      return result(state.root);
    }
    if (cmd === "shell mount") {
      if (state.failMount) {
        throw new Error("mount unreadable");
      }
      return result(state.mode === "ro" ? RO : state.mode === "rw" ? RW : "");
    }
    if (cmd === "shell mount -o remount,ro /storage/emulated" && !state.ignoreRo) {
      state.mode = "ro";
    }
    if (cmd === "shell mount -o remount,rw /storage/emulated") {
      if (state.failRw) {
        throw new Error("rw refused");
      }
      if (!state.ignoreRw) {
        state.mode = "rw";
      }
      if (gate) {
        entered();
        await gate;
        gate = undefined;
      }
    }
    return result("");
  };
  return {
    adb,
    state,
    commands,
    holdReset() {
      let release = (): void => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      return { started, release };
    },
  };
}

describe("read-only shared storage", () => {
  test("parses the exact mount and refuses missing, ambiguous or unrelated lines", () => {
    expect(parseEmulatedStorageMount(RW)).toBe("rw");
    expect(parseEmulatedStorageMount(RO)).toBe("ro");
    expect(parseEmulatedStorageMount(`${RW}\n${RO}`)).toBeUndefined();
    expect(
      parseEmulatedStorageMount(RW.replace("/storage/emulated", "/storage/emulated/0")),
    ).toBeUndefined();
    expect(parseEmulatedStorageMount("")).toBeUndefined();
  });
  test("applies, verifies, resets to rw, and reports clean without files", async () => {
    const d = device();
    const injector = createReadOnlyFilesystemInjector(d.adb);
    expect(await injector.isClean()).toBe(true);
    const outcome = await injector.apply("on");
    expect(outcome.status).toBe("applied");
    expect(outcome.reset).toBeDefined();
    expect(await injector.isClean()).toBe(false);
    await outcome.reset?.();
    expect(d.state.mode).toBe("rw");
    expect(d.commands.slice(-2)).toEqual([
      "shell mount -o remount,rw /storage/emulated",
      "shell mount",
    ]);
    expect(await injector.isClean()).toBe(true);
  });
  test("already ro stays unowned; repeated owned apply keeps the single reset", async () => {
    const d = device();
    const injector = createReadOnlyFilesystemInjector(d.adb);
    d.state.mode = "ro";
    expect(await injector.apply("on")).toMatchObject({ status: "unchanged" });
    expect((await injector.apply("on")).reset).toBeUndefined();
    d.state.mode = "rw";
    const first = await injector.apply("on");
    expect((await injector.apply("on")).reset).toBeUndefined();
    await first.reset?.();
    expect(d.state.mode).toBe("rw");
  });
  test("failed ro readback rolls back to rw", async () => {
    const d = device();
    d.state.ignoreRo = true;
    await expect(createReadOnlyFilesystemInjector(d.adb).apply("on")).rejects.toThrow(/read-back/);
    expect(d.commands).toContain("shell mount -o remount,rw /storage/emulated");
  });
  test("failed rollback hands back an owed reset for retry", async () => {
    const d = device();
    d.state.ignoreRo = true;
    d.state.failRw = true;
    const injector = createReadOnlyFilesystemInjector(d.adb);
    let caught: unknown;
    try {
      await injector.apply("on");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OwedResetError);
    if (!(caught instanceof OwedResetError)) {
      throw new Error("missing owed reset");
    }
    d.state.failRw = false;
    await caught.owedReset();
    expect(await injector.isClean()).toBe(true);
  });
  test("reset failure stays retryable, including successful commands without rw readback", async () => {
    const d = device();
    const outcome = await createReadOnlyFilesystemInjector(d.adb).apply("on");
    d.state.failRw = true;
    await expect(outcome.reset?.()).rejects.toThrow(/rw refused/);
    d.state.failRw = false;
    d.state.ignoreRw = true;
    await expect(outcome.reset?.()).rejects.toThrow(/read-back/);
    d.state.ignoreRw = false;
    await outcome.reset?.();
    expect(d.state.mode).toBe("rw");
  });
  test("non-rootable properties and refused adb root are unsupported before remount", async () => {
    for (const variant of ["debuggable", "user", "root"]) {
      const d = device();
      if (variant === "debuggable") {
        d.state.debuggable = "0";
      }
      if (variant === "user") {
        d.state.buildType = "user";
      }
      if (variant === "root") {
        d.state.root = "adbd cannot run as root in production builds";
      }
      await expect(createReadOnlyFilesystemInjector(d.adb).apply("on")).rejects.toThrow(
        /unsupported/,
      );
      expect(d.commands.some((cmd) => cmd.includes("remount,"))).toBe(false);
    }
  });
  test("missing and unreadable mount tables are not clean and cannot apply", async () => {
    const d = device();
    const injector = createReadOnlyFilesystemInjector(d.adb);
    d.state.mode = "missing";
    expect(await injector.isClean()).toBe(false);
    await expect(injector.apply("on")).rejects.toThrow(/unsupported/);
    d.state.failMount = true;
    expect(await injector.isClean()).toBe(false);
  });
  test("invalid values are rejected by injector and schema", async () => {
    const d = device();
    await expect(createReadOnlyFilesystemInjector(d.adb).apply("off")).rejects.toThrow(
      /Invalid faults.readOnlyFilesystem/,
    );
    expect(d.commands).toEqual([]);
    expect(
      deviceConditionInputSchema.safeParse({ faults: { readOnlyFilesystem: "off" } }).success,
    ).toBe(false);
    for (const value of ["on", "unset"]) {
      expect(
        deviceConditionInputSchema.safeParse({ faults: { readOnlyFilesystem: value } }).success,
      ).toBe(true);
    }
  });
  test("apply waits for reset in flight, then owns a fresh reset", async () => {
    const d = device();
    const injector = createReadOnlyFilesystemInjector(d.adb);
    const first = await injector.apply("on");
    const held = d.holdReset();
    const resetting = first.reset?.();
    await held.started;
    const before = d.commands.length;
    const applying = injector.apply("on");
    await Promise.resolve();
    expect(d.commands.length).toBe(before);
    held.release();
    await resetting;
    const second = await applying;
    expect(second.reset).toBeDefined();
    expect(d.state.mode).toBe("ro");
    await second.reset?.();
    expect(d.state.mode).toBe("rw");
  });
  test("cached resolver supports controller unset and release restoration", async () => {
    const d = device();
    const android: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
    const deps = { adbFactory: { create: () => d.adb }, cache: new Map() };
    const resolve = () =>
      resolveReadOnlyFilesystemInjector(android, "faults.readOnlyFilesystem", deps);
    expect(resolve()).toBe(resolve());
    expect(
      resolveReadOnlyFilesystemInjector(
        { ...android, platform: "ios" },
        "faults.readOnlyFilesystem",
        deps,
      ),
    ).toBeUndefined();
    expect(resolveReadOnlyFilesystemInjector(android, "faults.storage", deps)).toBeUndefined();
    const controller = new DeviceConditionController((key) =>
      resolveReadOnlyFilesystemInjector(android, key, deps),
    );
    await controller.apply({ faults: { readOnlyFilesystem: "on" } });
    await controller.apply({ faults: { readOnlyFilesystem: "on" } });
    expect((await controller.apply({ faults: { readOnlyFilesystem: "unset" } })).active).toEqual(
      [],
    );
    expect(d.state.mode).toBe("rw");
    await controller.apply({ faults: { readOnlyFilesystem: "on" } });
    expect((await controller.restore()).verifiedClean).toBe(true);
    expect(d.state.mode).toBe("rw");
  });
  test("session close and device release restore shared storage through the registry", async () => {
    const d = device();
    const android: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };
    const deps = { adbFactory: { create: () => d.adb }, cache: new Map() };
    const registry = new DeviceConditionRegistry(
      (_owner, key) => resolveReadOnlyFilesystemInjector(android, key, deps),
      new FakeTimer(),
    );
    const owner = { deviceId: android.deviceId, sessionUuid: "session-1", device: android };
    await registry.apply(owner, { faults: { readOnlyFilesystem: "on" } });
    expect(await registry.restoreSession(owner.sessionUuid)).toEqual([true]);
    expect(d.state.mode).toBe("rw");
    await registry.apply(owner, { faults: { readOnlyFilesystem: "on" } });
    expect(await registry.restore(owner)).toBe(true);
    expect(d.state.mode).toBe("rw");
  });
});
