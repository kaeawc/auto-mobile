import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import {
  DefaultDeviceProvisioner,
  androidImageFamilyFor,
  pickAndroidSystemImage,
} from "../../src/devices/deviceProvisioning";
import { startDeviceParametersSchema } from "../../src/features/deviceLifecycle/core/schemas";
import { ActionableError } from "../../src/models/ActionableError";
import {
  parseSystemImages,
  type SystemImage,
} from "../../src/utils/android-cmdline-tools/avdmanager";
import { enrichDeviceInfoList } from "../../src/utils/android-cmdline-tools/avdDeviceInfoEnrichment";
import { DefaultDeviceMatcher } from "../../src/utils/deviceMatcher";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeAndroidAvdCreator } from "../fakes/FakeDeviceProvisioner";

const image = (apiLevel: number, tag: string, abi = "x86_64"): SystemImage => ({
  packageName: `system-images;android-${apiLevel};${tag};${abi}`,
  apiIdentifier: String(apiLevel),
  apiLevel,
  tag,
  abi,
  versionInfo: "",
});

const sdkmanagerListing = readFileSync(
  new URL("../fixtures/android-sdkmanager/list-system-images-available.txt", import.meta.url),
  "utf8",
);

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ActionableError);
    return (error as ActionableError).message;
  }
  throw new Error("expected an ActionableError");
}

describe("pickAndroidSystemImage XR selection (#16838)", () => {
  it.each([undefined, "phone", "tablet", "foldable"] as const)(
    "a %s request never picks a newer XR image over an older phone image",
    (formFactor) => {
      const images = [
        image(34, "google_apis"),
        image(36, "google-xr"),
        image(36, "android-xr-v3-playstore"),
        image(36, "ai-glasses"),
      ];

      expect(pickAndroidSystemImage(images, { formFactor }, "x64").tag).toBe("google_apis");
    },
  );

  it("a phone request with only XR images installed is refused instead of creating an XR AVD", () => {
    const message = thrownMessage(() =>
      pickAndroidSystemImage([image(34, "google-xr"), image(36, "ai-glasses")], {}, "x64"),
    );

    expect(message).toContain("No installed handheld (phone) Android system image");
  });

  it("a headset request picks only a headset image, even over a newer phone or glasses image", () => {
    const images = [image(36, "google_apis"), image(36, "ai-glasses"), image(34, "google-xr")];

    expect(pickAndroidSystemImage(images, { formFactor: "xr-headset" }, "x64").packageName).toBe(
      "system-images;android-34;google-xr;x86_64",
    );
  });

  it("a headset request prefers google-xr over the Play variants at one API level", () => {
    const images = [
      image(34, "android-xr-preview-playstore"),
      image(34, "android-xr-v3-playstore"),
      image(34, "google-xr"),
    ];

    expect(pickAndroidSystemImage(images, { formFactor: "xr-headset" }, "x64").tag).toBe(
      "google-xr",
    );
    expect(
      pickAndroidSystemImage(images.slice(0, 2), { formFactor: "xr-headset" }, "x64").tag,
    ).toBe("android-xr-v3-playstore");
  });

  it("a glasses request picks only an ai-glasses image", () => {
    const images = [image(36, "google-xr"), image(35, "ai-glasses"), image(36, "google_apis")];

    expect(pickAndroidSystemImage(images, { formFactor: "xr-glasses" }, "x64").packageName).toBe(
      "system-images;android-35;ai-glasses;x86_64",
    );
  });

  it("picks the host-ABI XR images from a captured sdkmanager listing", () => {
    const parsed = parseSystemImages(sdkmanagerListing, undefined, "available");

    expect(pickAndroidSystemImage(parsed, { formFactor: "xr-headset" }, "x64").packageName).toBe(
      "system-images;android-34;google-xr;x86_64",
    );
    expect(pickAndroidSystemImage(parsed, { formFactor: "xr-glasses" }, "arm64").packageName).toBe(
      "system-images;android-36;ai-glasses;arm64-v8a",
    );
  });

  it.each([
    ["xr-headset", "google-xr"],
    ["xr-glasses", "ai-glasses"],
  ] as const)(
    "a %s request with no image of its family names the %s package to install",
    (formFactor, tag) => {
      const message = thrownMessage(() =>
        pickAndroidSystemImage([image(36, "google_apis")], { formFactor }, "x64"),
      );

      expect(message).toContain(`system-images;android-<api>;${tag};x86_64`);
      expect(message).toContain("--channel=3");
      expect(message).toContain("does not download system images");
    },
  );

  it("requires.playStore on a headset picks only a Play XR image", () => {
    const images = [image(34, "google-xr"), image(34, "android-xr-preview-playstore")];

    expect(
      pickAndroidSystemImage(
        images,
        { formFactor: "xr-headset", requires: { playStore: true } },
        "x64",
      ).tag,
    ).toBe("android-xr-preview-playstore");
    expect(
      thrownMessage(() =>
        pickAndroidSystemImage(
          [image(34, "google-xr")],
          { formFactor: "xr-headset", requires: { playStore: true } },
          "x64",
        ),
      ),
    ).toContain("system-images;android-<api>;android-xr-v3-playstore;<abi>");
  });

  it("requires.playStore on glasses says no Play glasses image is known", () => {
    const message = thrownMessage(() =>
      pickAndroidSystemImage(
        [image(36, "ai-glasses")],
        { formFactor: "xr-glasses", requires: { playStore: true } },
        "x64",
      ),
    );

    expect(message).toContain("No Google Play xr-glasses image is known");
  });

  it.each([
    ["xr-headset", "xr_headset_device", "android-xr-headset"],
    ["xr-glasses", "ai_glasses_device", "android-xr-glasses"],
  ] as const)("a %s AVD is created with %s", (formFactor, deviceProfile, namePrefix) => {
    expect(androidImageFamilyFor(formFactor)).toMatchObject({
      kind: formFactor,
      deviceProfile,
      namePrefix,
    });
  });

  it("startDevice accepts the XR form factors", () => {
    for (const formFactor of ["xr-headset", "xr-glasses"] as const) {
      expect(
        startDeviceParametersSchema.safeParse({ platform: "android", formFactor }).success,
      ).toBe(true);
    }
  });
});

