import { describe, expect, it } from "bun:test";
import { pickAndroidSystemImage } from "../../src/devices/deviceProvisioning";
import { startDeviceParametersSchema } from "../../src/features/deviceLifecycle/core/schemas";
import type { DeviceInfo } from "../../src/models/DeviceInfo";
import type { DeviceMatchCriteria } from "../../src/models/DeviceMatchCriteria";
import type { SystemImage } from "../../src/utils/android-cmdline-tools/avdmanager";
import {
  assertCreatableRequirements,
  isMotionCapableAutomotiveTag,
  matchesDeviceCriteria,
} from "../../src/utils/deviceMatcher";

const image = (apiLevel: number, tag: string, abi = "x86_64"): SystemImage => ({
  packageName: `system-images;android-${apiLevel};${tag};${abi}`,
  apiIdentifier: String(apiLevel),
  apiLevel,
  tag,
  abi,
  versionInfo: "",
});

const motion = {
  formFactor: "automotive" as const,
  requires: { vehicle: { motion: "supported" as const } },
};

describe("requires.vehicle.motion picks a non-Play car image (#16742)", () => {
  it("picks android-automotive over the Play-first default when both are installed", () => {
    const images = [image(34, "android-automotive-playstore"), image(34, "android-automotive")];
    expect(pickAndroidSystemImage(images, { formFactor: "automotive" }, "x64").tag).toBe(
      "android-automotive-playstore",
    );
    expect(pickAndroidSystemImage(images, motion, "x64").tag).toBe("android-automotive");
  });

  it("takes an older non-Play car image over a newer Play one", () => {
    const images = [image(35, "android-automotive-playstore"), image(34, "android-automotive")];
    expect(pickAndroidSystemImage(images, motion, "x64").packageName).toBe(
      "system-images;android-34;android-automotive;x86_64",
    );
  });

  it("refuses with the sdkmanager package when only Play car images are installed", () => {
    expect(() =>
      pickAndroidSystemImage([image(34, "android-automotive-playstore")], motion, "x64"),
    ).toThrow(/requires\.vehicle\.motion.*system-images;android-34;android-automotive;x86_64/s);
  });

  it("refuses when the API range excludes the only non-Play car image", () => {
    const images = [image(33, "android-automotive"), image(34, "android-automotive-playstore")];
    expect(() => pickAndroidSystemImage(images, { ...motion, minOsVersion: "34" }, "x64")).toThrow(
      /sdkmanager "system-images;android-34;android-automotive;x86_64"/,
    );
  });
});

describe("requires.vehicle.motion matches only non-Play car emulators", () => {
  const avd = (runtimeId?: string): DeviceInfo => ({
    name: "Car",
    platform: "android",
    isRunning: false,
    formFactor: "automotive",
    ...(runtimeId ? { runtimeId } : {}),
  });
  const criteria: DeviceMatchCriteria = { platform: "android", ...motion };

  it("matches a non-Play car AVD and rejects Play and unknown images", () => {
    expect(
      matchesDeviceCriteria(avd("system-images;android-34;android-automotive;x86_64"), criteria),
    ).toBe(true);
    expect(
      matchesDeviceCriteria(
        avd("system-images;android-34;android-automotive-playstore;x86_64"),
        criteria,
      ),
    ).toBe(false);
    expect(matchesDeviceCriteria(avd(), criteria)).toBe(false);
  });

  it("does not filter when vehicle motion is not asked for", () => {
    expect(
      matchesDeviceCriteria(avd("system-images;android-34;android-automotive-playstore;x86_64"), {
        platform: "android",
        formFactor: "automotive",
      }),
    ).toBe(true);
  });

  it.each([
    ["android-automotive", true],
    ["android-automotive-playstore", false],
    ["google_apis", false],
  ] as const)("isMotionCapableAutomotiveTag(%s) is %p", (tag, expected) => {
    expect(isMotionCapableAutomotiveTag(tag)).toBe(expected);
  });
});

describe("requires.vehicle outside an automotive Android request", () => {
  it.each([
    { platform: "ios" as const, formFactor: "automotive" as const },
    { platform: "android" as const, formFactor: "phone" as const },
    { platform: "android" as const },
  ])("refuses to create for %j", (base) => {
    expect(() => assertCreatableRequirements({ ...base, requires: motion.requires }, [])).toThrow(
      /requires\.vehicle applies to Android Automotive emulators only/,
    );
  });

  it("lets an automotive Android request be created", () => {
    expect(() => assertCreatableRequirements({ platform: "android", ...motion }, [])).not.toThrow();
  });
});

describe("startDevice accepts requires.vehicle.motion", () => {
  it("parses 'supported' and rejects other values and keys", () => {
    const parse = (requires: unknown) =>
      startDeviceParametersSchema.safeParse({
        platform: "android",
        formFactor: "automotive",
        requires,
      }).success;
    expect(parse({ vehicle: { motion: "supported" } })).toBe(true);
    expect(parse({ vehicle: { motion: "unsupported" } })).toBe(false);
    expect(parse({ vehicle: { nightMode: "supported" } })).toBe(false);
  });
});
