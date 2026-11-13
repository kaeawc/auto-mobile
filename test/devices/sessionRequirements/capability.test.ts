import { describe, expect, test } from "bun:test";
import {
  normalizeSessionDeviceRequirement,
  querySessionRequirementCapability,
  resolveSessionDeviceProfile,
  type AndroidSessionDeviceRequirement,
  type IosSessionDeviceCatalog,
  type IosSessionDeviceRequirement,
  type IosSessionRequirementDefaults,
  type SessionDeviceCatalog,
  type SessionRequirementDefaults,
} from "../../../src/devices/sessionRequirements";
import {
  IOS_DUO,
  androidCatalog,
  androidDefaults,
  iosCatalog,
  iosDefaults,
  unwrap,
  unwrapError,
} from "./fixtures";

const release = (osVersion: string) => ({
  runtimeId: `com.apple.CoreSimulator.SimRuntime.iOS-${osVersion.replace(".", "-")}`,
  osVersion,
  installed: true,
  metadataState: "current" as const,
});

/** A Duo that can run 26.x, so a 26.5-only host can serve it when the OS is named. */
const catalog = (...versions: string[]): IosSessionDeviceCatalog =>
  iosCatalog({
    models: [
      ...iosCatalog().models.filter((m) => m !== IOS_DUO),
      { ...IOS_DUO, minOsVersion: "26" },
    ],
    releases: versions.map(release),
  });

const defaults: IosSessionRequirementDefaults = iosDefaults({
  hardware: {
    ...iosDefaults().hardware,
    archetypes: [
      ...iosDefaults().hardware.archetypes,
      { archetype: "duo", modelType: { family: "duo", variant: "duo" } },
    ],
    modelTypes: [
      ...iosDefaults().hardware.modelTypes,
      {
        modelType: { family: "duo", variant: "duo" },
        model: { namespace: "alias", value: "duo-preview" },
      },
    ],
  },
  os: {
    selector: { kind: "exact", version: "26.5" },
    preferredVersion: "26.5",
    archetypes: [
      { archetype: "duo", selector: { kind: "minimum", version: "27" }, preferredVersion: "27.1" },
    ],
  },
});

const ios = (
  hardware: IosSessionDeviceRequirement["hardware"],
  os: IosSessionDeviceRequirement["os"] = { kind: "omitted" },
): IosSessionDeviceRequirement => ({ schemaVersion: 1, platform: "ios", hardware, os });

const duo = (os?: IosSessionDeviceRequirement["os"]) =>
  ios({ kind: "model-type", modelType: { family: "duo", variant: "duo" } }, os);

