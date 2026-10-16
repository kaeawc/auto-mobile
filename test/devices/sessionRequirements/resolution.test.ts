import { describe, expect, test } from "bun:test";
import {
  matchSessionDevice,
  normalizeSessionDeviceRequirement,
  resolveSessionDeviceProfile,
  type AndroidSessionDeviceRequirement,
  type IosSessionDeviceRequirement,
} from "../../../src/devices/sessionRequirements";
import {
  IOS_DUO,
  IOS_IPAD_AIR_11,
  IOS_PRO,
  IOS_PRO_MAX,
  androidCatalog,
  androidDefaults,
  iosCatalog,
  iosDefaults,
  unwrap,
  unwrapError,
} from "./fixtures";

function normalizeIos(
  request: IosSessionDeviceRequirement,
  defaults = iosDefaults(),
  catalog = iosCatalog(),
) {
  return unwrap(normalizeSessionDeviceRequirement(request, defaults, catalog));
}

function normalizeAndroid(
  request: AndroidSessionDeviceRequirement,
  defaults = androidDefaults(),
  catalog = androidCatalog(),
) {
  return unwrap(normalizeSessionDeviceRequirement(request, defaults, catalog));
}

describe("normalization and hardware defaults", () => {
  test("applies only omitted predicates before pool matching", () => {
    const request: IosSessionDeviceRequirement = {
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "omitted" },
      os: { kind: "omitted" },
    };
    const normalized = normalizeIos(request);

    expect(normalized.effective).toEqual({
      hardware: { kind: "archetype", archetype: "phone" },
      os: { kind: "exact", version: "27" },
    });
    expect(normalized.provenance.defaultsApplied).toEqual(["hardware-archetype", "os-predicate"]);
    expect(
      matchSessionDevice(normalized, {
        platform: "ios",
        metadataState: "current",
        simulatorDeviceTypeIdentifier: IOS_PRO.simulatorDeviceTypeIdentifier,
        modelIdentifier: IOS_PRO.modelIdentifier,
        archetype: "phone",
        modelType: IOS_PRO.modelType,
        runtimeId: "runtime-27",
        osVersion: "27.0.0",
      }),
    ).toEqual({ kind: "match" });
  });

  test("descends archetype to type to exact model only on creation resolution", () => {
    const defaults = iosDefaults();
    const catalog = iosCatalog();
    const normalized = normalizeIos(
      {
        schemaVersion: 1,
        platform: "ios",
        hardware: { kind: "archetype", archetype: "tablet" },
        os: { kind: "exact", version: "27" },
      },
      defaults,
      catalog,
    );
    const resolved = unwrap(resolveSessionDeviceProfile(normalized, defaults, catalog));

    expect(resolved.platform).toBe("ios");
    if (resolved.platform !== "ios") {
      throw new Error("Expected iOS resolution.");
    }
    expect(resolved.profile.simulatorDeviceTypeIdentifier).toBe(
      IOS_IPAD_AIR_11.simulatorDeviceTypeIdentifier,
    );
    expect(resolved.provenance.hardwareDefaultPath).toEqual([
      "tablet",
      "iPad air 11-inch",
      IOS_IPAD_AIR_11.simulatorDeviceTypeIdentifier,
    ]);
    expect(resolved.provenance.resolvedHardwareBy).toBe("archetype-default");
  });

  test("explicit model skips archetype and model-type defaults", () => {
    const defaults = iosDefaults({
      hardware: { omitted: "phone", archetypes: [], modelTypes: [] },
    });
    const catalog = iosCatalog();
    const normalized = normalizeIos(
      {
        schemaVersion: 1,
        platform: "ios",
        hardware: {
          kind: "exact-model",
          model: { namespace: "product-model", value: "iPhone18,1" },
        },
        os: { kind: "exact", version: "27" },
      },
      defaults,
      catalog,
    );
    const resolved = unwrap(resolveSessionDeviceProfile(normalized, defaults, catalog));

    expect(resolved.profile.simulatorDeviceTypeIdentifier).toBe(
      IOS_PRO.simulatorDeviceTypeIdentifier,
    );
    expect(resolved.provenance.resolvedHardwareBy).toBe("explicit-model");
    expect(resolved.provenance.hardwareDefaultPath).toEqual([]);
  });

  test("explicit model type skips the archetype default", () => {
    const defaults = iosDefaults({
      hardware: {
        omitted: "phone",
        archetypes: [],
        modelTypes: [
          {
            modelType: { family: "iphone", variant: "pro" },
            model: { namespace: "product-model", value: "iPhone18,1" },
          },
        ],
      },
    });
    const catalog = iosCatalog();
    const normalized = normalizeIos(
      {
        schemaVersion: 1,
        platform: "ios",
        hardware: {
          kind: "model-type",
          modelType: { family: "iphone", variant: "pro" },
        },
        os: { kind: "exact", version: "27" },
      },
      defaults,
      catalog,
    );
    const resolved = unwrap(resolveSessionDeviceProfile(normalized, defaults, catalog));

    expect(resolved.profile.simulatorDeviceTypeIdentifier).toBe(
      IOS_PRO.simulatorDeviceTypeIdentifier,
    );
    expect(resolved.provenance.resolvedHardwareBy).toBe("model-type-default");
  });

  test("reports missing and conflicting defaults as typed config errors", () => {
    const catalog = iosCatalog();
    const missingDefaults = iosDefaults({
      hardware: { omitted: "phone", archetypes: [], modelTypes: [] },
    });
    const normalized = normalizeIos(
      {
        schemaVersion: 1,
        platform: "ios",
        hardware: { kind: "archetype", archetype: "phone" },
        os: { kind: "exact", version: "27" },
      },
      missingDefaults,
      catalog,
    );
    expect(
      unwrapError(resolveSessionDeviceProfile(normalized, missingDefaults, catalog)).code,
    ).toBe("invalid_config");

    const conflictingDefaults = iosDefaults({
      hardware: {
        ...iosDefaults().hardware,
        archetypes: [
          ...iosDefaults().hardware.archetypes,
          {
            archetype: "phone",
            modelType: { family: "iphone", variant: "pro" },
          },
        ],
      },
    });
    expect(
      unwrapError(
        resolveSessionDeviceProfile(
          normalizeIos(
            {
              schemaVersion: 1,
              platform: "ios",
              hardware: { kind: "archetype", archetype: "phone" },
              os: { kind: "exact", version: "27" },
            },
            conflictingDefaults,
            catalog,
          ),
          conflictingDefaults,
          catalog,
        ),
      ).code,
    ).toBe("invalid_config");
  });
});

