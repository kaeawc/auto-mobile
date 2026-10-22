import { describe, expect, test } from "bun:test";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { OwedResetError } from "../../../src/features/deviceCondition/OwedResetError";
import {
  ROOT_ARTIFACT_PATHS,
  createRootStateInjector,
  resolveRootStateInjector,
} from "../../../src/features/deviceCondition/rootStateInjector";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

function adbWith(responses: Record<string, string>): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  for (const [pattern, stdout] of Object.entries(responses)) {
    adb.setCommandResponse(pattern, execResult(stdout));
  }
  return adb;
}

const ROOTABLE = {
  "getprop ro.debuggable": "1",
  "getprop ro.build.type": "userdebug",
  getenforce: "Enforcing",
  remount: "remount succeeded",
};

describe("rootState injector (#14060)", () => {
  test("refuses a production (Play) image with guidance toward real root", async () => {
    const adb = adbWith({ "getprop ro.debuggable": "0", "getprop ro.build.type": "user" });
    await expect(createRootStateInjector(adb).apply("rooted-detectable")).rejects.toThrow(
      /non-Play image[\s\S]*#14070/,
    );
    expect(adb.getExecutedCommands().some((c) => c.includes("remount"))).toBe(false);
  });

  test("rejects an unknown value before touching the device", async () => {
    const adb = adbWith(ROOTABLE);
    await expect(createRootStateInjector(adb).apply("god-mode")).rejects.toThrow(
      /Invalid rootState/,
    );
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("applies: roots, remounts, goes permissive, and plants every artifact", async () => {
    const adb = adbWith(ROOTABLE);
    const outcome = await createRootStateInjector(adb).apply("rooted-detectable");
    expect(outcome.status).toBe("applied");
    const commands = adb.getExecutedCommands();
    expect(commands.indexOf("root")).toBeLessThan(commands.indexOf("remount"));
    expect(commands).toContain("shell setenforce 0");
    for (const path of ROOT_ARTIFACT_PATHS) {
      expect(commands.some((c) => c.includes(`> ${path}`))).toBe(true);
    }
    expect(commands.some((c) => c.includes("chmod 06755 /system/xbin/su"))).toBe(true);
  });

  test("a remount that leaves /system read-only explains how to boot writable", async () => {
    const adb = adbWith({ ...ROOTABLE, remount: "remount failed: Read-only file system (verity)" });
    await expect(createRootStateInjector(adb).apply("rooted-detectable")).rejects.toThrow(
      /-writable-system/,
    );
  });

  test("reset removes artifacts, restores SELinux and unroots", async () => {
    const adb = adbWith(ROOTABLE);
    const outcome = await createRootStateInjector(adb).apply("rooted-detectable");
    await outcome.reset?.();
    const commands = adb.getExecutedCommands();
    expect(commands.some((c) => c.startsWith("shell rm -f ") && c.includes("Superuser.apk"))).toBe(
      true,
    );
    expect(commands).toContain("shell setenforce 1");
    expect(commands).toContain("unroot");
  });

  test("a failure while planting rolls the device back and rethrows", async () => {
    const adb = adbWith(ROOTABLE);
    adb.setCommandError("chmod", new Error("Read-only file system"));
    await expect(createRootStateInjector(adb).apply("rooted-detectable")).rejects.toThrow();
    expect(adb.getExecutedCommands()).toContain("unroot");
  });

  test("isClean is false while artifacts exist and true once they are gone", async () => {
    const dirty = adbWith({ ...ROOTABLE, "ls /system/xbin/su": "/system/xbin/su" });
    expect(await createRootStateInjector(dirty).isClean()).toBe(false);
    const clean = adbWith({ ...ROOTABLE, "ls /system/xbin/su": "" });
    expect(await createRootStateInjector(clean).isClean()).toBe(true);
  });

  test("resolver only serves rootState on Android", () => {
    const android: BootedDevice = { name: "e", platform: "android", deviceId: "emulator-5554" };
    const ios: BootedDevice = { name: "s", platform: "ios", deviceId: "SIM" };
    expect(resolveRootStateInjector(android, "faults.battery")).toBeUndefined();
    expect(resolveRootStateInjector(ios, "rootState")).toBeUndefined();
    expect(resolveRootStateInjector(android, "rootState")?.key).toBe("rootState");
  });

  test("plants the stub with one quoted printf script, as the device shell will see it", async () => {
    const adb = adbWith(ROOTABLE);
    await createRootStateInjector(adb).apply("rooted-detectable");
    expect(adb.getExecutedCommands()).toContain(
      "shell printf '#!/system/bin/sh\\nexit 1\\n' > /system/xbin/su",
    );
    expect(adb.getExecutedCommands().some((c) => c.includes("sh -c"))).toBe(false);
  });

  test("a remount failure after adb root un-roots the device", async () => {
    const adb = adbWith({ ...ROOTABLE, remount: "remount failed: Read-only file system (verity)" });
    await expect(createRootStateInjector(adb).apply("rooted-detectable")).rejects.toThrow(
      /-writable-system/,
    );
    const commands = adb.getExecutedCommands();
    expect(commands).toContain("root");
    expect(commands).toContain("unroot");
    // SELinux was never touched, so the rollback must not flip it.
    expect(commands.some((c) => c.startsWith("shell setenforce"))).toBe(false);
  });

  test("when rollback also fails, the thrown error carries the owed reset", async () => {
    const adb = adbWith(ROOTABLE);
    adb.setCommandError("chmod", new Error("Read-only file system"));
    adb.setCommandError("rm -f", new Error("device offline"));
    const error = await createRootStateInjector(adb)
      .apply("rooted-detectable")
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(OwedResetError);
    expect((error as OwedResetError).message).toMatch(/Cleanup also failed/);
  });
});
