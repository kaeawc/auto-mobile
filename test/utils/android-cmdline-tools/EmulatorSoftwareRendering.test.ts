import { describe, expect, test } from "bun:test";
import {
  detectSoftwareRenderingFallback,
  emulatorVersionFallsBackToSoftware,
  parseEmulatorVersion,
  resolveEffectiveGpuMode,
} from "../../../src/utils/android-cmdline-tools/EmulatorSoftwareRendering";

const version = (v: string) => `Android emulator version ${v} (build_id 16416033) (CL:N/A)`;

describe("EmulatorSoftwareRendering", () => {
  test("parses emulator -version output", () => {
    expect(parseEmulatorVersion(version("37.2.11.0"))).toEqual([37, 2, 11]);
    expect(parseEmulatorVersion("garbage")).toBeNull();
  });

  test("37.2 and later fall back, 37.1 does not", () => {
    expect(emulatorVersionFallsBackToSoftware([37, 1, 11])).toBe(false);
    expect(emulatorVersionFallsBackToSoftware([37, 2, 11])).toBe(true);
    expect(emulatorVersionFallsBackToSoftware([38, 0, 0])).toBe(true);
  });

  test("launch flags win over config.ini, and GuestAngle counts as ANGLE", () => {
    expect(resolveEffectiveGpuMode("auto", ["-gpu", "host"])).toEqual({
      mode: "host",
      source: "launch-args",
    });
    expect(resolveEffectiveGpuMode(undefined, ["-feature", "GuestAngle"]).mode).toBe("angle");
    expect(resolveEffectiveGpuMode("host")).toEqual({ mode: "host", source: "avd-config" });
    expect(resolveEffectiveGpuMode(undefined)).toEqual({ mode: "auto", source: "default" });
  });

  test("flags auto mode on macOS with an affected emulator", () => {
    const risk = detectSoftwareRenderingFallback({
      platform: "darwin",
      emulatorVersionOutput: version("37.2.11.0"),
      avdGpuMode: "auto",
    });
    expect(risk?.emulatorVersion).toBe("37.2.11");
  });

  test.each([
    ["linux", "37.2.11.0", "auto", []],
    ["darwin", "37.1.11.0", "auto", []],
    ["darwin", "37.2.11.0", "host", []],
    ["darwin", "37.2.11.0", undefined, ["-gpu", "host"]],
    ["darwin", "37.2.11.0", undefined, ["-feature", "GuestAngle"]],
  ] as const)("does not flag %s %s gpu=%s args=%j", (platform, v, gpu, args) => {
    expect(
      detectSoftwareRenderingFallback({
        platform,
        emulatorVersionOutput: version(v),
        avdGpuMode: gpu,
        launchArgs: args,
      }),
    ).toBeNull();
  });

  test("ignores unparseable version output", () => {
    expect(
      detectSoftwareRenderingFallback({
        platform: "darwin",
        emulatorVersionOutput: "",
        avdGpuMode: undefined,
      }),
    ).toBeNull();
  });
});