describe("Duo capability policy", () => {
  test.each([
    {
      kind: "archetype" as const,
      archetype: "duo" as const,
    },
    {
      kind: "model-type" as const,
      modelType: { family: "duo" as const, variant: "duo" as const },
    },
    {
      kind: "exact-model" as const,
      model: { namespace: "alias" as const, value: "duo-preview" },
    },
  ])("refuses recognized Duo selector %# before resolution", (hardware) => {
    const result = normalizeSessionDeviceRequirement(
      {
        schemaVersion: 1,
        platform: "ios",
        hardware,
        os: { kind: "exact", version: "27" },
      },
      iosDefaults(),
      iosCatalog(),
    );

    expect(unwrapError(result).code).toBe("capability_disabled");
  });

  test("an omitted default resolving to Duo needs no installed Duo profile", () => {
    const result = normalizeSessionDeviceRequirement(
      {
        schemaVersion: 1,
        platform: "ios",
        hardware: { kind: "omitted" },
        os: { kind: "omitted" },
      },
      iosDefaults({
        hardware: { omitted: "duo", archetypes: [], modelTypes: [] },
      }),
      iosCatalog({ models: [], releases: [] }),
    );

    expect(unwrapError(result).code).toBe("capability_disabled");
  });

  test("a known Duo farther down a phone default path cannot bypass refusal", () => {
    const defaults = iosDefaults({
      hardware: {
        ...iosDefaults().hardware,
        modelTypes: iosDefaults().hardware.modelTypes.map((entry) =>
          entry.modelType.family === "iphone" && entry.modelType.variant === "pro-max"
            ? {
                ...entry,
                model: { namespace: "alias" as const, value: "duo-preview" },
              }
            : entry,
        ),
      },
    });
    const result = normalizeSessionDeviceRequirement(
      {
        schemaVersion: 1,
        platform: "ios",
        hardware: { kind: "omitted" },
        os: { kind: "omitted" },
      },
      defaults,
      iosCatalog(),
    );

    expect(unwrapError(result).code).toBe("capability_disabled");
  });

  test("Duo remains distinct from phone even when its name starts with iPhone", () => {
    const normalized = normalizeIos({
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "archetype", archetype: "phone" },
      os: { kind: "major", major: 27 },
    });

    expect(
      matchSessionDevice(normalized, {
        platform: "ios",
        metadataState: "current",
        simulatorDeviceTypeIdentifier: IOS_DUO.simulatorDeviceTypeIdentifier,
        modelIdentifier: IOS_DUO.modelIdentifier,
        archetype: "duo",
        modelType: IOS_DUO.modelType,
        runtimeId: "duo-runtime",
        osVersion: "27",
      }),
    ).toEqual({ kind: "mismatch", reason: "hardware" });
  });
});

