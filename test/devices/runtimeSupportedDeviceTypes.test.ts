import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adaptIosSessionDeviceCatalog } from "../../src/devices/sessionCatalog/iosCatalogAdapter";
import {
  normalizeSessionDeviceRequirement,
  resolveSessionDeviceProfile,
  type IosSessionDeviceRequirement,
  type IosSessionRequirementDefaults,
  type OsSelector,
} from "../../src/devices/sessionRequirements";
import { chooseIosDeviceType } from "../../src/daemon/sessionBroker/provisioning/DefaultManagedSpecResolver";
import { buildSimulatorProvisioningCatalogEntries } from "../../src/server/simulatorProvisioningCatalog";
import type {
  AppleDeviceRuntime,
  AppleDeviceType,
} from "../../src/utils/ios-cmdline-tools/SimCtlSupport";
import {
  evaluateDeviceTypeOnRuntime,
  runtimeListsDeviceType,
} from "../../src/utils/ios-cmdline-tools/runtimeCompatibility";

// #18279: a runtime's own `supportedDeviceTypes` overrides a device type's runtime bounds. The
// verbatim Xcode 26.6 capture has iOS 27.1 (24A94401) shipping only the iPhone Duo, while the
// iPad Pro 11-inch (M4) bounds (17.4.0 to unbounded) include 27.1.
const fixtures = join(import.meta.dir, "../fixtures/ios-devicetype-order");
const runtimes = (
  JSON.parse(readFileSync(join(fixtures, "xcode-26.6-runtimes.json"), "utf8")) as {
    runtimes: AppleDeviceRuntime[];
  }
).runtimes;
const deviceTypes = (
  JSON.parse(readFileSync(join(fixtures, "xcode-26.6-devicetypes.json"), "utf8")) as {
    devicetypes: AppleDeviceType[];
  }
).devicetypes;
/** Derived, not captured: the same runtimes as older simctl output without the list. */
const runtimesWithoutLists = runtimes.map(({ supportedDeviceTypes: _omitted, ...rest }) => rest);

const DUO = "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo";
const IPAD_PRO_M4 = "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4-8GB";
const IOS_27_0 = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
const IOS_27_1 = "com.apple.CoreSimulator.SimRuntime.iOS-27-1";

function deviceType(identifier: string): AppleDeviceType {
  const found = deviceTypes.find((entry) => entry.identifier === identifier);
  if (!found) {
    throw new Error(`fixture missing ${identifier}`);
  }
  return found;
}

function runtime(identifier: string): AppleDeviceRuntime {
  const found = runtimes.find((entry) => entry.identifier === identifier);
  if (!found) {
    throw new Error(`fixture missing ${identifier}`);
  }
  return found;
}

