import { describe, expect, test } from "bun:test";
import type { ExecResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import {
  DeviceConditionController,
  type DeviceConditionInjector,
} from "../../../src/features/deviceCondition/DeviceConditionController";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { createDefaultInjectorResolver } from "../../../src/features/deviceCondition/DeviceConditionRegistry";
import { INTEGRITY_SIGNALS } from "../../../src/features/deviceCondition/integritySignals";
import { ROOT_ARTIFACT_PATHS } from "../../../src/features/deviceCondition/rootStateInjector";
import {
  createIntegrityStateInjector,
  resolveIntegrityStateInjector,
} from "../../../src/features/deviceCondition/integrityStateInjector";
import {
  deviceConditionInputSchema,
  deviceConditionChanges,
  type DeviceConditionSignalResult,
} from "../../../src/features/deviceCondition/DeviceConditionTypes";

function result(stdout = ""): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s) => stdout.includes(s),
  };
}

/** A stateful fake: observations come from the simulated adb state, independently of command success. */
class IntegrityAdb extends FakeAdbExecutor {
  files = new Set<string>();
  mode = "Enforcing";
  commands: string[] = [];
  failures = new Set<string>();
  ignoreWrites = false;
  rooted = true;
  onRootProbe?: () => void;
  async execute(args: string[], options?: AdbExecuteOptions): Promise<ExecResult> {
    const command = args.join(" ");
    this.commands.push(command);
    if ([...this.failures].some((prefix) => command.startsWith(prefix))) {
      throw new Error(`refused ${command}`);
    }
    if (command === "shell id -u") {
      this.onRootProbe?.();
      options?.signal?.throwIfAborted();
      return result(this.rooted ? "0" : "2000");
    }
    if (command === "root") {
      this.rooted = true;
    }
    if (command === "unroot") {
      this.rooted = false;
    }
    if (args[0] === "remount") {
      return result("remount succeeded");
    }
    if (command === "shell getprop ro.debuggable") {
      return result("1");
    }
    if (command === "shell getprop ro.build.type") {
      return result("userdebug");
    }
    if (command === "shell getprop") {
      return result("[ro.debuggable]: [1]\n[ro.build.type]: [userdebug]");
    }
    if (command === "shell getenforce") {
      return result(this.mode);
    }
    if (args[1] === "ls") {
      return result([...this.files].filter((path) => args.includes(path)).join("\n"));
    }
    if (!this.ignoreWrites) {
      if (args[1] === "printf") {
        this.files.add(args.at(-1)!);
      }
      if (args[1] === "rm") {
        for (const path of args.slice(3)) {
          this.files.delete(path);
        }
      }
      if (args[1] === "setenforce") {
        this.mode = args[2] === "0" ? "Permissive" : "Enforcing";
      }
    }
    return result();
  }
}

const ids = ["su-binary", "superuser-apk", "selinux-permissive"] as const;