describe("iOS catalog and OS resolution", () => {
  test("resolves an unambiguous namespaced simulator device type", () => {
    const catalog = iosCatalog();
    const defaults = iosDefaults();
    const normalized = normalizeIos(
      {
        schemaVersion: 1,
        platform: "ios",
        hardware: {
          kind: "exact-model",
          model: {
            namespace: "simulator-device-type",
            value: IOS_PRO.simulatorDeviceTypeIdentifier,
          },
        },
        os: { kind: "exact", version: "27" },
      },
      defaults,
      catalog,
    );

    expect(
      unwrap(resolveSessionDeviceProfile(normalized, defaults, catalog)).profile,
    ).toMatchObject({
      simulatorDeviceTypeIdentifier: IOS_PRO.simulatorDeviceTypeIdentifier,
      modelIdentifier: IOS_PRO.modelIdentifier,
    });
  });

  test("reports missing, ambiguous, stale, and unclassified exact model metadata", () => {
    const exactRequest = (value: string): IosSessionDeviceRequirement => ({
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "exact-model", model: { namespace: "alias", value } },
      os: { kind: "exact", version: "27" },
    });

    expect(
      unwrapError(
        normalizeSessionDeviceRequirement(exactRequest("missing"), iosDefaults(), iosCatalog()),
      ).code,
    ).toBe("unsupported_hardware");

    const ambiguous = iosCatalog({
      models: [
        { ...IOS_PRO, aliases: ["shared"] },
        { ...IOS_PRO_MAX, aliases: ["shared"] },
      ],
    });
    expect(
      unwrapError(
        normalizeSessionDeviceRequirement(exactRequest("shared"), iosDefaults(), ambiguous),
      ).code,
    ).toBe("ambiguous_model_alias");

    const stale = iosCatalog({
      models: [{ ...IOS_PRO, aliases: ["stale"], metadataState: "stale" }],
    });
    expect(
      unwrapError(normalizeSessionDeviceRequirement(exactRequest("stale"), iosDefaults(), stale))
        .code,
    ).toBe("catalog_metadata_invalid");

    const unknown = iosCatalog({
      models: [
        {
          ...IOS_PRO,
          aliases: ["unknown"],
          archetype: undefined,
          modelType: undefined,
        },
      ],
    });
    expect(
      unwrapError(
        normalizeSessionDeviceRequirement(exactRequest("unknown"), iosDefaults(), unknown),
      ).code,
    ).toBe("catalog_metadata_invalid");
  });

  test("keeps unavailable catalogs and invalid default policy distinct", () => {
    const request: IosSessionDeviceRequirement = {
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "archetype", archetype: "phone" },
      os: { kind: "exact", version: "27" },
    };
    const unavailable = normalizeSessionDeviceRequirement(
      request,
      iosDefaults(),
      iosCatalog({
        provenance: {
          source: "fake-simctl",
          revision: "failed-read",
          state: "unavailable",
          message: "simctl catalog read failed",
        },
      }),
    );
    const catalogError = unwrapError(unavailable);
    expect(catalogError).toMatchObject({
      code: "catalog_unavailable",
      transient: true,
      message: "simctl catalog read failed",
    });

    const invalidDefaults = normalizeSessionDeviceRequirement(
      request,
      iosDefaults({
        os: { selector: { kind: "minimum", version: "28" }, preferredVersion: "27" },
      }),
      iosCatalog(),
    );
    expect(unwrapError(invalidDefaults).code).toBe("invalid_config");
  });

  test("prefers configured release for major/minimum then falls back to highest satisfying", () => {
    const catalog = iosCatalog();
    const defaults = iosDefaults();
    for (const os of [
      { kind: "major" as const, major: 27 },
      { kind: "minimum" as const, version: "27" },
    ]) {
      const normalized = normalizeIos(
        {
          schemaVersion: 1,
          platform: "ios",
          hardware: {
            kind: "exact-model",
            model: { namespace: "product-model", value: "iPhone18,1" },
          },
          os,
        },
        defaults,
        catalog,
      );
      const resolved = unwrap(resolveSessionDeviceProfile(normalized, defaults, catalog));
      expect(resolved.profile.osVersion).toBe("27.0");
      expect(resolved.provenance.resolvedOsBy).toBe("preferred-default");
    }

    const fallbackDefaults = iosDefaults({
      os: { selector: { kind: "exact", version: "26" }, preferredVersion: "26" },
    });
    const fallback = normalizeIos(
      {
        schemaVersion: 1,
        platform: "ios",
        hardware: {
          kind: "exact-model",
          model: { namespace: "product-model", value: "iPhone18,1" },
        },
        os: { kind: "major", major: 27 },
      },
      fallbackDefaults,
      catalog,
    );
    const resolvedFallback = unwrap(
      resolveSessionDeviceProfile(fallback, fallbackDefaults, catalog),
    );
    expect(resolvedFallback.profile.osVersion).toBe("27.0.1");
    expect(resolvedFallback.provenance.resolvedOsBy).toBe("highest-satisfying");
  });

  test("resolution is independent of catalog ordering", () => {
    const base = iosCatalog();
    const orders = [
      base.releases,
      [...base.releases].reverse(),
      [base.releases[1], base.releases[2], base.releases[0]],
    ];
    const selected = orders.map((releases) => {
      const catalog = iosCatalog({ releases });
      const defaults = iosDefaults({
        os: { selector: { kind: "exact", version: "26" }, preferredVersion: "26" },
      });
      const normalized = normalizeIos(
        {
          schemaVersion: 1,
          platform: "ios",
          hardware: {
            kind: "exact-model",
            model: { namespace: "product-model", value: "iPhone18,1" },
          },
          os: { kind: "minimum", version: "27" },
        },
        defaults,
        catalog,
      );
      return unwrap(resolveSessionDeviceProfile(normalized, defaults, catalog)).profile.osVersion;
    });

    expect(selected).toEqual(["28", "28", "28"]);
  });

  test("never widens exact OS or repairs an incompatible exact pair", () => {
    const withoutExact = iosCatalog({
      releases: iosCatalog().releases.filter((release) => release.osVersion !== "27.0"),
    });
    const defaults = iosDefaults();
    const normalized = normalizeIos(
      {
        schemaVersion: 1,
        platform: "ios",
        hardware: {
          kind: "exact-model",
          model: { namespace: "product-model", value: "iPhone18,1" },
        },
        os: { kind: "exact", version: "27" },
      },
      defaults,
      withoutExact,
    );
    expect(unwrapError(resolveSessionDeviceProfile(normalized, defaults, withoutExact)).code).toBe(
      "missing_installed_runtime",
    );

    const incompatibleCatalog = iosCatalog({
      models: [{ ...IOS_PRO, minOsVersion: "28" }],
    });
    const incompatible = normalizeIos(
      {
        schemaVersion: 1,
        platform: "ios",
        hardware: {
          kind: "exact-model",
          model: { namespace: "product-model", value: "iPhone18,1" },
        },
        os: { kind: "exact", version: "27" },
      },
      defaults,
      incompatibleCatalog,
    );
    expect(
      unwrapError(resolveSessionDeviceProfile(incompatible, defaults, incompatibleCatalog)).code,
    ).toBe("runtime_incompatible");
  });

  test("preserves original, effective, and resolved provenance", () => {
    const request: IosSessionDeviceRequirement = {
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "omitted" },
      os: { kind: "exact", version: "027.0.0" },
    };
    const defaults = iosDefaults();
    const catalog = iosCatalog();
    const normalized = normalizeIos(request, defaults, catalog);
    const resolved = unwrap(resolveSessionDeviceProfile(normalized, defaults, catalog));

    expect(resolved.provenance.original).toEqual(request);
    expect(resolved.provenance.effective).toEqual(normalized.effective);
    expect(resolved.provenance.effective.os).toEqual({ kind: "exact", version: "27" });
    expect(resolved.provenance.policyVersion).toBe("defaults-ios-1");
    expect(resolved.provenance.catalogRevision).toBe("catalog-ios-1");
    expect(resolved.profile.simulatorDeviceTypeIdentifier).toBe(
      IOS_PRO_MAX.simulatorDeviceTypeIdentifier,
    );
  });
});

