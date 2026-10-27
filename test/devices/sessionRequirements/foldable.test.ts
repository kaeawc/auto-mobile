import { expect, test } from "bun:test";
import {
  parseSessionDeviceRequirement,
  normalizeSessionDeviceRequirement,
  resolveSessionDeviceProfile,
  matchSessionDevice,
} from "../../../src/devices/sessionRequirements";
import { parseSessionBrokerHostConfig } from "../../../src/daemon/sessionBroker/hostConfig";
import { androidCatalog, androidDefaults, unwrap, unwrapError } from "./fixtures";

const request = {
  schemaVersion: 1,
  platform: "android",
  hardware: { kind: "archetype", archetype: "foldable" },
  os: { kind: "omitted" },
};
const catalog = androidCatalog({
  profiles: [{ profileId: "pixel_9_pro_fold", archetype: "foldable", metadataState: "current" }],
});
const defaults = androidDefaults({
  hardware: {
    omitted: "foldable",
    profiles: [{ archetype: "foldable", profileId: "pixel_9_pro_fold", memoryMb: 4096 }],
  },
});

test("foldable parsing, omitted normalization, host mapping and RAM resolution", () => {
  const parsed = unwrap(parseSessionDeviceRequirement(request));
  const normalized = unwrap(normalizeSessionDeviceRequirement(parsed, defaults, catalog));
  const resolved = unwrap(resolveSessionDeviceProfile(normalized, defaults, catalog));
  expect(resolved.profile).toMatchObject({ archetype: "foldable", memoryMb: 4096 });
  expect(
    unwrap(
      normalizeSessionDeviceRequirement(
        unwrap(parseSessionDeviceRequirement({ ...request, hardware: { kind: "omitted" } })),
        defaults,
        catalog,
      ),
    ).effective.hardware,
  ).toEqual({ kind: "archetype", archetype: "foldable" });
  expect<unknown>(
    parseSessionBrokerHostConfig({
      contractVersion: 1,
      limits: {},
      defaults: { android: defaults },
      androidProfileArchetypes: { pixel_9_pro_fold: "foldable" },
    }).defaults.android,
  ).toEqual(defaults);
  for (const memoryMb of [0, 2047, 4096.5]) {
    expect(() =>
      parseSessionBrokerHostConfig({
        contractVersion: 1,
        limits: {},
        defaults: {
          android: {
            ...defaults,
            hardware: {
              ...defaults.hardware,
              profiles: [{ archetype: "foldable", profileId: "pixel_9_pro_fold", memoryMb }],
            },
          },
        },
      }),
    ).toThrow();
  }
  expect(
    unwrapError(
      parseSessionDeviceRequirement({
        ...request,
        hardware: { kind: "archetype", archetype: "watch" },
      }),
    ).code,
  ).toBe("invalid_request");
});

test("unmapped, uninstalled and misclassified foldable profiles fail closed", () => {
  const normalized = unwrap(
    normalizeSessionDeviceRequirement(
      unwrap(parseSessionDeviceRequirement(request)),
      defaults,
      catalog,
    ),
  );
  const missing = unwrapError(resolveSessionDeviceProfile(normalized, androidDefaults(), catalog));
  expect(missing).toMatchObject({ code: "unsupported_hardware", transient: false });
  expect(missing.message).toContain("defaults.android.hardware.profiles");
  expect(
    unwrapError(resolveSessionDeviceProfile(normalized, defaults, androidCatalog())).code,
  ).toBe("unsupported_hardware");
  expect(
    unwrapError(
      resolveSessionDeviceProfile(
        normalized,
        defaults,
        androidCatalog({
          profiles: [
            { profileId: "pixel_9_pro_fold", archetype: "phone", metadataState: "current" },
          ],
        }),
      ),
    ).transient,
  ).toBe(false);
});

test("Android archetype matching is strict in both directions", () => {
  for (const requested of ["phone", "tablet", "foldable"] as const) {
    const normalized = unwrap(
      normalizeSessionDeviceRequirement(
        unwrap(
          parseSessionDeviceRequirement({
            ...request,
            hardware: { kind: "archetype", archetype: requested },
          }),
        ),
        defaults,
        catalog,
      ),
    );
    for (const archetype of ["phone", "tablet", "foldable"] as const) {
      expect(
        matchSessionDevice(normalized, {
          platform: "android",
          metadataState: "current",
          archetype,
          osVersion: "15",
          versionPrecision: "major",
        }).kind,
      ).toBe(requested === archetype ? "match" : "mismatch");
    }
  }
});
