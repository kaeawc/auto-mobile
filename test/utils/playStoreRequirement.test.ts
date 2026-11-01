import { describe, expect, it } from "bun:test";
import { pickAndroidSystemImage } from "../../src/devices/deviceProvisioning";
import { startDeviceParametersSchema } from "../../src/features/deviceLifecycle/core/schemas";
import type { DeviceInfo } from "../../src/models/DeviceInfo";
import type { SystemImage } from "../../src/utils/android-cmdline-tools/avdmanager";
import { matchesDeviceCriteria } from "../../src/utils/deviceMatcher";

const image = (apiLevel: number, tag: string, abi = "arm64-v8a"): SystemImage => ({
  packageName: `system-images;android-${apiLevel};${tag};${abi}`,
  apiIdentifier: String(apiLevel),
  apiLevel,
  tag,
  abi,
  versionInfo: "",
});

const playStore = { requires: { playStore: true } };

describe("requires.playStore picks a Play Store image (#14302)", () => {
  it("picks the Play Store image over a same-API google_apis image", () => {
    const images = [image(36, "google_apis"), image(36, "google_apis_playstore")];
    expect(pickAndroidSystemImage(images, playStore, "arm64").tag).toBe("google_apis_playstore");
  });

  it("takes an older Play Store image over a newer image without Play", () => {
    const images = [image(36, "google_apis"), image(35, "google_apis_playstore")];
    expect(pickAndroidSystemImage(images, playStore, "arm64").packageName).toBe(
      "system-images;android-35;google_apis_playstore;arm64-v8a",
    );
  });

  it("keeps google_apis when Play is not asked for", () => {
    const images = [image(36, "google_apis"), image(36, "google_apis_playstore")];
    expect(pickAndroidSystemImage(images, {}, "arm64").tag).toBe("google_apis");
  });

  it("picks the Play car image for an automotive request", () => {
    const images = [image(34, "android-automotive"), image(34, "android-automotive-playstore")];
    expect(
      pickAndroidSystemImage(images, { ...playStore, formFactor: "automotive" }, "arm64").tag,
    ).toBe("android-automotive-playstore");
  });

  it("refuses with install guidance when no Play Store image is installed", () => {
    expect(() => pickAndroidSystemImage([image(36, "google_apis")], playStore, "arm64")).toThrow(
      /requires\.playStore.*google_apis_playstore/s,
    );
  });
});

describe("the no-Play refusal names the Play image of the requested family", () => {
  it.each([
    ["phone", "google_apis", "google_apis_playstore"],
    ["tv", "android-tv", "google-tv"],
    ["automotive", "android-automotive", "android-automotive-playstore"],
  ] as const)("%s", (formFactor, installed, suggested) => {
    let message = "";
    try {
      pickAndroidSystemImage([image(34, installed, "x86_64")], { ...playStore, formFactor }, "x64");
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain(`system-images;android-<api>;${suggested};<abi>`);
  });
});

describe("requires.playStore matches only Play Store emulators", () => {
  const avd = (runtimeId?: string): DeviceInfo => ({
    name: "Pixel",
    platform: "android",
    isRunning: false,
    ...(runtimeId ? { runtimeId } : {}),
  });
  const criteria = { platform: "android" as const, ...playStore };

  it("matches an AVD built from a Play Store image", () => {
    expect(
      matchesDeviceCriteria(
        avd("system-images;android-36;google_apis_playstore;arm64-v8a"),
        criteria,
      ),
    ).toBe(true);
  });

  it("rejects an AVD without Play, and one whose image is unknown", () => {
    expect(
      matchesDeviceCriteria(avd("system-images;android-36;google_apis;arm64-v8a"), criteria),
    ).toBe(false);
    expect(matchesDeviceCriteria(avd(), criteria)).toBe(false);
  });

  it("does not filter when Play is not asked for", () => {
    expect(
      matchesDeviceCriteria(avd("system-images;android-36;google_apis;arm64-v8a"), {
        platform: "android",
      }),
    ).toBe(true);
  });
});

describe("startDevice accepts requires.playStore", () => {
  it("parses a boolean and rejects other values", () => {
    expect(
      startDeviceParametersSchema.safeParse({ platform: "android", requires: { playStore: true } })
        .success,
    ).toBe(true);
    expect(
      startDeviceParametersSchema.safeParse({ platform: "android", requires: { playStore: "yes" } })
        .success,
    ).toBe(false);
  });
});
