import { describe, expect, test } from "bun:test";
import {
  matchSessionDevice,
  normalizeSessionDeviceRequirement,
  type IosSessionDeviceProfile,
  type SessionDeviceRequirement,
} from "../../../src/devices/sessionRequirements";
import {
  androidCatalog,
  androidDefaults,
  IOS_IPAD_AIR_11,
  IOS_PRO,
  IOS_PRO_MAX,
  iosCatalog,
  iosDefaults,
  unwrap,
} from "./fixtures";

function normalize(request: SessionDeviceRequirement) {
  return unwrap(normalizeSessionDeviceRequirement(request, iosDefaults(), iosCatalog()));
}

function iosCandidate(overrides: Partial<IosSessionDeviceProfile> = {}): IosSessionDeviceProfile {
  return {
    platform: "ios",
    metadataState: "current",
    simulatorDeviceTypeIdentifier: IOS_PRO.simulatorDeviceTypeIdentifier,
    modelIdentifier: IOS_PRO.modelIdentifier,
    archetype: IOS_PRO.archetype,
    modelType: IOS_PRO.modelType,
    runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
    osVersion: "27",
    ...overrides,
  };
}

describe("session device predicate matching", () => {
  test("keeps Pro distinct from Pro Max without consulting display names", () => {
    const requirement = normalize({
      schemaVersion: 1,
      platform: "ios",
      hardware: {
        kind: "model-type",
        modelType: { family: "iphone", variant: "pro" },
      },
      os: { kind: "major", major: 27 },
    });
    const misleadingName = {
      ...iosCandidate({
        simulatorDeviceTypeIdentifier: IOS_PRO_MAX.simulatorDeviceTypeIdentifier,
        modelIdentifier: IOS_PRO_MAX.modelIdentifier,
        archetype: IOS_PRO_MAX.archetype,
        modelType: IOS_PRO_MAX.modelType,
      }),
      name: "Definitely iPhone Pro",
    };

    expect(matchSessionDevice(requirement, misleadingName)).toEqual({
      kind: "mismatch",
      reason: "hardware",
    });
    expect(matchSessionDevice(requirement, iosCandidate())).toEqual({ kind: "match" });
  });

  test("keeps iPad family size in model-type membership", () => {
    const requirement = normalize({
      schemaVersion: 1,
      platform: "ios",
      hardware: {
        kind: "model-type",
        modelType: { family: "ipad", variant: "air", sizeInches: "11.0" },
      },
      os: { kind: "major", major: 27 },
    });

    expect(
      matchSessionDevice(
        requirement,
        iosCandidate({
          simulatorDeviceTypeIdentifier: IOS_IPAD_AIR_11.simulatorDeviceTypeIdentifier,
          modelIdentifier: IOS_IPAD_AIR_11.modelIdentifier,
          archetype: "tablet",
          modelType: { family: "ipad", variant: "air", sizeInches: "11" },
        }),
      ),
    ).toEqual({ kind: "match" });
    expect(
      matchSessionDevice(
        requirement,
        iosCandidate({
          archetype: "tablet",
          modelType: { family: "ipad", variant: "air", sizeInches: "13" },
        }),
      ),
    ).toEqual({ kind: "mismatch", reason: "hardware" });
  });

  test("an omitted iPad size accepts any size in the requested family", () => {
    const requirement = normalize({
      schemaVersion: 1,
      platform: "ios",
      hardware: {
        kind: "model-type",
        modelType: { family: "ipad", variant: "air" },
      },
      os: { kind: "major", major: 27 },
    });

    expect(
      matchSessionDevice(
        requirement,
        iosCandidate({
          archetype: "tablet",
          modelType: { family: "ipad", variant: "air", sizeInches: "13" },
        }),
      ),
    ).toEqual({ kind: "match" });
  });

  test("coarse explicit phone accepts any classified phone", () => {
    const requirement = normalize({
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "archetype", archetype: "phone" },
      os: { kind: "major", major: 27 },
    });

    expect(
      matchSessionDevice(
        requirement,
        iosCandidate({
          simulatorDeviceTypeIdentifier: IOS_PRO_MAX.simulatorDeviceTypeIdentifier,
          modelIdentifier: IOS_PRO_MAX.modelIdentifier,
          modelType: IOS_PRO_MAX.modelType,
        }),
      ),
    ).toEqual({ kind: "match" });
  });

  test.each([
    ["27.0.0", true],
    ["27.0.1", false],
    ["27.1", false],
  ])("exact 27.0 against %s is %s", (osVersion, matches) => {
    const requirement = normalize({
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "archetype", archetype: "phone" },
      os: { kind: "exact", version: "27.0" },
    });

    expect(matchSessionDevice(requirement, iosCandidate({ osVersion })).kind).toBe(
      matches ? "match" : "mismatch",
    );
  });

  test("major and minimum predicates compare numeric releases", () => {
    const major = normalize({
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "archetype", archetype: "phone" },
      os: { kind: "major", major: 27 },
    });
    const minimum = normalize({
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "archetype", archetype: "phone" },
      os: { kind: "minimum", version: "27.0.1" },
    });

    expect(matchSessionDevice(major, iosCandidate({ osVersion: "27.9.4" })).kind).toBe("match");
    expect(matchSessionDevice(major, iosCandidate({ osVersion: "28" })).kind).toBe("mismatch");
    expect(matchSessionDevice(minimum, iosCandidate({ osVersion: "27" })).kind).toBe("mismatch");
    expect(matchSessionDevice(minimum, iosCandidate({ osVersion: "28" })).kind).toBe("match");
  });

  test("rejects stale and unknown candidate metadata", () => {
    const requirement = normalize({
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "archetype", archetype: "phone" },
      os: { kind: "major", major: 27 },
    });

    expect(matchSessionDevice(requirement, iosCandidate({ metadataState: "stale" }))).toEqual({
      kind: "mismatch",
      reason: "stale-metadata",
    });
    expect(matchSessionDevice(requirement, iosCandidate({ archetype: undefined }))).toEqual({
      kind: "mismatch",
      reason: "unknown-hardware-metadata",
    });
    expect(matchSessionDevice(requirement, iosCandidate({ osVersion: undefined }))).toEqual({
      kind: "mismatch",
      reason: "unknown-os-metadata",
    });
  });

  test("matches Android phone/tablet predicates without profile-name semantics", () => {
    const requirement = unwrap(
      normalizeSessionDeviceRequirement(
        {
          schemaVersion: 1,
          platform: "android",
          hardware: { kind: "omitted" },
          os: { kind: "minimum", version: "15" },
        },
        androidDefaults(),
        androidCatalog(),
      ),
    );
    const phone = {
      platform: "android" as const,
      metadataState: "current" as const,
      profileId: "name-claims-tablet",
      archetype: "phone" as const,
      systemImagePackage: "system-images;android-36;google_apis;arm64-v8a",
      osVersion: "16",
      versionPrecision: "major" as const,
      apiLevel: 36,
      abi: "arm64-v8a",
      flavor: "google_apis",
    };

    expect(matchSessionDevice(requirement, phone)).toEqual({ kind: "match" });
    expect(matchSessionDevice(requirement, { ...phone, archetype: "tablet" })).toEqual({
      kind: "mismatch",
      reason: "hardware",
    });
  });

  test.each([
    [{ kind: "exact", version: "15.1" }, "15.1", "major", false],
    [{ kind: "minimum", version: "15.1" }, "15.1", "major", false],
    [{ kind: "minimum", version: "15.1" }, "16", "major", true],
    [{ kind: "exact", version: "15.0.0" }, "15", "major", true],
    [{ kind: "exact", version: "15" }, "15.1", "major", false],
    [{ kind: "exact", version: "15.0.1" }, "15.0.1", "minor", false],
    [{ kind: "exact", version: "15.0.1" }, "15.0.1", "patch", true],
  ] as const)(
    "pool matching respects OS evidence: %j / %s / %s",
    (os, osVersion, versionPrecision, matches) => {
      const requirement = unwrap(
        normalizeSessionDeviceRequirement(
          {
            schemaVersion: 1,
            platform: "android",
            hardware: { kind: "archetype", archetype: "phone" },
            os,
          },
          androidDefaults(),
          androidCatalog(),
        ),
      );
      expect(
        matchSessionDevice(requirement, {
          platform: "android",
          metadataState: "current",
          archetype: "phone",
          osVersion,
          versionPrecision,
        }).kind,
      ).toBe(matches ? "match" : "mismatch");
    },
  );
});
