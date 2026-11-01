import { describe, expect, test } from "bun:test";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import type { DeviceConditionInjector } from "../../../src/features/deviceCondition/DeviceConditionController";
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

const ALL_ARTIFACTS = ROOT_ARTIFACT_PATHS.join("\n");

/** Make the first `times` executions whose command contains `pattern` throw, then behave normally. */
function failFirst(adb: FakeAdbExecutor, pattern: string, times: number): void {
  const real = adb.execute.bind(adb);
  let remaining = times;
  adb.execute = (args, options) => {
    if (remaining > 0 && args.join(" ").includes(pattern)) {
      remaining -= 1;
      return Promise.reject(new Error("Read-only file system"));
    }
    return real(args, options);
  };
}

describe("rootState injector (#14060)", () => {
  test("refuses a production (Play) image with guidance toward real root", async () => {
    const adb = adbWith({ "getprop ro.debuggable": "0", "getprop ro.build.type": "user" });
    await expect(createRootStateInjector(adb).apply("rooted-detectable")).rejects.toThrow(
      /rootState needs a non-Play image[\s\S]*#14070/,
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

  test("a remount that exits nonzero still explains how to boot writable", async () => {
    const adb = adbWith(ROOTABLE);
    failFirst(adb, "remount", 1);
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

  test("isClean is false while planted artifacts exist and true after reset", async () => {
    const adb = adbWith(ROOTABLE);
    // Listings: nothing pre-existing; planted files present; then gone on the reset's readback.
    adb.setCommandResponseSequence("ls /system/xbin/su", [
      execResult(""),
      execResult(ALL_ARTIFACTS),
      execResult(""),
    ]);
    const injector = createRootStateInjector(adb);
    const outcome = await injector.apply("rooted-detectable");
    expect(await injector.isClean()).toBe(false);
    await outcome.reset?.();
    expect(await injector.isClean()).toBe(true);
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

  test("reset re-acquires root before touching /system", async () => {
    const adb = adbWith(ROOTABLE);
    const outcome = await createRootStateInjector(adb).apply("rooted-detectable");
    const before = adb.getExecutedCommands().length;
    await outcome.reset?.();
    const resetCommands = adb.getExecutedCommands().slice(before);
    expect(resetCommands.indexOf("root")).toBeGreaterThanOrEqual(0);
    expect(resetCommands.indexOf("root")).toBeLessThan(
      resetCommands.findIndex((c) => c.startsWith("shell rm -f")),
    );
  });

  test("a repeat apply on the same injector is coalesced and keeps the original baseline", async () => {
    const adb = adbWith(ROOTABLE);
    adb.setCommandResponseSequence("ls /system/xbin/su", [
      execResult(""),
      execResult(ALL_ARTIFACTS),
    ]);
    adb.setCommandResponseSequence("getenforce", [
      execResult("Enforcing"),
      execResult("Permissive"),
    ]);
    const injector = createRootStateInjector(adb);
    const first = await injector.apply("rooted-detectable");
    expect(first.status).toBe("applied");
    const second = await injector.apply("rooted-detectable");
    expect(second.status).toBe("unchanged");
    expect(second.reset).toBeUndefined();
    // Nothing was re-applied, so SELinux was only switched once.
    expect(adb.getExecutedCommands().filter((c) => c === "shell setenforce 0")).toHaveLength(1);
  });

  test("the resolver hands back one injector per device so applies share state", () => {
    const android: BootedDevice = { name: "e", platform: "android", deviceId: "emulator-5554" };
    const other: BootedDevice = { name: "f", platform: "android", deviceId: "emulator-5556" };
    const cache = new Map<string, DeviceConditionInjector>();
    const factory = { create: () => adbWith(ROOTABLE) };
    const a = resolveRootStateInjector(android, "rootState", factory, cache);
    expect(resolveRootStateInjector(android, "rootState", factory, cache)).toBe(a);
    expect(resolveRootStateInjector(other, "rootState", factory, cache)).not.toBe(a);
  });

  test("applying twice through the controller registers one reset and restores cleanly", async () => {
    const adb = adbWith(ROOTABLE);
    // Nothing pre-existing; our planted files still there on the repeat apply; gone after reset.
    adb.setCommandResponseSequence("ls /system/xbin/su", [
      execResult(""),
      execResult(ALL_ARTIFACTS),
      execResult(""),
    ]);
    adb.setCommandResponseSequence("getenforce", [
      execResult("Enforcing"),
      execResult("Permissive"),
      execResult("Enforcing"),
    ]);
    const injector = createRootStateInjector(adb);
    const controller = new DeviceConditionController(() => injector);
    await controller.apply({ rootState: "rooted-detectable" });
    await controller.apply({ rootState: "rooted-detectable" });
    const report = await controller.restore();
    expect(report.failures).toEqual([]);
    expect(adb.getExecutedCommands().filter((c) => c === "unroot")).toHaveLength(1);
  });

  test("an artifact already on the image is left alone: not overwritten, not deleted on reset", async () => {
    const adb = adbWith(ROOTABLE);
    // A userdebug image ships a real su in /system/xbin.
    adb.setCommandResponseSequence("ls /system/xbin/su", [execResult("/system/xbin/su")]);
    const outcome = await createRootStateInjector(adb).apply("rooted-detectable");
    const commands = adb.getExecutedCommands();
    expect(commands.some((c) => c.includes("> /system/xbin/su"))).toBe(false);
    expect(commands.some((c) => c.includes("> /system/bin/su"))).toBe(true);
    expect(outcome.detail).toMatch(/already present on the image/);

    await outcome.reset?.();
    const rm = adb.getExecutedCommands().find((c) => c.startsWith("shell rm -f "));
    expect(rm).toBeDefined();
    expect(rm).not.toContain("/system/xbin/su ");
    expect(rm?.endsWith("/system/xbin/su")).toBe(false);
  });

  test("a retry after a failed rollback keeps the original SELinux baseline", async () => {
    const adb = adbWith(ROOTABLE);
    // The first read is the real baseline; any later read would see the fixture's Permissive.
    adb.setCommandResponseSequence("getenforce", [
      execResult("Enforcing"),
      execResult("Permissive"),
      execResult("Permissive"),
    ]);
    failFirst(adb, "chmod", 1);
    failFirst(adb, "rm -f", 1);
    const injector = createRootStateInjector(adb);

    await expect(injector.apply("rooted-detectable")).rejects.toBeInstanceOf(OwedResetError);
    const retry = await injector.apply("rooted-detectable");
    expect(retry.status).toBe("applied");
    await retry.reset?.();

    const commands = adb.getExecutedCommands();
    const lastSetenforce = commands.filter((c) => c.startsWith("shell setenforce")).at(-1);
    expect(lastSetenforce).toBe("shell setenforce 1");
    expect(commands.filter((c) => c === "shell getenforce")).toHaveLength(1);
  });

  test("a failed artifact listing stops the apply before anything on the device changes", async () => {
    const adb = adbWith({ ...ROOTABLE, "ls /system/xbin/su": "/system/bin/busybox" });
    failFirst(adb, "ls ", 1);
    await expect(createRootStateInjector(adb).apply("rooted-detectable")).rejects.toThrow();
    const commands = adb.getExecutedCommands();
    // Nothing was written, un-rooted or toggled, and the baseline was not read yet either.
    expect(commands.filter((c) => /^(root|remount|unroot)$/.test(c))).toEqual([]);
    expect(commands.some((c) => c.startsWith("shell printf") || c.startsWith("shell chmod"))).toBe(
      false,
    );
    expect(commands.some((c) => c.startsWith("shell setenforce"))).toBe(false);
    expect(commands.filter((c) => c === "shell getenforce")).toHaveLength(0);
  });

  test("isClean fails closed when the artifact listing cannot run", async () => {
    const adb = adbWith(ROOTABLE);
    const injector = createRootStateInjector(adb);
    await injector.apply("rooted-detectable");
    failFirst(adb, "ls ", 1);
    expect(await injector.isClean()).toBe(false);
  });

  test("a repeat apply re-applies SELinux when only the mode drifted, keeping one reset and the baseline", async () => {
    const adb = adbWith(ROOTABLE);
    adb.setCommandResponseSequence("ls /system/xbin/su", [
      execResult(""),
      execResult(ALL_ARTIFACTS),
      execResult(""),
    ]);
    // Baseline Enforcing; after a reboot the files are still there but SELinux is Enforcing again.
    adb.setCommandResponseSequence("getenforce", [
      execResult("Enforcing"),
      execResult("Enforcing"),
      execResult("Permissive"),
    ]);
    const injector = createRootStateInjector(adb);
    const first = await injector.apply("rooted-detectable");
    expect(first.reset).toBeDefined();

    const second = await injector.apply("rooted-detectable");
    expect(second.status).toBe("applied");
    expect(second.reset).toBeUndefined();
    expect(adb.getExecutedCommands().filter((c) => c === "shell setenforce 0")).toHaveLength(2);

    await first.reset?.();
    const lastSetenforce = adb
      .getExecutedCommands()
      .filter((c) => c.startsWith("shell setenforce"))
      .at(-1);
    expect(lastSetenforce).toBe("shell setenforce 1");
  });

  test("a reset that cannot confirm the artifacts are gone stays owed and reports them", async () => {
    const adb = adbWith(ROOTABLE);
    // Pre-existing listing: none. The reset's readback and the clean check both still see the files.
    adb.setCommandResponseSequence("ls /system/xbin/su", [
      execResult(""),
      execResult(ALL_ARTIFACTS),
      execResult(ALL_ARTIFACTS),
    ]);
    const injector = createRootStateInjector(adb);
    const outcome = await injector.apply("rooted-detectable");

    await expect(outcome.reset?.()).rejects.toThrow(/left artifacts on the device/);
    // SELinux was still restored and adbd un-rooted despite the failed removal check.
    expect(adb.getExecutedCommands()).toContain("unroot");
    // Nothing was forgotten: the device is not reported clean.
    expect(await injector.isClean()).toBe(false);
  });

  test("reset remounts /system writable before it removes the planted files", async () => {
    const adb = adbWith(ROOTABLE);
    const outcome = await createRootStateInjector(adb).apply("rooted-detectable");
    const before = adb.getExecutedCommands().length;
    await outcome.reset?.();
    const commands = adb.getExecutedCommands().slice(before);
    const remount = commands.indexOf("remount");
    expect(remount).toBeGreaterThan(commands.indexOf("root"));
    expect(remount).toBeLessThan(commands.findIndex((c) => c.startsWith("shell rm -f")));
  });

  test("a reset that cannot make /system writable stays owed instead of half-cleaning", async () => {
    const adb = adbWith(ROOTABLE);
    const outcome = await createRootStateInjector(adb).apply("rooted-detectable");
    // After a reboot the system partition is read-only again and remount is refused.
    adb.setCommandResponse("remount", execResult("remount failed: Read-only file system"));
    await expect(outcome.reset?.()).rejects.toThrow(/-writable-system/);
    expect(adb.getExecutedCommands().filter((c) => c.startsWith("shell rm -f"))).toHaveLength(0);
  });
});
