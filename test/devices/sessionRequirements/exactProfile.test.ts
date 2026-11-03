import { describe, expect, test } from "bun:test";
import {
  matchSessionDevice,
  normalizeSessionDeviceRequirement,
  parseSessionDeviceRequirement,
  resolveSessionDeviceProfile,
  type AndroidSessionDeviceProfile,
  type OsSelector,
  type SessionDeviceRequirement,
} from "../../../src/devices/sessionRequirements";
import { poolMatcher } from "../../../src/daemon/sessionBroker/brokerPoolMatch";
import { androidCatalog, androidDefaults, unwrap, unwrapError } from "./fixtures";

const catalog = androidCatalog({
  profiles: [
    { profileId: "pixel_phone", archetype: "phone", metadataState: "current" },
    { profileId: "pixel_9", archetype: "phone", metadataState: "current" },
    { profileId: "pixel_tablet", archetype: "tablet", metadataState: "current" },
    { profileId: "pixel_9_pro_fold", archetype: "foldable", metadataState: "current" },
    { profileId: "unclassified", metadataState: "current" },
    { profileId: "stale_profile", archetype: "phone", metadataState: "stale" },
  ],
});
const defaults = androidDefaults({
  hardware: {
    omitted: "phone",
    profiles: [
      { archetype: "phone", profileId: "pixel_phone", memoryMb: 3072 },
      { archetype: "tablet", profileId: "pixel_tablet" },
    ],
  },
});

function request(
  profileId: string,
  os: OsSelector = { kind: "omitted" },
): SessionDeviceRequirement {
  return {
    schemaVersion: 1,
    platform: "android",
    hardware: { kind: "exact-profile", profileId },
    os,
  };
}

function pooled(overrides: Partial<AndroidSessionDeviceProfile>): AndroidSessionDeviceProfile {
  return {
    platform: "android",
    metadataState: "current",
    profileId: "pixel_9",
    archetype: "phone",
    systemImagePackage: "system-images;android-35;google_apis;arm64-v8a",
    osVersion: "15",
    versionPrecision: "major",
    apiLevel: 35,
    abi: "arm64-v8a",
    flavor: "google_apis",
    memoryMb: 3072,
    ...overrides,
  };
}

describe("Android exact-profile hardware selector", () => {
  test("parses the selector and rejects malformed variants", () => {
    expect(unwrap(parseSessionDeviceRequirement(request("pixel_9")))).toMatchObject({
      hardware: { kind: "exact-profile", profileId: "pixel_9" },
    });
    expect(
      unwrapError(
        parseSessionDeviceRequirement({
          ...request("pixel_9"),
          hardware: { kind: "exact-profile", profileId: "" },
        }),
      ).field,
    ).toBe("hardware.profileId");
    expect(
      unwrapError(
        parseSessionDeviceRequirement({
          ...request("pixel_9"),
          hardware: { kind: "exact-profile", profileId: "pixel_9", archetype: "phone" },
        }),
      ).code,
    ).toBe("invalid_request");
  });

  test("resolves exactly the named profile with its archetype's sizing", () => {
    const normalized = unwrap(
      normalizeSessionDeviceRequirement(request("pixel_9"), defaults, catalog),
    );
    const resolved = unwrap(resolveSessionDeviceProfile(normalized, defaults, catalog));
    expect(resolved.profile).toMatchObject({
      profileId: "pixel_9",
      archetype: "phone",
      memoryMb: 3072,
      osVersion: "15",
    });
    expect(resolved.provenance.resolvedHardwareBy).toBe("explicit-model");
    expect(resolved.provenance.hardwareDefaultPath).toEqual(["exact-profile", "pixel_9"]);
  });

  test("a mapping naming the profile wins, and an unmapped archetype keeps the AVD's own RAM", () => {
    const named = androidDefaults({
      hardware: {
        omitted: "phone",
        profiles: [
          { archetype: "phone", profileId: "pixel_phone", memoryMb: 3072 },
          { archetype: "phone", profileId: "pixel_9", memoryMb: 4096 },
        ],
      },
    });
    const fromNamed = unwrap(
      resolveSessionDeviceProfile(
        unwrap(normalizeSessionDeviceRequirement(request("pixel_9"), named, catalog)),
        named,
        catalog,
      ),
    );
    expect(fromNamed.profile).toMatchObject({ memoryMb: 4096 });
    // No foldable mapping on this host: the exact profile is still served, unsized.
    const fold = unwrap(
      resolveSessionDeviceProfile(
        unwrap(normalizeSessionDeviceRequirement(request("pixel_9_pro_fold"), defaults, catalog)),
        defaults,
        catalog,
      ),
    );
    expect(fold.profile).toMatchObject({ profileId: "pixel_9_pro_fold", archetype: "foldable" });
    expect("memoryMb" in fold.profile).toBe(false);
  });

  test("combines with os selectors as archetypes do", () => {
    const resolved = unwrap(
      resolveSessionDeviceProfile(
        unwrap(
          normalizeSessionDeviceRequirement(
            request("pixel_tablet", { kind: "major", major: 16 }),
            defaults,
            catalog,
          ),
        ),
        defaults,
        catalog,
      ),
    );
    expect(resolved.profile).toMatchObject({
      profileId: "pixel_tablet",
      archetype: "tablet",
      osVersion: "16",
      apiLevel: 36,
    });
  });

  test("refuses uninstalled, unclassified and stale profiles before any creation", () => {
    const missing = unwrapError(
      normalizeSessionDeviceRequirement(request("pixel_10"), defaults, catalog),
    );
    expect(missing.code).toBe("unsupported_hardware");
    expect(missing.message).toContain("pixel_10");
    expect(missing.transient).toBe(false);
    const unclassified = unwrapError(
      normalizeSessionDeviceRequirement(request("unclassified"), defaults, catalog),
    );
    expect(unclassified.code).toBe("unsupported_hardware");
    expect(unclassified.message).toContain("androidProfileArchetypes");
    expect(
      unwrapError(normalizeSessionDeviceRequirement(request("stale_profile"), defaults, catalog))
        .code,
    ).toBe("catalog_metadata_invalid");
  });

  test("pool reuse requires the same profile and sizing", () => {
    const normalized = unwrap(
      normalizeSessionDeviceRequirement(request("pixel_9"), defaults, catalog),
    );
    expect(matchSessionDevice(normalized, pooled({})).kind).toBe("match");
    expect(matchSessionDevice(normalized, pooled({ profileId: "pixel_phone" }))).toEqual({
      kind: "mismatch",
      reason: "hardware",
    });
    expect(matchSessionDevice(normalized, pooled({ profileId: undefined }))).toEqual({
      kind: "mismatch",
      reason: "unknown-hardware-metadata",
    });
    // The pool hands the matcher each idle resource's stored `{ profile }` record.
    const matches = poolMatcher(normalized, defaults);
    expect(matches({ profile: pooled({}) })).toBe(true);
    expect(matches({ profile: pooled({ profileId: "pixel_phone" }) })).toBe(false);
    expect(matches({ profile: pooled({ memoryMb: undefined }) })).toBe(false);
  });

  test("an archetype request still matches any profile of that archetype", () => {
    const normalized = unwrap(
      normalizeSessionDeviceRequirement(
        {
          schemaVersion: 1,
          platform: "android",
          hardware: { kind: "archetype", archetype: "phone" },
          os: { kind: "omitted" },
        },
        defaults,
        catalog,
      ),
    );
    expect(normalized.platform === "android" && normalized.exactProfile).toBeFalsy();
    expect(matchSessionDevice(normalized, pooled({})).kind).toBe("match");
  });
});
