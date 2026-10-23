import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import type { ExecResult } from "../../../src/models";
import {
  INTEGRITY_SIGNALS,
  parseGetprop,
  readIntegritySignals,
} from "../../../src/features/deviceCondition/integritySignals";

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

const EMULATOR_PROPS = [
  "[ro.debuggable]: [1]",
  "[ro.secure]: [0]",
  "[ro.build.tags]: [test-keys]",
  "[ro.kernel.qemu]: [1]",
  "[ro.hardware]: [ranchu]",
  "[ro.product.model]: [sdk_gphone64_arm64]",
].join("\n");

const byId = (readings: Awaited<ReturnType<typeof readIntegritySignals>>) =>
  Object.fromEntries(readings.map((r) => [r.id, r.active]));

describe("integrity signals (#14062)", () => {
  test("parseGetprop reads [key]: [value] lines and ignores noise", () => {
    const props = parseGetprop("[ro.a]: [1]\nnot a prop\n[ro.empty]: []\n");
    expect(props.get("ro.a")).toBe("1");
    expect(props.get("ro.empty")).toBe("");
    expect(props.size).toBe(2);
  });

  test("a rooted-looking emulator reports root and emulator signals", async () => {
    const adb = adbWith({
      getprop: EMULATOR_PROPS,
      getenforce: "Permissive",
      "ls -d": "/system/xbin/su\n/dev/qemu_pipe\n/etc/security/otacerts.zip",
    });
    const active = byId(await readIntegritySignals(adb));
    expect(active).toMatchObject({
      "su-binary": true,
      "superuser-apk": false,
      "selinux-permissive": true,
      "debuggable-build": true,
      "insecure-build": true,
      "test-keys": true,
      "missing-otacerts": false,
      "qemu-props": true,
      "emulator-hardware": true,
      "qemu-pipe": true,
      "emulator-build-fields": true,
    });
  });

  test("a clean production-like device presents no signals except a missing otacerts", async () => {
    const adb = adbWith({
      getprop:
        "[ro.debuggable]: [0]\n[ro.secure]: [1]\n[ro.build.tags]: [release-keys]\n[ro.hardware]: [pixel]",
      getenforce: "Enforcing",
      "ls -d": "/etc/security/otacerts.zip",
    });
    const active = Object.entries(byId(await readIntegritySignals(adb)))
      .filter(([, on]) => on)
      .map(([id]) => id);
    expect(active).toEqual([]);
  });

  test("a failed sub-read leaves its signals inactive instead of failing the probe", async () => {
    const adb = adbWith({ getprop: EMULATOR_PROPS });
    adb.setCommandError("getenforce", new Error("adb offline"));
    const active = byId(await readIntegritySignals(adb));
    expect(active["selinux-permissive"]).toBe(false);
    expect(active["debuggable-build"]).toBe(true);
  });

  test("every build-prop signal is classified image-fixed, every file/mode signal needs root", () => {
    const mutability = Object.fromEntries(INTEGRITY_SIGNALS.map((s) => [s.id, s.mutability]));
    for (const id of ["debuggable-build", "insecure-build", "test-keys", "qemu-props"]) {
      expect(mutability[id]).toBe("image-fixed");
    }
    for (const id of ["su-binary", "superuser-apk", "selinux-permissive", "missing-otacerts"]) {
      expect(mutability[id]).toBe("needs-root");
    }
  });

  test("an su binary at a RootBeer location outside /system still reads as su-binary", async () => {
    const adb = adbWith({
      getprop: EMULATOR_PROPS,
      getenforce: "Enforcing",
      "ls -d": "/su/bin/su\n/etc/security/otacerts.zip",
    });
    expect(byId(await readIntegritySignals(adb))["su-binary"]).toBe(true);
    expect(adb.getExecutedCommands().find((c) => c.includes("ls -d"))).toContain("/su/bin/su");
  });

  test("probes present and absent paths in one command that tolerates a nonzero ls exit", async () => {
    const adb = adbWith({
      getprop: EMULATOR_PROPS,
      getenforce: "Enforcing",
      "ls -d": "/dev/qemu_pipe",
    });
    await readIntegritySignals(adb);
    const lsCommand = adb.getExecutedCommands().find((c) => c.includes("ls -d"));
    expect(lsCommand).toMatch(/2>\/dev\/null; true$/);
  });

  test("a failed path read leaves absence-based signals off instead of reporting them", async () => {
    const adb = adbWith({ getprop: EMULATOR_PROPS, getenforce: "Enforcing" });
    adb.setCommandError("ls -d", new Error("adb offline"));
    const active = byId(await readIntegritySignals(adb));
    expect(active["missing-otacerts"]).toBe(false);
    expect(active["su-binary"]).toBe(false);
    expect(active["qemu-pipe"]).toBe(false);
    expect(active["debuggable-build"]).toBe(true);
  });

  test("an ExecResult error is logged and treated as a failed read", async () => {
    // The fake drops `error` from configured responses, so return it straight from execute.
    const adb = adbWith({ getprop: EMULATOR_PROPS, getenforce: "Enforcing" });
    const real = adb.execute.bind(adb);
    adb.execute = (args, options) =>
      args.includes("getprop")
        ? Promise.resolve({ ...execResult(EMULATOR_PROPS), error: "closed" })
        : real(args, options);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const active = byId(await readIntegritySignals(adb));
      // The dump carried debuggable=1, but the read failed, so nothing from it is trusted.
      expect(active["debuggable-build"]).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