describe("integrityState injector", () => {
  for (const signals of [{ "selinux-permissive": "on" }, { "su-binary": "on" }] as const) {
    test(`restores non-root adbd after ${Object.keys(signals)[0]} reset`, async () => {
      const adb = new IntegrityAdb();
      adb.rooted = false;
      const injector = createIntegrityStateInjector(adb);
      const outcome = await injector.apply("apply", undefined, { signals });
      expect(adb.rooted).toBe(true);
      await outcome.reset?.();
      expect(adb.rooted).toBe(false);
      expect(await injector.isClean()).toBe(true);
    });
  }

  for (const failure of ["remount", "wait-for-device"]) {
    test(`failed ${failure} restores privilege even before a mutation is registered`, async () => {
      const adb = new IntegrityAdb();
      adb.rooted = false;
      adb.failures.add(failure);
      const injector = createIntegrityStateInjector(adb);
      await injector.apply("apply", undefined, { signals: { "su-binary": "on" } });
      expect(adb.rooted).toBe(false);
      expect(await injector.isClean()).toBe(true);
    });
  }

  test("pre-existing root and failed privilege probes preserve privileges", async () => {
    for (const probeFails of [false, true]) {
      const adb = new IntegrityAdb();
      if (probeFails) {
        adb.failures.add("shell id -u");
      }
      const injector = createIntegrityStateInjector(adb);
      const outcome = await injector.apply("maximally-detectable");
      await outcome.reset?.();
      expect(adb.rooted).toBe(true);
      expect(adb.commands).not.toContain("unroot");
      expect(await injector.isClean()).toBe(true);
    }
  });

  test("failed-apply unroot failure carries a retryable reset", async () => {
    const adb = new IntegrityAdb();
    adb.rooted = false;
    adb.failures.add("remount");
    adb.failures.add("unroot");
    const injector = createIntegrityStateInjector(adb);
    const controller = new DeviceConditionController(() => injector);
    await controller.apply({ integrityState: { signals: { "su-binary": "on" } } });
    expect(adb.rooted).toBe(true);
    expect(controller.hasActiveConditions()).toBe(true);
    expect(await injector.isClean()).toBe(false);
    adb.failures.clear();
    expect((await controller.restore()).verifiedClean).toBe(true);
    expect(adb.rooted).toBe(false);
  });

  test("successful mutation with failed unroot keeps privilege cleanup owed", async () => {
    const adb = new IntegrityAdb();
    adb.rooted = false;
    const injector = createIntegrityStateInjector(adb);
    const outcome = await injector.apply("maximally-detectable");
    adb.failures.add("unroot");
    await expect(outcome.reset?.()).rejects.toThrow("unroot");
    expect(adb.files.size).toBe(0);
    expect(adb.mode).toBe("Enforcing");
    expect(await injector.isClean()).toBe(false);
    adb.failures.clear();
    await outcome.reset?.();
    expect(adb.rooted).toBe(false);
    expect(await injector.isClean()).toBe(true);
  });

  test("stacked frames and failed later applies retain root until the last reset", async () => {
    const adb = new IntegrityAdb();
    adb.rooted = false;
    const injector = createIntegrityStateInjector(adb);
    const first = await injector.apply("apply", undefined, { signals: { "su-binary": "on" } });
    const second = await injector.apply("apply", undefined, {
      signals: { "selinux-permissive": "on" },
    });
    adb.failures.add("remount");
    await injector.apply("apply", undefined, { signals: { "superuser-apk": "on" } });
    expect(adb.rooted).toBe(true);
    expect(adb.commands).not.toContain("unroot");
    adb.failures.clear();
    await second.reset?.();
    expect(adb.rooted).toBe(true);
    // The older frame still owns root, so the newest reset verifies clean (#16275).
    expect(await injector.isClean()).toBe(true);
    await first.reset?.();
    expect(adb.rooted).toBe(false);
    expect(await injector.isClean()).toBe(true);
  });

  test("aborted privilege probe rethrows without acquiring root", async () => {
    const adb = new IntegrityAdb();
    adb.rooted = false;
    const abort = new AbortController();
    adb.onRootProbe = () => abort.abort(new Error("probe aborted"));
    const injector = createIntegrityStateInjector(adb);
    await expect(
      injector.apply("apply", abort.signal, { signals: { "su-binary": "on" } }),
    ).rejects.toThrow("probe aborted");
    expect(adb.commands).not.toContain("root");
    expect(adb.rooted).toBe(false);
  });

  for (const integrityFirst of [true, false]) {
    test(`shared SELinux baseline survives clearing ${integrityFirst ? "integrity" : "root"} first`, async () => {
      const adb = new IntegrityAdb();
      const resolve = createDefaultInjectorResolver({ adbFactory: { create: () => adb } });
      const device = { name: "e", platform: "android" as const, deviceId: "shared" };
      const owner = { device, deviceId: device.deviceId };
      const integrity = resolve(owner, "integrityState")!;
      const root = resolve(owner, "rootState")!;
      const integrityOutcome = await integrity.apply("maximally-detectable");
      const rootOutcome = await root.apply("rooted-detectable");
      expect(adb.mode).toBe("Permissive");
      await (integrityFirst ? integrityOutcome : rootOutcome).reset?.();
      expect(adb.mode).toBe("Permissive");
      await (integrityFirst ? rootOutcome : integrityOutcome).reset?.();
      expect(adb.mode).toBe("Enforcing");
      expect(await integrity.isClean()).toBe(true);
      expect(await root.isClean()).toBe(true);
    });
  }

  test("factory-local SELinux owners isolate the same device id across adb clients", async () => {
    const firstAdb = new IntegrityAdb();
    const secondAdb = new IntegrityAdb();
    secondAdb.mode = "Permissive";
    const device = { name: "e", platform: "android" as const, deviceId: "same-id" };
    const owner = { device, deviceId: device.deviceId };
    const firstResolve = createDefaultInjectorResolver({ adbFactory: { create: () => firstAdb } });
    const secondResolve = createDefaultInjectorResolver({
      adbFactory: { create: () => secondAdb },
    });
    const integrity = firstResolve(owner, "integrityState")!;
    const root = secondResolve(owner, "rootState")!;
    const first = await integrity.apply("maximally-detectable");
    const second = await root.apply("rooted-detectable");
    await first.reset?.();
    await second.reset?.();
    expect(firstAdb.mode).toBe("Enforcing");
    expect(secondAdb.mode).toBe("Permissive");
    expect(await integrity.isClean()).toBe(true);
    expect(await root.isClean()).toBe(true);
  });

  for (const integrityFirst of [true, false]) {
    test(`root-first acquisition restores the first baseline when ${integrityFirst ? "integrity" : "root"} clears first`, async () => {
      const adb = new IntegrityAdb();
      const resolve = createDefaultInjectorResolver({ adbFactory: { create: () => adb } });
      const device = { name: "e", platform: "android" as const, deviceId: "root-first" };
      const owner = { device, deviceId: device.deviceId };
      const integrity = resolve(owner, "integrityState")!;
      const root = resolve(owner, "rootState")!;
      const rootOutcome = await root.apply("rooted-detectable");
      const integrityOutcome = await integrity.apply("apply", undefined, {
        signals: { "selinux-permissive": "on" },
      });
      expect(integrityOutcome.reset).toBeDefined();
      await (integrityFirst ? integrityOutcome : rootOutcome).reset?.();
      expect(adb.mode).toBe("Permissive");
      await (integrityFirst ? rootOutcome : integrityOutcome).reset?.();
      expect(adb.mode).toBe("Enforcing");
      expect(await integrity.isClean()).toBe(true);
      expect(await root.isClean()).toBe(true);
    });
  }

  test("maximal preset applies and reads each signal back from adb", async () => {
    const adb = new IntegrityAdb();
    const injector = createIntegrityStateInjector(adb);
    const outcome = await injector.apply("maximally-detectable");
    expect(outcome.signals).toEqual(
      ids.map((id): DeviceConditionSignalResult => ({
        id,
        requested: "on",
        status: "applied",
        active: true,
      })),
    );
    expect(
      adb.commands.slice(adb.commands.indexOf("root"), adb.commands.indexOf("remount") + 1),
    ).toEqual(["root", "wait-for-device", "remount"]);
    expect(adb.files.has("/system/xbin/su")).toBe(true);
    expect(adb.files.has("/system/app/Superuser.apk")).toBe(true);
    expect(adb.mode).toBe("Permissive");
    expect(await injector.isClean()).toBe(false);
    await outcome.reset?.();
    expect(adb.files.size).toBe(0);
    expect(adb.mode).toBe("Enforcing");
    expect(await injector.isClean()).toBe(true);
  });

  test("minimal reverses owned files and SELinux; stacked controller resets restore both baselines", async () => {
    const adb = new IntegrityAdb();
    const injector = createIntegrityStateInjector(adb);
    const controller = new DeviceConditionController(() => injector);
    await controller.apply({ integrityState: "maximally-detectable" });
    const minimal = await controller.apply({ integrityState: "minimally-detectable" });
    expect(minimal.changes[0]?.signals).toEqual(
      ids.map((id): DeviceConditionSignalResult => ({
        id,
        requested: "off",
        status: "applied",
        active: false,
      })),
    );
    expect(adb.files.size).toBe(0);
    expect(adb.mode).toBe("Enforcing");
    expect((await controller.restore()).verifiedClean).toBe(true);
    expect(adb.files.size).toBe(0);
    expect(adb.mode).toBe("Enforcing");
  });

  test("stacked resets from non-root adbd verify clean at each step and drop root at the end (#16275)", async () => {
    const adb = new IntegrityAdb();
    adb.rooted = false;
    const injector = createIntegrityStateInjector(adb);
    const controller = new DeviceConditionController(() => injector);
    await controller.apply({ integrityState: { signals: { "su-binary": "on" } } });
    await controller.apply({ integrityState: { signals: { "selinux-permissive": "on" } } });
    const report = await controller.restore();
    expect(report).toMatchObject({ verifiedClean: true, failures: [] });
    expect(controller.hasActiveConditions()).toBe(false);
    expect(adb.rooted).toBe(false);
    expect(adb.files.size).toBe(0);
    expect(adb.mode).toBe("Enforcing");
  });

  test("privilege cleanup still owed after the last reset is not clean (#16275)", async () => {
    const adb = new IntegrityAdb();
    adb.rooted = false;
    const injector = createIntegrityStateInjector(adb);
    const controller = new DeviceConditionController(() => injector);
    await controller.apply({ integrityState: { signals: { "su-binary": "on" } } });
    await controller.apply({ integrityState: { signals: { "selinux-permissive": "on" } } });
    adb.failures.add("unroot");
    const report = await controller.restore();
    expect(report.verifiedClean).toBe(false);
    expect(adb.rooted).toBe(true);
    expect(controller.hasActiveConditions()).toBe(true);
    adb.failures.clear();
    expect((await controller.restore()).verifiedClean).toBe(true);
    expect(adb.rooted).toBe(false);
  });

  test("successive disjoint signal requests restore their own snapshots newest first", async () => {
    const adb = new IntegrityAdb();
    const injector = createIntegrityStateInjector(adb);
    const controller = new DeviceConditionController(() => injector);
    await controller.apply({ integrityState: { signals: { "su-binary": "on" } } });
    await controller.apply({ integrityState: { signals: { "selinux-permissive": "on" } } });
    expect((await controller.restore()).verifiedClean).toBe(true);
    expect(adb.files.size).toBe(0);
    expect(adb.mode).toBe("Enforcing");
  });

  test("a failed newest reset prevents older resets from undoing their baselines out of order", async () => {
    const adb = new IntegrityAdb();
    const controller = new DeviceConditionController(() => injector);
    const injector = createIntegrityStateInjector(adb);
    await controller.apply({ integrityState: "maximally-detectable" });
    await controller.apply({ integrityState: "minimally-detectable" });
    adb.failures.add("shell printf");
    const failed = await controller.restore();
    expect(failed.verifiedClean).toBe(false);
    expect(failed.failures).toHaveLength(2);
    expect(controller.hasActiveConditions()).toBe(true);
    adb.failures.clear();
    expect((await controller.restore()).verifiedClean).toBe(true);
    expect(adb.files.size).toBe(0);
    expect(adb.mode).toBe("Enforcing");
  });

  test("explicit signal overrides preset and repeated apply is unchanged", async () => {
    const adb = new IntegrityAdb();
    const injector = createIntegrityStateInjector(adb);
    const params = { preset: "maximally-detectable", signals: { "su-binary": "off" } };
    const first = await injector.apply("apply", undefined, params);
    expect(first.signals?.find((s) => s.id === "su-binary")).toEqual({
      id: "su-binary",
      requested: "off",
      status: "unchanged",
      active: false,
    });
    const second = await injector.apply("apply", undefined, params);
    expect(second.status).toBe("unchanged");
    expect(second.reset).toBeUndefined();
    await first.reset?.();
    expect(await injector.isClean()).toBe(true);
  });

  test("every image-fixed signal and missing otacerts report unsupported without an active reading", async () => {
    const adb = new IntegrityAdb();
    const signals = Object.fromEntries(
      INTEGRITY_SIGNALS.filter((s) => !(ids as readonly string[]).includes(s.id)).map((s) => [
        s.id,
        "off",
      ]),
    );
    const outcome = await createIntegrityStateInjector(adb).apply("apply", undefined, { signals });
    expect(outcome.signals).toHaveLength(INTEGRITY_SIGNALS.length - ids.length);
    for (const signalResult of outcome.signals ?? []) {
      expect(signalResult.status).toBe("unsupported");
      expect(signalResult.active).toBeUndefined();
      expect(signalResult.detail).toContain(
        signalResult.id === "missing-otacerts"
          ? "needs root and writable /system and is not implemented yet"
          : "baked into the system image and only a different image changes it",
      );
    }
    expect(adb.commands.some((c) => /^(root|remount)$/.test(c))).toBe(false);
  });

  test("root failure is per signal and leaves unsupported catalogue entries intact", async () => {
    const adb = new IntegrityAdb();
    adb.failures.add("root");
    const outcome = await createIntegrityStateInjector(adb).apply("apply", undefined, {
      preset: "maximally-detectable",
      signals: { "test-keys": "on" },
    });
    for (const signalResult of outcome.signals ?? []) {
      expect(signalResult.status).toBe("unsupported");
      expect(signalResult.detail).toContain(
        signalResult.id === "test-keys" ? "baked into" : "refused root",
      );
    }
    expect(outcome.signals).toHaveLength(4);
    expect(outcome.reset).toBeUndefined();
    expect(adb.files.size).toBe(0);
  });

  test("remount failure does not prevent the SELinux toggle", async () => {
    const adb = new IntegrityAdb();
    adb.failures.add("remount");
    const injector = createIntegrityStateInjector(adb);
    const outcome = await injector.apply("maximally-detectable");
    expect(outcome.signals?.filter((s) => s.status === "unsupported").map((s) => s.id)).toEqual([
      "su-binary",
      "superuser-apk",
    ]);
    expect(outcome.signals?.find((s) => s.id === "selinux-permissive")?.active).toBe(true);
    await outcome.reset?.();
    expect(adb.mode).toBe("Enforcing");
  });

  test("pre-existing image or rootState files are unchanged on and unsupported off, never deleted", async () => {
    const adb = new IntegrityAdb();
    adb.files = new Set(ROOT_ARTIFACT_PATHS);
    const injector = createIntegrityStateInjector(adb);
    const on = await injector.apply("maximally-detectable");
    expect(on.signals?.slice(0, 2).map((s) => s.status)).toEqual(["unchanged", "unchanged"]);
    const off = await injector.apply("minimally-detectable");
    for (const signalResult of off.signals?.slice(0, 2) ?? []) {
      expect(signalResult.status).toBe("unsupported");
      expect(signalResult.detail).toBe(
        "present on the image or planted by rootState; use rootState reset",
      );
    }
    await off.reset?.();
    await on.reset?.();
    expect(adb.files).toEqual(new Set(ROOT_ARTIFACT_PATHS));
    expect(await injector.isClean()).toBe(true);
  });

  test("a per-apply reset restores a prior permissive baseline", async () => {
    const adb = new IntegrityAdb();
    adb.mode = "Permissive";
    const injector = createIntegrityStateInjector(adb);
    const outcome = await injector.apply("minimally-detectable");
    expect(adb.mode).toBe("Enforcing");
    expect(await injector.isClean()).toBe(false);
    await outcome.reset?.();
    await outcome.reset?.();
    expect(adb.mode).toBe("Permissive");
    expect(await injector.isClean()).toBe(true);
  });

  test("success flags without matching device readback are unsupported", async () => {
    const adb = new IntegrityAdb();
    adb.ignoreWrites = true;
    const outcome = await createIntegrityStateInjector(adb).apply("maximally-detectable");
    expect(
      outcome.signals?.every((s) => s.status === "unsupported" && s.active === undefined),
    ).toBe(true);
    expect(outcome.reset).toBeUndefined();
  });

  test("failed partial write rolls back only that signal and still applies the others", async () => {
    const adb = new IntegrityAdb();
    adb.failures.add("shell chmod 06755");
    const injector = createIntegrityStateInjector(adb);
    const outcome = await injector.apply("maximally-detectable");
    expect(outcome.signals?.[0]?.status).toBe("unsupported");
    expect(outcome.signals?.slice(1).every((s) => s.active)).toBe(true);
    expect([...adb.files]).toEqual(["/system/app/Superuser.apk"]);
    await outcome.reset?.();
    expect(await injector.isClean()).toBe(true);
  });

  test("partial rollback failure carries all owed cleanup for controller retry", async () => {
    const adb = new IntegrityAdb();
    adb.failures.add("shell chmod 0644");
    adb.failures.add("shell rm");
    const injector = createIntegrityStateInjector(adb);
    const controller = new DeviceConditionController(() => injector);
    const applied = await controller.apply({ integrityState: "maximally-detectable" });
    expect(applied.changes[0]?.status).toBe("unsupported");
    expect(controller.hasActiveConditions()).toBe(true);
    expect(await injector.isClean()).toBe(false);
    adb.failures.clear();
    expect((await controller.restore()).verifiedClean).toBe(true);
    expect(adb.files.size).toBe(0);
  });

  test("an unverified reset stays owed and can be retried", async () => {
    const adb = new IntegrityAdb();
    const injector = createIntegrityStateInjector(adb);
    const outcome = await injector.apply("maximally-detectable");
    adb.ignoreWrites = true;
    await expect(outcome.reset?.()).rejects.toThrow(/read.back|restore/i);
    expect(await injector.isClean()).toBe(false);
    adb.ignoreWrites = false;
    await outcome.reset?.();
    expect(await injector.isClean()).toBe(true);
  });

  test("a failed catalogue path read cannot masquerade as an inactive signal", async () => {
    const adb = new IntegrityAdb();
    adb.failures.add("shell ls -d");
    const injector = createIntegrityStateInjector(adb);
    const outcome = await injector.apply("maximally-detectable");
    expect(
      outcome.signals
        ?.slice(0, 2)
        .every((s) => s.status === "unsupported" && s.active === undefined),
    ).toBe(true);
    expect(outcome.signals?.[2]?.active).toBe(true);
    expect(adb.files.size).toBe(0);
    await outcome.reset?.();
    expect(await injector.isClean()).toBe(true);
  });

  test("disabled SELinux is unsupported while file signals still apply", async () => {
    const adb = new IntegrityAdb();
    adb.mode = "Disabled";
    const injector = createIntegrityStateInjector(adb);
    const outcome = await injector.apply("maximally-detectable");
    expect(outcome.signals?.slice(0, 2).every((s) => s.active)).toBe(true);
    expect(outcome.signals?.[2]?.status).toBe("unsupported");
    expect(outcome.signals?.[2]?.detail).toContain("Disabled");
    await outcome.reset?.();
    expect(adb.mode).toBe("Disabled");
    expect(await injector.isClean()).toBe(true);
  });

  test("off preserves an unowned su outside the system partition", async () => {
    const adb = new IntegrityAdb();
    adb.files.add("/sbin/su");
    const outcome = await createIntegrityStateInjector(adb).apply("minimally-detectable");
    expect(outcome.signals?.[0]?.status).toBe("unsupported");
    expect(adb.files.has("/sbin/su")).toBe(true);
    expect(adb.commands.some((c) => c.startsWith("shell rm"))).toBe(false);
  });

  test("an explicitly empty signals object is a valid no-op", async () => {
    const adb = new IntegrityAdb();
    expect(deviceConditionInputSchema.safeParse({ integrityState: { signals: {} } }).success).toBe(
      true,
    );
    const outcome = await createIntegrityStateInjector(adb).apply("apply", undefined, {
      signals: {},
    });
    expect(outcome).toEqual({ status: "unchanged", signals: [] });
    expect(adb.commands).toEqual([]);
  });

  test("failed baseline reads stop writes and clean checks fail closed", async () => {
    const adb = new IntegrityAdb();
    adb.failures.add("shell ls");
    const injector = createIntegrityStateInjector(adb);
    const outcome = await injector.apply("maximally-detectable");
    expect(outcome.signals?.slice(0, 2).every((s) => s.status === "unsupported")).toBe(true);
    expect(adb.files.size).toBe(0);
    adb.failures.add("shell getenforce");
    expect(await injector.isClean()).toBe(false);
  });

  test("invalid values and params fail before adb calls", async () => {
    const adb = new IntegrityAdb();
    const injector = createIntegrityStateInjector(adb);
    await expect(injector.apply("bogus")).rejects.toThrow(/Invalid integrityState/);
    await expect(
      injector.apply("apply", undefined, { signals: { bogus: "on" } }),
    ).rejects.toThrow();
    expect(adb.commands).toEqual([]);
  });

  test("resolver is Android only, key specific, and cached per device", () => {
    const adb = new IntegrityAdb();
    const factory = { create: () => adb };
    const cache = new Map<string, DeviceConditionInjector>();
    const device = { name: "e", platform: "android" as const, deviceId: "fake-integrity" };
    const first = resolveIntegrityStateInjector(device, "integrityState", factory, cache);
    expect(first?.key).toBe("integrityState");
    expect(resolveIntegrityStateInjector(device, "integrityState", factory, cache)).toBe(first);
    expect(
      resolveIntegrityStateInjector(
        { ...device, deviceId: "other" },
        "integrityState",
        factory,
        cache,
      ),
    ).not.toBe(first);
    expect(resolveIntegrityStateInjector(device, "rootState", factory, cache)).toBeUndefined();
    expect(
      resolveIntegrityStateInjector(
        { ...device, platform: "ios" },
        "integrityState",
        factory,
        cache,
      ),
    ).toBeUndefined();
  });
});

