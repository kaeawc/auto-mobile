import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accelerationCheckCategory,
  detectArchitecturePanic,
  detectCorruptImage,
  detectDeviceIdFromEmulatorOutput,
  detectDisplayError,
  detectSandboxMprotect,
  launchFailureCategory,
} from "../../../src/utils/android-cmdline-tools/emulatorLaunchFailure";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-emulator", name), "utf8");

describe("emulatorLaunchFailure classifiers", () => {
  test("detectArchitecturePanic extracts both architectures", () => {
    expect(detectArchitecturePanic(fixture("arch-panic.txt"))).toEqual({
      isPanic: true,
      message: "AVD architecture 'x86_64' is not supported on aarch64 host",
      hostArch: "aarch64",
      avdArch: "x86_64",
    });
    expect(detectArchitecturePanic("PANIC: out of CPU budget").isPanic).toBe(true);
    expect(detectArchitecturePanic(fixture("normal-startup.txt"))).toEqual({ isPanic: false });
  });

  test("detectSandboxMprotect matches mprotect and HVF signatures", () => {
    expect(detectSandboxMprotect(fixture("sandbox-mprotect.txt")).isSandboxError).toBe(true);
    for (const line of [
      "hvf is not enabled on this aarch64 host",
      "HVF error: HV_UNSUPPORTED",
      "HVF error: HV_ERROR",
      "failed to initialize HVF: Invalid argument",
    ]) {
      expect(detectSandboxMprotect(line).isSandboxError).toBe(true);
    }
    expect(detectSandboxMprotect(fixture("normal-startup.txt")).isSandboxError).toBe(false);
  });

  test("detectCorruptImage reports the qcow2 corruption line", () => {
    const result = detectCorruptImage(fixture("corrupt-qcow2.txt"));
    expect(result.isCorrupt).toBe(true);
    expect(result.message).toBe(
      "Disk image is corrupt: qcow2: Image is corrupt; cannot be opened read/write",
    );
    expect(detectCorruptImage(fixture("normal-startup.txt"))).toEqual({ isCorrupt: false });
  });

  test("detectDisplayError flags the missing display and Qt plugin", () => {
    expect(detectDisplayError(fixture("display-xcb.txt")).isDisplayError).toBe(true);
    expect(detectDisplayError(fixture("normal-startup.txt")).isDisplayError).toBe(false);
  });

  test("the headless display hint keeps audio on and warns that -no-audio disables audio tests", () => {
    const { suggestion } = detectDisplayError(fixture("display-xcb.txt"));
    expect(suggestion).toContain(
      "AUTOMOBILE_EMULATOR_HEADLESS=true (adds -no-window; audio stays on)",
    );
    expect(suggestion).toContain(
      "Do not add -no-audio (AUTOMOBILE_EMULATOR_AUDIO=false) when tests record or play audio",
    );
  });

  test("launchFailureCategory and accelerationCheckCategory", () => {
    expect(launchFailureCategory(fixture("missing-shared-library.txt"))).toBe(
      "missing_shared_library",
    );
    expect(launchFailureCategory(fixture("kvm-permission.txt"))).toBe("kvm_permission_denied");
    expect(launchFailureCategory(fixture("acceleration-unavailable.txt"))).toBeUndefined();
    expect(accelerationCheckCategory(fixture("kvm-permission.txt"))).toBe("kvm_permission_denied");
    expect(accelerationCheckCategory(fixture("acceleration-unavailable.txt"))).toBe(
      "hardware_acceleration_unavailable",
    );
    expect(accelerationCheckCategory(fixture("normal-startup.txt"))).toBeUndefined();
  });

  test("detectDeviceIdFromEmulatorOutput derives the serial from the console port", () => {
    expect(detectDeviceIdFromEmulatorOutput(fixture("startup-console-port.txt"))).toBe(
      "emulator-5556",
    );
    expect(detectDeviceIdFromEmulatorOutput("device emulator-5554 ready")).toBe("emulator-5554");
    expect(detectDeviceIdFromEmulatorOutput("console port 5555")).toBeUndefined();
    expect(detectDeviceIdFromEmulatorOutput(fixture("normal-startup.txt"))).toBeUndefined();
  });
});