describe("a created XR AVD is found again by inventory (#16838)", () => {
  it.each([
    ["xr-headset", "google-xr", 34],
    ["xr-glasses", "ai-glasses", 36],
  ] as const)(
    "classifies the created %s AVD so a repeated request reuses it and a phone request does not",
    async (formFactor, tag, apiLevel) => {
      const avd = new FakeAndroidAvdCreator([image(apiLevel, tag)]);
      const provisioner = new DefaultDeviceProvisioner({
        iosCreator: () => undefined,
        androidCreator: () => avd,
        idGenerator: new CountingIdGenerator("uuid"),
        architecture: "x64",
      });
      const created = await provisioner.provision({ platform: "android", formFactor });
      const createCall = avd.createCalls[0];
      expect(createCall?.package).toBe(`system-images;android-${apiLevel};${tag};x86_64`);

      const [listed] = await enrichDeviceInfoList(
        {
          readConfig: async () => ({
            systemImagePackage: createCall?.package,
            deviceName: createCall?.device,
            apiLevel,
            osVersion: String(apiLevel),
          }),
        },
        [{ name: created.name, platform: "android", isRunning: true }],
      );

      expect(listed?.formFactor).toBe(formFactor);
      const matcher = new DefaultDeviceMatcher();
      const listedImages = listed ? [listed] : [];
      expect(
        matcher.matchDeviceImage({ platform: "android", formFactor }, listedImages, "LATEST")?.name,
      ).toBe(created.name);
      for (const other of ["phone", "tablet"] as const) {
        expect(
          matcher.matchDeviceImage(
            { platform: "android", formFactor: other },
            listedImages,
            "LATEST",
          ),
        ).toBeNull();
      }
    },
  );
});
