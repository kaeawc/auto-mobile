import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  androidProfileFormFactor,
  androidSystemImageTagsFor,
  defaultAndroidProfileIdFor,
  formFactorFrom,
} from "../../src/models/formFactor";
import { BINDING_DEFAULT_ANDROID_DEVICE_TYPES_BY_FAMILY } from "../../src/daemon/sessionBroker/provisioning/DefaultManagedSpecResolver";

describe("formFactorFrom", () => {
  test.each([
    ["phone geometry", { width: 1080, height: 2400, density: 420 }, "phone"],
    ["tablet geometry", { width: 1600, height: 2560, density: 320 }, "tablet"],
    ["foldable profile", { deviceType: "pixel_fold" }, "foldable"],
    ["foldable hint", { hint: "7.6in Flip" }, "foldable"],
    ["missing metadata", {}, "unknown"],
    ["zero density", { width: 1080, height: 2400, density: 0 }, "unknown"],
  ] as const)("returns %s", (_name, input, expected) => {
    expect(formFactorFrom(input)).toBe(expected);
  });

  test("documents deviceType fold precedence before an explicit phone hint", () => {
    expect(formFactorFrom({ deviceType: "pixel_fold", hint: "phone" })).toBe("foldable");
  });
});

describe("formFactorFrom non-handheld form factors", () => {
  const tabletGeometry = { width: 1920, height: 1080, density: 160 };
  const phoneGeometry = { width: 454, height: 454, density: 320 };

  test.each([
    ["android-tv", "tv"],
    ["google-tv", "tv"],
    ["google-tv-ps16k", "tv"],
    ["android-wear", "watch"],
    ["android-wear-cn", "watch"],
    ["android-automotive", "automotive"],
    ["android-automotive-playstore", "automotive"],
  ] as const)(
    "classifies system-image tag %s as %s before geometry",
    (systemImageTag, expected) => {
      expect(formFactorFrom({ systemImageTag, ...tabletGeometry })).toBe(expected);
      expect(formFactorFrom({ systemImageTag, ...phoneGeometry })).toBe(expected);
    },
  );

  test.each([
    ["tv_1080p", "tv"],
    ["tv_4k", "tv"],
    ["wearos_small_round", "watch"],
    ["wearos_large_round", "watch"],
    ["wearos_rect", "watch"],
    ["wearos_square", "watch"],
    ["automotive_1024p_landscape", "automotive"],
  ] as const)("classifies profile %s as %s when there is no tag", (deviceType, expected) => {
    expect(formFactorFrom({ deviceType, ...tabletGeometry })).toBe(expected);
    expect(formFactorFrom({ deviceType, ...phoneGeometry })).toBe(expected);
  });

  test("the tag wins over a conflicting profile and over a fold name", () => {
    expect(formFactorFrom({ systemImageTag: "android-tv", deviceType: "pixel_fold" })).toBe("tv");
  });

  test("passes a non-handheld hint through", () => {
    expect(formFactorFrom({ hint: "watch" })).toBe("watch");
  });

  test.each([
    ["google_apis", "pixel_8", { width: 1080, height: 2400, density: 420 }, "phone"],
    [
      "google_apis_playstore",
      "pixel_tablet",
      { width: 1600, height: 2560, density: 320 },
      "tablet",
    ],
    ["google_apis", "pixel_fold", { width: 1080, height: 2400, density: 420 }, "foldable"],
    ["default", undefined, { width: 1600, height: 2560, density: 320 }, "tablet"],
    [undefined, undefined, {}, "unknown"],
  ] as const)(
    "keeps tag %s and profile %s on today's path",
    (systemImageTag, deviceType, geometry, expected) => {
      expect(formFactorFrom({ systemImageTag, deviceType, ...geometry })).toBe(expected);
    },
  );

  test("androidProfileFormFactor threads the tag and never calls a TV a tablet", () => {
    expect(
      androidProfileFormFactor({
        systemImageTag: "google-tv",
        profileId: "tv_4k",
        ...tabletGeometry,
      }),
    ).toBe("tv");
    expect(androidProfileFormFactor({ systemImageTag: "android-wear", ...phoneGeometry })).toBe(
      "watch",
    );
    expect(androidProfileFormFactor({ profileId: "pixel_tablet" })).toBe("tablet");
  });
});

test.each(["pixel_fold", "pixel_9_pro_fold", "pixel_10_pro_fold"])(
  "classifies fold profile %s for inventory",
  (profileId) => {
    expect(androidProfileFormFactor({ profileId })).toBe("foldable");
  },
);
test.each(["pixel_8", "pixel_tablet"])("does not classify %s as a fold", (profileId) => {
  expect(androidProfileFormFactor({ profileId })).not.toBe("foldable");
});

describe("non-handheld provisioning defaults", () => {
  const avdmanagerDevices = readFileSync(
    new URL("../fixtures/android-avdmanager/list-device.txt", import.meta.url),
    "utf8",
  );

  test.each(["tv", "watch", "automotive"] as const)(
    "the %s default profile is an avdmanager profile id of that form factor",
    (formFactor) => {
      const profileId = defaultAndroidProfileIdFor(formFactor);
      expect(avdmanagerDevices).toContain(`or "${profileId}"`);
      expect(formFactorFrom({ deviceType: profileId })).toBe(formFactor);
    },
  );

  test("the broker's family defaults are the shared provisioning defaults", () => {
    expect(BINDING_DEFAULT_ANDROID_DEVICE_TYPES_BY_FAMILY.tv).toBe("tv_1080p");
    for (const formFactor of ["tv", "watch", "automotive"] as const) {
      expect(BINDING_DEFAULT_ANDROID_DEVICE_TYPES_BY_FAMILY[formFactor]).toBe(
        defaultAndroidProfileIdFor(formFactor),
      );
    }
  });

  test("TV image tags are listed best first and each classifies as tv", () => {
    expect(androidSystemImageTagsFor("tv")).toEqual(["android-tv", "google-tv", "google-tv-ps16k"]);
    for (const tag of androidSystemImageTagsFor("tv")) {
      expect(formFactorFrom({ systemImageTag: tag })).toBe("tv");
    }
  });
});