describe("integrityState request contract", () => {
  test("accepts presets, unset, and strict object requests", () => {
    for (const integrityState of [
      "maximally-detectable",
      "minimally-detectable",
      "unset",
      { preset: "maximally-detectable" },
      { signals: { "su-binary": "off", "missing-otacerts": "on" } },
      { preset: "minimally-detectable", signals: { "selinux-permissive": "on" } },
    ]) {
      expect(deviceConditionInputSchema.safeParse({ integrityState }).success).toBe(true);
    }
  });
  test("rejects unknown ids, values, and object fields or missing preset/signals", () => {
    for (const integrityState of [
      {},
      { signals: { bogus: "on" } },
      { signals: { "su-binary": true } },
      { preset: "unset" },
      { preset: "maximally-detectable", extra: true },
      "bogus",
    ]) {
      expect(deviceConditionInputSchema.safeParse({ integrityState }).success).toBe(false);
    }
  });
  test("object becomes apply with params; strings pass through", () => {
    const params = {
      preset: "maximally-detectable" as const,
      signals: { "su-binary": "off" as const },
    };
    expect(deviceConditionChanges({ integrityState: params })).toEqual([
      { key: "integrityState", value: "apply", params },
    ]);
    expect(deviceConditionChanges({ integrityState: "minimally-detectable" })).toEqual([
      { key: "integrityState", value: "minimally-detectable" },
    ]);
  });
});
