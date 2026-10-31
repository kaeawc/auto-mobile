import { describe, expect, test } from "bun:test";
import {
  matchSessionDevice,
  matchWatchSessionDevice,
  normalizeSessionDeviceRequirement,
  normalizeWatchSessionDeviceRequirement,
  parseSessionDeviceRequirement,
  type SessionDeviceRequirement,
  type WatchSessionDeviceCatalog,
  type WatchSessionDeviceRequirement,
} from "../../../src/devices/sessionRequirements";
import { adaptWatchSessionDeviceCatalog } from "../../../src/devices/sessionCatalog";
import { WATCH_DEVICE_TYPE, WATCH_RUNTIME, WATCH_RUNTIME_ID } from "../../fakes/FakeWatchSimctl";
import { iosCatalog, iosDefaults, unwrap, unwrapError } from "./fixtures";

const SPEC = { runtime: WATCH_RUNTIME_ID, deviceType: WATCH_DEVICE_TYPE.identifier };
const REQUEST: WatchSessionDeviceRequirement = {
  schemaVersion: 1,
  platform: "watchos",
  spec: SPEC,
};
const ULTRA = "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-2-49mm";
const OLD_RUNTIME = "com.apple.CoreSimulator.SimRuntime.watchOS-10-5";

function catalog(): WatchSessionDeviceCatalog {
  return adaptWatchSessionDeviceCatalog({
    runtimes: [
      WATCH_RUNTIME,
      { ...WATCH_RUNTIME, identifier: OLD_RUNTIME, version: "10.5", isAvailable: false },
    ],
    deviceTypes: [WATCH_DEVICE_TYPE],
  });
}

describe("watch session requirement parsing", () => {
  test("accepts exactly provisionDevice's watch spec", () => {
    expect(unwrap(parseSessionDeviceRequirement(REQUEST))).toEqual(REQUEST);
  });

  test.each([
    [{ ...REQUEST, spec: { runtime: SPEC.runtime } }, "spec"],
    [{ ...REQUEST, spec: { ...SPEC, displayCutout: "any" } }, "spec"],
    [{ ...REQUEST, spec: { ...SPEC, runtime: "" } }, "spec"],
    [{ ...REQUEST, hardware: { kind: "omitted" } }, undefined],
    [{ ...REQUEST, os: { kind: "omitted" } }, undefined],
    [{ schemaVersion: 1, platform: "watchos" }, "spec"],
  ])("refuses %j", (input, field) => {
    const error = unwrapError(parseSessionDeviceRequirement(input));
    expect(error.code).toBe("invalid_request");
    expect(error.field).toBe(field);
  });

  test("iOS and Android requests keep their shapes and refuse a watch spec", () => {
    const ios: SessionDeviceRequirement = {
      schemaVersion: 1,
      platform: "ios",
      hardware: { kind: "omitted" },
      os: { kind: "omitted" },
    };
    const android: SessionDeviceRequirement = {
      schemaVersion: 1,
      platform: "android",
      hardware: { kind: "omitted" },
      os: { kind: "omitted" },
    };
    expect(unwrap(parseSessionDeviceRequirement(ios))).toEqual(ios);
    expect(unwrap(parseSessionDeviceRequirement(android))).toEqual(android);
    expect(unwrapError(parseSessionDeviceRequirement({ ...ios, spec: SPEC })).code).toBe(
      "invalid_request",
    );
    expect(unwrapError(parseSessionDeviceRequirement({ ...ios, platform: "tvos" })).message).toBe(
      "platform must be ios, android or watchos.",
    );
  });

  test("a watch request never resolves through iOS/Android host defaults", () => {
    expect(
      unwrapError(normalizeSessionDeviceRequirement(REQUEST, iosDefaults(), iosCatalog())).code,
    ).toBe("invalid_config");
  });
});

