import { describe, expect, test } from "bun:test";
import {
  matchesRequestedAvdOrUnknown,
  nextReadinessNameCandidates,
  readinessDiagnostic,
  readinessTarget,
  readinessTimeoutError,
  rejectedReadinessDiagnostic,
  relevantScanDiagnostic,
  retryUnresolvedReadinessNames,
  unknownEmulatorName,
  unmetReadinessPredicate,
} from "../../../src/utils/android-cmdline-tools/emulatorReadinessEvaluation";
import type { BootedDeviceScan } from "../../../src/utils/android-cmdline-tools/AndroidDeviceInventoryScanner";
import type { BootedDevice, ExecResult } from "../../../src/models";

const exec = (stdout: string, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value: string) => stdout.includes(value),
});
const booted = (deviceId: string, name = unknownEmulatorName(deviceId)): BootedDevice =>
  ({ deviceId, name, platform: "android" }) as BootedDevice;
const ready = (): Parameters<typeof unmetReadinessPredicate> => [
  "emulator-5554",
  "device",
  exec("package:com.android.settings\n"),
  { sysBootCompleted: "1", bootAnimationState: "stopped" },
];

describe("unmetReadinessPredicate", () => {
  test("a fully booted device has no unmet predicate", () => {
    expect(unmetReadinessPredicate(...ready())).toBeUndefined();
  });

  test("reports each failing signal in order", () => {
    const [id, , pm] = ready();
    expect(
      unmetReadinessPredicate(id, "offline", pm, {
        sysBootCompleted: "1",
        bootAnimationState: "stopped",
      })?.phase,
    ).toBe("device-state");
    expect(
      unmetReadinessPredicate(id, "device", exec("", "Failure [x]"), {
        sysBootCompleted: "1",
        bootAnimationState: "stopped",
      })?.phase,
    ).toBe("package-manager");
    expect(
      unmetReadinessPredicate(id, "device", pm, {
        sysBootCompleted: "0",
        bootAnimationState: "stopped",
      })?.phase,
    ).toBe("system-boot-complete");
    expect(
      unmetReadinessPredicate(id, "device", pm, {
        sysBootCompleted: "1",
        bootAnimationState: "running",
      })?.phase,
    ).toBe("boot-animation");
  });

  test("benign stderr with a listing does not block; empty listing prefers stderr detail", () => {
    const [id] = ready();
    expect(
      unmetReadinessPredicate(id, "device", exec("package:a\n", "linker warning"), {
        sysBootCompleted: "1",
        bootAnimationState: "",
      }),
    ).toBeUndefined();
    const d = unmetReadinessPredicate(id, "device", exec("", "cmd: Can't find service: package"), {
      sysBootCompleted: "1",
      bootAnimationState: "",
    });
    expect(d?.summary).toContain(`observed="cmd: Can't find service: package"`);
  });
});

describe("diagnostics", () => {
  test("readinessDiagnostic collapses whitespace and truncates to 512 chars", () => {
    const d = readinessDiagnostic("device-discovery", new Error(`a\n  b ${"x".repeat(600)}`));
    expect(d.summary.startsWith("a b ")).toBe(true);
    expect(d.summary.endsWith(" [... truncated]")).toBe(true);
    expect(d.summary.length).toBe(512);
  });

  test("rejectedReadinessDiagnostic picks the last rejected check", () => {
    const ok: PromiseSettledResult<ExecResult> = { status: "fulfilled", value: exec("") };
    expect(rejectedReadinessDiagnostic([["device-state", ok]])).toBeUndefined();
    const d = rejectedReadinessDiagnostic([
      ["device-state", { status: "rejected", reason: new Error("first") }],
      ["package-manager", { status: "rejected", reason: new Error("last") }],
    ]);
    expect(d).toMatchObject({ phase: "package-manager", summary: "last" });
  });

  test("relevantScanDiagnostic filters by target when given", () => {
    const scan: BootedDeviceScan = {
      devices: [],
      diagnostics: [
        { phase: "avd-name-resolution" as const, summary: "a", deviceId: "emulator-1" },
        { phase: "avd-name-resolution" as const, summary: "b", deviceId: "emulator-2" },
      ],
    };
    expect(relevantScanDiagnostic(scan, "emulator-1")?.summary).toBe("a");
    expect(relevantScanDiagnostic(scan, undefined)?.summary).toBe("b");
  });

  test("readinessTimeoutError prefers the process exit error, else lists details", () => {
    const exit = new Error("exited") as never;
    expect(readinessTimeoutError("Pixel", 10, exit)).toBe(exit);
    const error = readinessTimeoutError("Pixel", 10, null, {
      diagnostic: { phase: "boot-animation", summary: "s" },
      target: { deviceId: "emulator-5554", state: "offline" },
    });
    expect(error.message).toBe(
      [
        "Emulator 'Pixel' failed to become ready within 10ms",
        "target=emulator-5554; state=offline",
        "Last readiness diagnostic: phase=boot-animation; summary=s",
      ].join("\n"),
    );
  });
});

describe("target and candidate selection", () => {
  test("readinessTarget requires both a device id and tracked state", () => {
    expect(readinessTarget(undefined, { state: "absent" })).toBeUndefined();
    expect(readinessTarget("emulator-1", {})).toBeUndefined();
    expect(readinessTarget("emulator-1", { state: "absent" })).toEqual({
      deviceId: "emulator-1",
      state: "absent",
    });
  });

  test("nextReadinessNameCandidates caps at 4, reserves one slot for a retry, and wraps", () => {
    const devices = ["1", "2", "3", "4", "5", "6"].map((n) => booted(`emulator-555${n}`));
    const probed = new Set<string>();
    const unresolved = new Set<string>();
    expect(nextReadinessNameCandidates(devices, probed, unresolved).map((d) => d.deviceId)).toEqual(
      ["1", "2", "3", "4"].map((n) => `emulator-555${n}`),
    );
    unresolved.add("emulator-5551");
    expect(nextReadinessNameCandidates(devices, probed, unresolved).map((d) => d.deviceId)).toEqual(
      ["emulator-5555", "emulator-5556", "emulator-5551"],
    );
    expect(unresolved.size).toBe(0);
    // Everything probed: the sets reset and the cycle restarts.
    expect(nextReadinessNameCandidates(devices, probed, unresolved)).toHaveLength(4);
  });

  test("retryUnresolvedReadinessNames queues only local still-unknown names", () => {
    const unresolved = new Set<string>();
    retryUnresolvedReadinessNames(
      [
        booted("emulator-1"),
        booted("emulator-2", "Pixel_7"),
        { ...booted("emulator-3"), foreignOwned: true },
      ],
      unresolved,
    );
    expect([...unresolved]).toEqual(["emulator-1"]);
  });

  test("matchesRequestedAvdOrUnknown", () => {
    expect(matchesRequestedAvdOrUnknown(booted("emulator-1", "Pixel"), "Pixel")).toBe(true);
    expect(matchesRequestedAvdOrUnknown(booted("emulator-1"), "Pixel")).toBe(true);
    expect(matchesRequestedAvdOrUnknown(booted("emulator-1", "Other"), "Pixel")).toBe(false);
    expect(matchesRequestedAvdOrUnknown(booted("R5CT", "Galaxy"), "Pixel", "R5CT")).toBe(true);
  });
});