describe("Android catalog and default resolution", () => {
  test("resolves only configured phone/tablet profiles with explicit image policy", () => {
    const defaults = androidDefaults();
    const catalog = androidCatalog();
    const normalized = normalizeAndroid(
      {
        schemaVersion: 1,
        platform: "android",
        hardware: { kind: "archetype", archetype: "tablet" },
        os: { kind: "exact", version: "15" },
      },
      defaults,
      catalog,
    );
    const resolved = unwrap(resolveSessionDeviceProfile(normalized, defaults, catalog));

    expect(resolved.profile).toMatchObject({
      platform: "android",
      profileId: "pixel_tablet",
      archetype: "tablet",
      systemImagePackage: "system-images;android-35;google_apis;arm64-v8a",
      apiLevel: 35,
      abi: "arm64-v8a",
      flavor: "google_apis",
    });
  });

  test("fails honestly when Android metadata cannot prove requested exact precision", () => {
    const majorOnly = androidCatalog({
      releases: androidCatalog().releases.filter((release) => release.osVersion === "15"),
    });
    const defaults = androidDefaults();
    const precise = normalizeAndroid(
      {
        schemaVersion: 1,
        platform: "android",
        hardware: { kind: "archetype", archetype: "phone" },
        os: { kind: "exact", version: "15.0.1" },
      },
      defaults,
      majorOnly,
    );

    expect(unwrapError(resolveSessionDeviceProfile(precise, defaults, majorOnly)).code).toBe(
      "unsupported_version_precision",
    );

    const normalizedTrailingZeros = normalizeAndroid(
      {
        schemaVersion: 1,
        platform: "android",
        hardware: { kind: "archetype", archetype: "phone" },
        os: { kind: "exact", version: "15.0.0" },
      },
      defaults,
      majorOnly,
    );
    expect(
      unwrap(resolveSessionDeviceProfile(normalizedTrailingZeros, defaults, majorOnly)).profile
        .osVersion,
    ).toBe("15");
  });

  test("uses exact patch metadata and keeps selection catalog-order independent", () => {
    const defaults = androidDefaults();
    const request: AndroidSessionDeviceRequirement = {
      schemaVersion: 1,
      platform: "android",
      hardware: { kind: "archetype", archetype: "phone" },
      os: { kind: "exact", version: "15.0.1" },
    };
    const base = androidCatalog();

    const packages = [base.releases, [...base.releases].reverse()].map((releases) => {
      const catalog = androidCatalog({ releases });
      const normalized = normalizeAndroid(request, defaults, catalog);
      return unwrap(resolveSessionDeviceProfile(normalized, defaults, catalog)).profile;
    });

    expect(packages[0].systemImagePackage).toBe("system-images;android-35.1;google_apis;arm64-v8a");
    expect(packages[1]).toEqual(packages[0]);
  });

  test("reports missing defaults and stale source metadata distinctly", () => {
    const catalog = androidCatalog();
    const missing = androidDefaults({
      hardware: { omitted: "phone", profiles: [] },
    });
    const normalized = normalizeAndroid(
      {
        schemaVersion: 1,
        platform: "android",
        hardware: { kind: "archetype", archetype: "phone" },
        os: { kind: "exact", version: "15" },
      },
      missing,
      catalog,
    );
    expect(unwrapError(resolveSessionDeviceProfile(normalized, missing, catalog)).code).toBe(
      "invalid_config",
    );

    const stale = androidCatalog({
      releases: androidCatalog().releases.map((release) => ({
        ...release,
        metadataState: "stale",
      })),
    });
    const staleNormalized = normalizeAndroid(
      {
        schemaVersion: 1,
        platform: "android",
        hardware: { kind: "archetype", archetype: "phone" },
        os: { kind: "exact", version: "15" },
      },
      androidDefaults(),
      stale,
    );
    expect(
      unwrapError(resolveSessionDeviceProfile(staleNormalized, androidDefaults(), stale)).code,
    ).toBe("catalog_metadata_invalid");
  });
});

