import { describe, expect, test } from "bun:test";
import {
  CachedAndroidXrDetector,
  isAndroidXr,
  XR_DEVICE_CACHE_TTL_MS,
  XR_SPATIAL_FEATURE,
  type XrDeviceIdentity,
} from "../../../src/utils/android-cmdline-tools/androidXrDevice";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { xrBackStack } from "../../helpers/xrHeadset";

const PROBE = `pm has-feature ${XR_SPATIAL_FEATURE}`;
const headset: XrDeviceIdentity = { deviceId: "emulator-5554", platform: "android" };

function adbAnswering(stdout: string): FakeAdbExecutor {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse(PROBE, createExecResult(stdout, ""));
  return adb;
}

const probes = (adb: FakeAdbExecutor): number =>
  adb.getExecutedCommands().filter((command) => command.includes(PROBE)).length;

describe("CachedAndroidXrDetector", () => {
  test("reads the spatial feature once per device within the TTL", async () => {
    const timer = new FakeTimer();
    const detector = new CachedAndroidXrDetector(timer);
    const adb = adbAnswering("true\n");

    expect(await detector.isAndroidXr({ adb, device: headset })).toBe(true);
    timer.advanceTime(XR_DEVICE_CACHE_TTL_MS - 1);
    expect(await detector.isAndroidXr({ adb, device: headset })).toBe(true);
    expect(probes(adb)).toBe(1);

    timer.advanceTime(1);
    expect(await detector.isAndroidXr({ adb, device: headset })).toBe(true);
    expect(probes(adb)).toBe(2);
  });

  test("a new device incarnation on a reused serial is probed fresh within the TTL (#19187)", async () => {
    const timer = new FakeTimer();
    let incarnation: string | undefined = "1";
    const detector = new CachedAndroidXrDetector(timer, XR_DEVICE_CACHE_TTL_MS, () => incarnation);
    const automotive = adbAnswering("false\n");
    expect(await detector.isAndroidXr({ adb: automotive, device: headset })).toBe(false);

    // killDevice, then an XR headset boots on the same serial with a new pool incarnation.
    timer.advanceTime(2 * 60_000);
    incarnation = "2";
    const xr = adbAnswering("true\n");
    expect(await detector.isAndroidXr({ adb: xr, device: headset })).toBe(true);
    expect(probes(xr)).toBe(1);
    expect(await detector.isAndroidXr({ adb: xr, device: headset })).toBe(true);
    expect(probes(xr)).toBe(1);
  });

  test("an incarnation that becomes known invalidates an answer cached without one", async () => {
    const pool: { incarnation?: string } = {};
    const detector = new CachedAndroidXrDetector(
      new FakeTimer(),
      XR_DEVICE_CACHE_TTL_MS,
      () => pool.incarnation,
    );
    expect(await detector.isAndroidXr({ adb: adbAnswering("false\n"), device: headset })).toBe(
      false,
    );
    pool.incarnation = "3";
    expect(await detector.isAndroidXr({ adb: adbAnswering("true\n"), device: headset })).toBe(true);
  });

  test("the feature wins over a provisional xr form factor that disagrees", async () => {
    const detector = new CachedAndroidXrDetector(new FakeTimer());
    expect(
      await detector.isAndroidXr({
        adb: adbAnswering("false\n"),
        device: { ...headset, formFactor: "xr-headset" },
      }),
    ).toBe(false);
    // A headset whose ro.build.characteristics lacks "xr" is still XR.
    expect(
      await detector.isAndroidXr({
        adb: adbAnswering("true\n"),
        device: { ...headset, deviceId: "b" },
      }),
    ).toBe(true);
  });

  test("reads the false answer pm has-feature prints with exit status 1, and caches it", async () => {
    const detector = new CachedAndroidXrDetector(new FakeTimer());
    const adb = new FakeAdbExecutor();
    const exitOne = Object.assign(new Error("Command failed: exit 1"), { stdout: "false\n" });
    adb.setCommandError(PROBE, new Error("adb command failed", { cause: exitOne }));

    expect(await detector.isAndroidXr({ adb, device: headset })).toBe(false);
    expect(await detector.isAndroidXr({ adb, device: headset })).toBe(false);
    expect(probes(adb)).toBe(1);
  });

  for (const formFactor of ["xr-headset", "xr-glasses", undefined] as const) {
    test(`an unreadable probe falls back to the ${formFactor ?? "absent"} form factor, uncached`, async () => {
      const detector = new CachedAndroidXrDetector(new FakeTimer());
      const adb = new FakeAdbExecutor();
      adb.setCommandError(PROBE, new Error("device offline"));

      const device = { ...headset, formFactor };
      expect(await detector.isAndroidXr({ adb, device })).toBe(formFactor !== undefined);
      expect(await detector.isAndroidXr({ adb, device })).toBe(formFactor !== undefined);
      expect(probes(adb)).toBe(2);
    });
  }

  test("without a device handle the form factor or XR System UI decides, uncached", async () => {
    const detector = new CachedAndroidXrDetector(new FakeTimer());
    expect(await detector.isAndroidXr({ device: headset })).toBe(false);
    expect(await detector.isAndroidXr({ device: headset, backStack: xrBackStack() })).toBe(true);
    expect(await detector.isAndroidXr({ device: { ...headset, formFactor: "xr-glasses" } })).toBe(
      true,
    );
    expect(await isAndroidXr({ device: headset }, detector)).toBe(false);
  });

  test("an unreadable probe also reads XR System UI from the back stack", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError(PROBE, new Error("device offline"));
    const detector = new CachedAndroidXrDetector(new FakeTimer());
    expect(await detector.isAndroidXr({ adb, device: headset, backStack: xrBackStack() })).toBe(
      true,
    );
  });

  test("a cached feature answer wins over a handle-less caller's back stack", async () => {
    const detector = new CachedAndroidXrDetector(new FakeTimer());
    expect(await detector.isAndroidXr({ adb: adbAnswering("false\n"), device: headset })).toBe(
      false,
    );
    expect(await detector.isAndroidXr({ device: headset, backStack: xrBackStack() })).toBe(false);
  });

  test("never probes a non-Android device", async () => {
    const adb = adbAnswering("true\n");
    expect(
      await new CachedAndroidXrDetector(new FakeTimer()).isAndroidXr({
        adb,
        device: {
          deviceId: "sim",
          platform: "ios",
        },
      }),
    ).toBe(false);
    expect(probes(adb)).toBe(0);
  });
});
