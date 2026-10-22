import { describe, expect, test } from "bun:test";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import type { BootedDevice, ExecResult } from "../../src/models";
import {
  checkAndroidIntegritySignals,
  type IntegrityAdbFactory,
} from "../../src/doctor/checks/androidIntegrity";

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s: string) => stdout.includes(s),
  };
}

const emulator: BootedDevice = { name: "emu", platform: "android", deviceId: "emulator-5554" };

function factoryFor(devices: BootedDevice[]): IntegrityAdbFactory {
  const adb = new FakeAdbExecutor();
  adb.setDevices(devices);
  adb.setCommandResponse(
    "getprop",
    execResult("[ro.kernel.qemu]: [1]\n[ro.hardware]: [ranchu]\n[ro.debuggable]: [1]"),
  );
  adb.setCommandResponse("getenforce", execResult("Enforcing"));
  adb.setCommandResponse("ls -d", execResult("/etc/security/otacerts.zip"));
  return { create: () => adb };
}

describe("checkAndroidIntegritySignals (#14062)", () => {
  test("reports present signals per device and flags image-fixed ones", async () => {
    const result = await checkAndroidIntegritySignals(factoryFor([emulator]));
    expect(result.status).toBe("pass");
    expect(result.message).toContain("emulator-5554");
    expect(result.message).toContain("debuggable-build*");
    expect(result.message).toContain("qemu-props*");
    expect(result.message).toContain("image-fixed");
  });

  test("passes with a note when no devices are connected", async () => {
    const result = await checkAndroidIntegritySignals(factoryFor([]));
    expect(result.status).toBe("pass");
    expect(result.message).toMatch(/No Android devices/);
  });

  test("warns instead of throwing when device discovery fails", async () => {
    const result = await checkAndroidIntegritySignals({
      create: () => {
        throw new Error("adb missing");
      },
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("adb missing");
  });
});