describe("runtime supportedDeviceTypes compatibility", () => {
  test("a runtime that omits the device type is unsupported inside the bounds", () => {
    expect(runtimeListsDeviceType(runtime(IOS_27_1), IPAD_PRO_M4)).toBe(false);
    expect(evaluateDeviceTypeOnRuntime(deviceType(IPAD_PRO_M4), runtime(IOS_27_1)).status).toBe(
      "unsupported",
    );
    expect(evaluateDeviceTypeOnRuntime(deviceType(DUO), runtime(IOS_27_1)).status).toBe(
      "supported",
    );
    expect(evaluateDeviceTypeOnRuntime(deviceType(IPAD_PRO_M4), runtime(IOS_27_0)).status).toBe(
      "supported",
    );
  });

  test("an absent list keeps the bounds verdict", () => {
    const [unlisted] = runtimesWithoutLists.filter((entry) => entry.identifier === IOS_27_1);
    expect(runtimeListsDeviceType(unlisted, IPAD_PRO_M4)).toBeUndefined();
    expect(evaluateDeviceTypeOnRuntime(deviceType(IPAD_PRO_M4), unlisted).status).toBe("supported");
  });

  test("device-images compatibleRuntimeIds drops runtimes that do not ship the type", () => {
    const catalog = buildSimulatorProvisioningCatalogEntries("ios", runtimes, deviceTypes);
    const compatible = (id: string) => {
      const compatibility = catalog.deviceTypes.find(
        (entry) => entry.id === id,
      )?.runtimeCompatibility;
      return compatibility?.knowledge === "known" ? compatibility.compatibleRuntimeIds : undefined;
    };
    expect(compatible(DUO)).toEqual([IOS_27_1]);
    expect(compatible(IPAD_PRO_M4)).toContain(IOS_27_0);
    expect(compatible(IPAD_PRO_M4)).not.toContain(IOS_27_1);

    const unlisted = buildSimulatorProvisioningCatalogEntries(
      "ios",
      runtimesWithoutLists,
      deviceTypes,
    ).deviceTypes.find((entry) => entry.id === IPAD_PRO_M4)?.runtimeCompatibility;
    expect(unlisted?.knowledge === "known" ? unlisted.compatibleRuntimeIds : []).toContain(
      IOS_27_1,
    );
  });

  test("the managed any-model choice never picks a type the runtime does not ship", () => {
    expect(chooseIosDeviceType(IOS_27_1, runtimes, deviceTypes)).toBeUndefined();
    expect(chooseIosDeviceType(IOS_27_1, runtimes, deviceTypes, "tablet")).toBeUndefined();
    expect(chooseIosDeviceType(IOS_27_0, runtimes, deviceTypes)).toBeDefined();
  });
});

describe("session resolution honours runtime supportedDeviceTypes", () => {
  const defaults: IosSessionRequirementDefaults = {
    platform: "ios",
    policyVersion: "defaults-ios-18279",
    hardware: { omitted: "phone", archetypes: [], modelTypes: [] },
    // Preferring 27.1 proves a non-exact selector skips it rather than landing there by default.
    os: { selector: { kind: "exact", version: "27.1" }, preferredVersion: "27.1" },
  };

  function resolve(model: string, os: OsSelector, catalogRuntimes = runtimes) {
    const catalog = adaptIosSessionDeviceCatalog(deviceTypes, catalogRuntimes);
    const request: IosSessionDeviceRequirement = {
      schemaVersion: 1,
      platform: "ios",
      hardware: {
        kind: "exact-model",
        model: { namespace: "simulator-device-type", value: model },
      },
      os,
    };
    const normalized = normalizeSessionDeviceRequirement(request, defaults, catalog);
    if (!normalized.ok) {
      throw new Error(normalized.error.message);
    }
    return resolveSessionDeviceProfile(normalized.value, defaults, catalog);
  }

  test("an exact runtime that does not ship the model is runtime_incompatible", () => {
    const resolved = resolve(IPAD_PRO_M4, { kind: "exact", version: "27.1" });
    expect(resolved.ok ? undefined : resolved.error.code).toBe("runtime_incompatible");
  });

  test("a minimum selector picks a satisfying runtime that ships the model", () => {
    const resolved = resolve(IPAD_PRO_M4, { kind: "minimum", version: "27.0" });
    expect(
      resolved.ok && resolved.value.platform === "ios" && resolved.value.profile,
    ).toMatchObject({ runtimeId: IOS_27_0, compatibility: "supported" });
  });

  test("a runtime that ships the model resolves supported", () => {
    const resolved = resolve(DUO, { kind: "exact", version: "27.1" });
    expect(
      resolved.ok && resolved.value.platform === "ios" && resolved.value.profile,
    ).toMatchObject({ runtimeId: IOS_27_1, compatibility: "supported" });
  });

  test("without the list the bounds alone decide", () => {
    const resolved = resolve(IPAD_PRO_M4, { kind: "exact", version: "27.1" }, runtimesWithoutLists);
    expect(
      resolved.ok && resolved.value.platform === "ios" && resolved.value.profile,
    ).toMatchObject({ runtimeId: IOS_27_1, compatibility: "supported" });
  });
});
