import { describe, expect, test } from "bun:test";
import { ProvisionDeviceError } from "../../../src/devices/exactDeviceProvisioning";
import type {
  AndroidAutoProjectionApplier,
  AndroidAutoProvisionReport,
} from "../../../src/features/androidAuto/AndroidAutoProjectionService";
import { provisionDeviceSchema } from "../../../src/features/deviceLifecycle/core/schemas";
import type { ProvisionDeviceArgs } from "../../../src/features/deviceLifecycle/deviceLifecycleCore";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  applyProvisionAndroidAuto,
  assertAndroidAutoInputsPresent,
  stopProvisionedAndroidAuto,
} from "../../../src/server/provisioning/provisioningAndroidAuto";
import { FakeTimer } from "../../fakes/FakeTimer";

const ANDROID_AUTO = { apkDirectory: "/apks" };
const ANDROID_DEVICE = {
  platform: "android" as const,
  name: "Pixel_9_Play",
  spec: { runtime: "system-images;android-36;google_apis_playstore;x86_64", deviceType: "pixel_9" },
};
const IOS_DEVICE = {
  platform: "ios" as const,
  name: "iPhone 17",
  spec: {
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
    deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
  },
};

function args(overrides: Partial<ProvisionDeviceArgs> = {}): ProvisionDeviceArgs {
  return {
    device: ANDROID_DEVICE,
    boot: true,
    readiness: "automation",
    androidAuto: ANDROID_AUTO,
    ...overrides,
  };
}

const REPORT: AndroidAutoProvisionReport = {
  steps: [{ step: "desktop-head-unit", status: "applied" }],
  desktopHeadUnit: { running: true },
};

class FakeApplier implements AndroidAutoProjectionApplier {
  readonly applied: string[] = [];
  readonly stopped: Array<{ deviceId: string; deviceStopped?: boolean }> = [];
  /** When set, apply waits on it (and on its signal) instead of returning at once. */
  pending?: Promise<void>;
  constructor(private readonly missing?: string) {}
  async stopDesktopHeadUnit(deviceId: string, options?: { deviceStopped?: boolean }) {
    this.stopped.push({ deviceId, ...options });
  }
  async resolveInputs() {
    if (this.missing) {
      throw new ActionableError(`Android Auto projection is missing ${this.missing}.`);
    }
    return {
      androidAutoApks: ["/apks/base.apk"],
      dhu: { binaryPath: "/dhu", configPath: "/dhu.ini" },
      acceptAndroidAutoTerms: false,
    };
  }
  async apply(device: { deviceId: string }, _options: unknown, signal?: AbortSignal) {
    this.applied.push(device.deviceId);
    if (this.pending) {
      await this.pending;
      signal?.throwIfAborted();
    }
    return REPORT;
  }
}

const androidDevice = { deviceId: "emulator-5554", platform: "android" as const, name: "Pixel" };

function bounds(timer: FakeTimer, signal = new AbortController().signal, budgetMs = 60_000) {
  return { signal, totalDeadlineMs: timer.now() + budgetMs };
}