describe("watch session requirement normalization", () => {
  test("an installed runtime and listed device type resolve to the exact watch profile", () => {
    const normalized = unwrap(normalizeWatchSessionDeviceRequirement(REQUEST, catalog()));
    expect(normalized.profile).toEqual({
      platform: "watchos",
      metadataState: "current",
      runtime: SPEC.runtime,
      deviceType: SPEC.deviceType,
    });
    expect(normalized.catalogRevision).toBe(catalog().provenance.revision);
  });

  test("an unknown device type is refused naming the available ones", () => {
    const error = unwrapError(
      normalizeWatchSessionDeviceRequirement(
        { ...REQUEST, spec: { ...SPEC, deviceType: ULTRA } },
        catalog(),
      ),
    );
    expect(error).toMatchObject({
      code: "unsupported_hardware",
      transient: false,
      field: "spec.deviceType",
    });
    expect(error.message).toContain(`'${ULTRA}'`);
    expect(error.message).toContain(`Available: ${WATCH_DEVICE_TYPE.identifier}`);
  });

  test.each([
    ["com.apple.CoreSimulator.SimRuntime.watchOS-99-0", "Unknown"],
    [OLD_RUNTIME, "Unavailable"],
  ])("runtime %s is refused naming the installed ones", (runtime, kind) => {
    const error = unwrapError(
      normalizeWatchSessionDeviceRequirement({ ...REQUEST, spec: { ...SPEC, runtime } }, catalog()),
    );
    expect(error).toMatchObject({
      code: "missing_installed_runtime",
      transient: false,
      field: "spec.runtime",
    });
    expect(error.message).toBe(
      `${kind} watchOS runtime '${runtime}'. Available: ${WATCH_RUNTIME_ID}`,
    );
  });

  test("a host without watch simulators is a permanent refusal", () => {
    const error = unwrapError(
      normalizeWatchSessionDeviceRequirement(REQUEST, {
        platform: "watchos",
        provenance: { source: "s", revision: "not-installed", state: "not-installed" },
        runtimes: [],
        deviceTypes: [],
      }),
    );
    expect(error).toMatchObject({ code: "unsupported_hardware", transient: false });
  });

  test("an unreadable catalog is transient, never an empty catalog", () => {
    const error = unwrapError(
      normalizeWatchSessionDeviceRequirement(REQUEST, {
        platform: "watchos",
        provenance: { source: "s", revision: "unavailable", state: "unavailable", message: "x" },
        runtimes: [],
        deviceTypes: [],
      }),
    );
    expect(error).toEqual({ code: "catalog_unavailable", message: "x", transient: true });
  });
});

describe("watch pool matching", () => {
  const requirement = unwrap(normalizeWatchSessionDeviceRequirement(REQUEST, catalog()));
  const pooled = { platform: "watchos", metadataState: "current", ...SPEC } as const;

  test("only a watch with the same runtime and device type matches", () => {
    expect(matchWatchSessionDevice(requirement, pooled)).toEqual({ kind: "match" });
    expect(matchWatchSessionDevice(requirement, { ...pooled, deviceType: ULTRA })).toEqual({
      kind: "mismatch",
      reason: "hardware",
    });
    expect(matchWatchSessionDevice(requirement, { ...pooled, runtime: OLD_RUNTIME })).toEqual({
      kind: "mismatch",
      reason: "os",
    });
    expect(
      matchWatchSessionDevice(requirement, {
        platform: "ios",
        metadataState: "current",
        runtimeId: SPEC.runtime,
        simulatorDeviceTypeIdentifier: SPEC.deviceType,
      }),
    ).toEqual({ kind: "mismatch", reason: "platform" });
  });

  test("a pooled watch never satisfies an iOS request", () => {
    const ios = unwrap(
      normalizeSessionDeviceRequirement(
        {
          schemaVersion: 1,
          platform: "ios",
          hardware: { kind: "omitted" },
          os: { kind: "omitted" },
        },
        iosDefaults(),
        iosCatalog(),
      ),
    );
    expect(matchSessionDevice(ios, pooled)).toEqual({ kind: "mismatch", reason: "platform" });
  });
});
