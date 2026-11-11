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
} from "../../../src/server/provisioning/provisioningAndroidAuto";

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
  constructor(private readonly missing?: string) {}
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
  async apply(device: { deviceId: string }) {
    this.applied.push(device.deviceId);
    return REPORT;
  }
}

const androidDevice = { deviceId: "emulator-5554", platform: "android" as const, name: "Pixel" };

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
    const report = await applyProvisionAndroidAuto(
      args(),
      { androidAutoProjection: applier },
      androidDevice,
    );
    expect(report).toEqual(REPORT);
    expect(applier.applied).toEqual(["emulator-5554"]);
  });

  test("does nothing without the option", async () => {
    const applier = new FakeApplier("never consulted");
    await assertAndroidAutoInputsPresent(args({ androidAuto: undefined }), {
      androidAutoProjection: applier,
    });
    expect(
      await applyProvisionAndroidAuto(
        args({ androidAuto: undefined }),
        { androidAutoProjection: applier },
        androidDevice,
      ),
    ).toBeUndefined();
    expect(applier.applied).toEqual([]);
  });
});