describe("provisionDevice androidAuto", () => {
  test("the schema accepts androidAuto on an Android request", () => {
    const parsed = provisionDeviceSchema.parse({
      device: ANDROID_DEVICE,
      androidAuto: { ...ANDROID_AUTO, acceptAndroidAutoTerms: true },
    });
    expect(parsed.androidAuto).toEqual({ apkDirectory: "/apks", acceptAndroidAutoTerms: true });
  });

  test("the schema refuses androidAuto with boot=false or on iOS", () => {
    const noBoot = provisionDeviceSchema.safeParse({
      device: ANDROID_DEVICE,
      boot: false,
      androidAuto: ANDROID_AUTO,
    });
    expect(noBoot.success).toBe(false);
    expect(JSON.stringify(noBoot.error?.issues)).toContain("requires boot=true");
    const ios = provisionDeviceSchema.safeParse({
      device: IOS_DEVICE,
      androidAuto: ANDROID_AUTO,
    });
    expect(ios.success).toBe(false);
    expect(JSON.stringify(ios.error?.issues)).toContain("needs an Android phone emulator");
  });

  test("missing host inputs refuse before boot with a non-retryable error naming them", async () => {
    const refused = assertAndroidAutoInputsPresent(args(), {
      androidAutoProjection: new FakeApplier("the Desktop Head Unit at /sdk/dhu"),
    });
    await expect(refused).rejects.toBeInstanceOf(ProvisionDeviceError);
    await expect(refused).rejects.toMatchObject({ code: "unsupported", retryable: false });
    await expect(refused).rejects.toThrow(
      "missing the Desktop Head Unit at /sdk/dhu. Nothing was created or booted.",
    );
  });

  test("present inputs pass the preflight", async () => {
    await assertAndroidAutoInputsPresent(args(), { androidAutoProjection: new FakeApplier() });
  });

  test("applies to the booted device and returns its report", async () => {
    const applier = new FakeApplier();
    const timer = new FakeTimer();
    const report = await applyProvisionAndroidAuto(
      args(),
      { androidAutoProjection: applier, timer },
      androidDevice,
      bounds(timer),
    );
    expect(report).toEqual(REPORT);
    expect(applier.applied).toEqual(["emulator-5554"]);
  });

  test("does nothing without the option", async () => {
    const applier = new FakeApplier("never consulted");
    await assertAndroidAutoInputsPresent(args({ androidAuto: undefined }), {
      androidAutoProjection: applier,
    });
    const timer = new FakeTimer();
    expect(
      await applyProvisionAndroidAuto(
        args({ androidAuto: undefined }),
        { androidAutoProjection: applier, timer },
        androidDevice,
        bounds(timer),
      ),
    ).toBeUndefined();
    expect(applier.applied).toEqual([]);
  });

  test("an abort that lands before it does not fail a request without androidAuto", async () => {
    const applier = new FakeApplier();
    const timer = new FakeTimer();
    const aborted = new AbortController();
    aborted.abort(new Error("late abort after the session was bound"));
    expect(
      await applyProvisionAndroidAuto(
        args({ androidAuto: undefined }),
        { androidAutoProjection: applier, timer },
        androidDevice,
        bounds(timer, aborted.signal),
      ),
    ).toBeUndefined();
    expect(applier.applied).toEqual([]);
  });

  test("an abort that lands before it refuses an androidAuto request without projecting", async () => {
    const applier = new FakeApplier();
    const timer = new FakeTimer();
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));
    await expect(
      applyProvisionAndroidAuto(
        args(),
        { androidAutoProjection: applier, timer },
        androidDevice,
        bounds(timer, aborted.signal),
      ),
    ).rejects.toThrow("cancelled");
    expect(applier.applied).toEqual([]);
  });

  test("the provision's total deadline bounds the projection and stops a DHU it connects late", async () => {
    const applier = new FakeApplier();
    let release!: () => void;
    applier.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timer = new FakeTimer();
    const run = applyProvisionAndroidAuto(
      args(),
      { androidAutoProjection: applier, timer },
      androidDevice,
      bounds(timer, new AbortController().signal, 1_000),
    );
    const settled = run.then(
      () => "resolved",
      (error: unknown) => error,
    );
    timer.advanceTime(1_000);
    expect(await settled).toMatchObject({ code: "timeout" });
    expect(applier.stopped).toEqual([]);
    release();
    for (let tick = 0; tick < 5 && applier.stopped.length === 0; tick++) {
      await Promise.resolve();
    }
    expect(applier.stopped).toEqual([{ deviceId: "emulator-5554" }]);
  });

  test("stopProvisionedAndroidAuto stops only the Android device's DHU and never rejects", async () => {
    const applier = new FakeApplier();
    await stopProvisionedAndroidAuto({ androidAutoProjection: applier }, androidDevice, {
      deviceStopped: true,
    });
    await stopProvisionedAndroidAuto(
      { androidAutoProjection: applier },
      { deviceId: "SIM-1", platform: "ios", name: "iPhone" },
    );
    expect(applier.stopped).toEqual([{ deviceId: "emulator-5554", deviceStopped: true }]);

    applier.stopDesktopHeadUnit = async () => {
      throw new Error("broken applier");
    };
    await stopProvisionedAndroidAuto({ androidAutoProjection: applier }, androidDevice);
  });
});