describe("querySessionRequirementCapability (#18180)", () => {
  test("a 26.5-only host can run a Duo with a named OS but not with the OS omitted", () => {
    const answer = unwrap(querySessionRequirementCapability(duo(), defaults, catalog("26.5")));
    expect(answer).toMatchObject({
      platform: "ios",
      policyVersion: "defaults-ios-1",
      satisfiable: false,
      reason: { code: "missing_installed_runtime" },
      resolvedOs: { source: "device-type-default", selector: { kind: "minimum", version: "27" } },
      defaultOsSatisfiable: false,
      anyOsSatisfiable: true,
      installedRuntimes: [{ runtime: release("26.5").runtimeId, osVersion: "26.5" }],
    });
    expect(answer.resolvedOs?.osVersion).toBeUndefined();

    const named = unwrap(
      querySessionRequirementCapability(
        duo({ kind: "exact", version: "26.5" }),
        defaults,
        catalog("26.5"),
      ),
    );
    expect(named).toMatchObject({
      satisfiable: true,
      resolvedOs: { source: "request", osVersion: "26.5", runtime: release("26.5").runtimeId },
      defaultOsSatisfiable: false,
      anyOsSatisfiable: true,
    });
  });

  test("a host with the default runtime resolves an omitted Duo OS to it", () => {
    const answer = unwrap(
      querySessionRequirementCapability(duo(), defaults, catalog("26.5", "27.1")),
    );
    expect(answer).toMatchObject({
      satisfiable: true,
      resolvedOs: { source: "device-type-default", osVersion: "27.1" },
      defaultOsSatisfiable: true,
      anyOsSatisfiable: true,
    });
    expect(answer.installedRuntimes.map((r) => r.osVersion)).toEqual(["26.5", "27.1"]);
    expect(answer.reason).toBeUndefined();
  });

  test("a phone with the OS omitted reports the platform default", () => {
    const answer = unwrap(
      querySessionRequirementCapability(
        ios({ kind: "archetype", archetype: "phone" }),
        defaults,
        catalog("26.5"),
      ),
    );
    expect(answer.resolvedOs).toMatchObject({ source: "platform-default", osVersion: "26.5" });
  });

  test("hardware the catalog cannot serve answers unsatisfiable with no resolved OS", () => {
    const answer = unwrap(
      querySessionRequirementCapability(
        ios({ kind: "exact-model", model: { namespace: "alias", value: "no-such-model" } }),
        defaults,
        catalog("26.5"),
      ),
    );
    expect(answer.satisfiable).toBe(false);
    expect(answer.resolvedOs).toBeUndefined();
    expect(answer.anyOsSatisfiable).toBe(false);
    expect(answer.installedRuntimes).toEqual([]);
  });

  test("a host without iOS tooling fails with catalog_unavailable instead of an empty answer", () => {
    const unavailable = iosCatalog({
      provenance: {
        source: "simctl",
        revision: "unavailable",
        state: "unavailable",
        message: "xcrun not found",
      },
      models: [],
      releases: [],
    });
    expect(
      unwrapError(querySessionRequirementCapability(duo(), defaults, unavailable)),
    ).toMatchObject({ code: "catalog_unavailable", message: "xcrun not found" });
  });

  test("malformed and watch requests fail as invalid_request", () => {
    expect(unwrapError(querySessionRequirementCapability({}, defaults, catalog())).code).toBe(
      "invalid_request",
    );
    const watch = {
      schemaVersion: 1,
      platform: "watchos",
      spec: { runtime: "watchOS-11", deviceType: "Apple-Watch" },
    };
    expect(unwrapError(querySessionRequirementCapability(watch, defaults, catalog())).code).toBe(
      "invalid_request",
    );
  });

  const iosRows: Array<[string, IosSessionDeviceRequirement, string[]]> = [
    ["Duo, OS omitted, default installed", duo(), ["26.5", "27.1"]],
    ["Duo, OS omitted, default missing", duo(), ["26.5"]],
    ["Duo, exact named", duo({ kind: "exact", version: "26.5" }), ["26.5", "27.1"]],
    ["Duo, exact missing", duo({ kind: "exact", version: "28" }), ["26.5", "27.1"]],
    ["Duo, minimum", duo({ kind: "minimum", version: "27" }), ["26.5", "27.1"]],
    ["Duo, minimum unmet", duo({ kind: "minimum", version: "27" }), ["26.5"]],
    ["Duo, major", duo({ kind: "major", major: 26 }), ["26.5", "27.1"]],
    ["phone, OS omitted", ios({ kind: "archetype", archetype: "phone" }), ["26.5"]],
    [
      "phone, minimum",
      ios({ kind: "archetype", archetype: "phone" }, { kind: "minimum", version: "27" }),
      ["26.5", "27.1"],
    ],
    ["hardware omitted", ios({ kind: "omitted" }), ["27.1"]],
  ];
  const androidRows: Array<[string, AndroidSessionDeviceRequirement]> = [
    [
      "android, all omitted",
      {
        schemaVersion: 1,
        platform: "android",
        hardware: { kind: "omitted" },
        os: { kind: "omitted" },
      },
    ],
    [
      "android, exact",
      {
        schemaVersion: 1,
        platform: "android",
        hardware: { kind: "archetype", archetype: "tablet" },
        os: { kind: "exact", version: "16" },
      },
    ],
    [
      "android, minimum unmet",
      {
        schemaVersion: 1,
        platform: "android",
        hardware: { kind: "omitted" },
        os: { kind: "minimum", version: "17" },
      },
    ],
  ];
  const rows: Array<
    [
      string,
      IosSessionDeviceRequirement | AndroidSessionDeviceRequirement,
      SessionRequirementDefaults,
      SessionDeviceCatalog,
    ]
  > = [
    ...iosRows.map(([name, req, versions]): (typeof rows)[number] => [
      name,
      req,
      defaults,
      catalog(...versions),
    ]),
    ...androidRows.map(([name, req]): (typeof rows)[number] => [
      name,
      req,
      androidDefaults(),
      androidCatalog(),
    ]),
  ];

  test.each(rows)(
    "%s agrees with the real normalization and resolution",
    (_name, req, hostDefaults, host) => {
      const answer = unwrap(querySessionRequirementCapability(req, hostDefaults, host));
      const normalized = normalizeSessionDeviceRequirement(req, hostDefaults, host);
      const resolved = normalized.ok
        ? resolveSessionDeviceProfile(normalized.value, hostDefaults, host)
        : normalized;
      expect(answer.satisfiable).toBe(resolved.ok);
      if (resolved.ok) {
        expect(answer.resolvedOs?.osVersion).toBe(resolved.value.profile.osVersion);
        expect(answer.reason).toBeUndefined();
      } else {
        expect(answer.reason?.code).toBe(resolved.error.code);
      }
      const omitted = { ...req, os: { kind: "omitted" as const } };
      const omittedNormalized = normalizeSessionDeviceRequirement(omitted, hostDefaults, host);
      expect(answer.defaultOsSatisfiable).toBe(
        omittedNormalized.ok &&
          resolveSessionDeviceProfile(omittedNormalized.value, hostDefaults, host).ok,
      );
    },
  );
});