describe("Android system image selection", () => {
  const image = (flavor: string, version = "16") => ({
    systemImagePackage: `system-images;android-36;${flavor};arm64-v8a`,
    osVersion: version,
    versionPrecision: "major" as const,
    apiLevel: 36,
    abi: "arm64-v8a",
    flavor,
    installed: true,
    metadataState: "current" as const,
  });
  const resolveWith = (
    releases: ReturnType<typeof image>[],
    os: object = { kind: "major", major: 16 },
  ) => {
    const catalog = androidCatalog({ releases });
    const defaults = androidDefaults();
    const normalized = normalizeAndroid(
      {
        schemaVersion: 1,
        platform: "android",
        hardware: { kind: "archetype", archetype: "phone" },
        os: os as never,
      },
      defaults,
      catalog,
    );
    return resolveSessionDeviceProfile(normalized, defaults, catalog);
  };

  test("prefers google_apis over google_apis_playstore regardless of catalog order", () => {
    for (const releases of [
      [image("google_apis_playstore"), image("google_apis")],
      [image("google_apis"), image("google_apis_playstore")],
    ]) {
      expect(unwrap(resolveWith(releases)).profile).toMatchObject({ flavor: "google_apis" });
    }
  });

  test("falls back to package order when no google_apis image is installed", () => {
    const resolved = unwrap(resolveWith([image("google_apis_playstore"), image("default")]));
    expect(resolved.profile).toMatchObject({ flavor: "default" });
  });

  test("an installed image with an unrecognized release does not poison other selectors (#12788)", () => {
    const unknown = { ...image("google_apis"), apiLevel: 99, osVersion: undefined as never };
    const resolved = unwrap(resolveWith([unknown, image("google_apis")]));
    expect(resolved.profile).toMatchObject({ osVersion: "16" });

    const missing = unwrapError(
      resolveWith([unknown, image("google_apis")], { kind: "major", major: 14 }),
    );
    expect(missing.code).toBe("missing_installed_runtime");
    expect(missing.message).toContain("not recognized");
  });

  test("an API level used as os names the release version in the error", () => {
    const error = unwrapError(resolveWith([image("google_apis")], { kind: "major", major: 36 }));
    expect(error.code).toBe("missing_installed_runtime");
    expect(error.message).toContain("release version");
    expect(error.message).toContain("API level 36 is Android 16");
  });
});
