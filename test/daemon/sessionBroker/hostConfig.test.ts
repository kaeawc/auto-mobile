import { describe, expect, test } from "bun:test";
import {
  iosReusePolicy,
  parseSessionBrokerHostConfig,
} from "../../../src/daemon/sessionBroker/hostConfig";
import { androidDefaults, iosDefaults } from "../../devices/sessionRequirements/fixtures";
import { MAX_SETTIMEOUT_DELAY_MS } from "../../../src/utils/SystemTimer";

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    limits: {},
    defaults: { ios: iosDefaults() },
    ...overrides,
  };
}

describe("session broker host configuration", () => {
  test.each(["snapshot", "keep-booted"])(
    "accepts composed mode %s with explicit Android reuse",
    (mode) => {
      expect(
        parseSessionBrokerHostConfig(
          config({
            defaults: { android: androidDefaults() },
            reuseAndroidCleanDevices: true,
            androidResetMode: mode,
          }),
        ).androidResetMode,
      ).toBe(mode);
      expect(() => parseSessionBrokerHostConfig(config({ androidResetMode: mode }))).toThrow();
      expect(() =>
        parseSessionBrokerHostConfig(
          config({ androidResetMode: mode, reuseAndroidCleanDevices: true }),
        ),
      ).toThrow();
    },
  );

  test.each(["snapshot", "destroy"])(
    "accepts keep-booted fallback %s only for keep-booted",
    (fallback) => {
      const android = { defaults: { android: androidDefaults() }, reuseAndroidCleanDevices: true };
      expect(
        parseSessionBrokerHostConfig(
          config({
            ...android,
            androidResetMode: "keep-booted",
            androidKeepBootedFallback: fallback,
          }),
        ),
      ).toMatchObject({ androidKeepBootedFallback: fallback });
      for (const mode of [undefined, "snapshot"]) {
        expect(() =>
          parseSessionBrokerHostConfig(
            config({ ...android, androidResetMode: mode, androidKeepBootedFallback: fallback }),
          ),
        ).toThrow();
      }
    },
  );

  test("snapshot timeout validates its bound and rejects ignored configuration", () => {
    const android = { defaults: { android: androidDefaults() }, reuseAndroidCleanDevices: true };
    for (const mode of ["snapshot", "keep-booted"]) {
      const options = {
        ...android,
        androidResetMode: mode,
        ...(mode === "keep-booted" ? { androidKeepBootedFallback: "snapshot" } : {}),
      };
      expect(
        parseSessionBrokerHostConfig(
          config({ ...options, androidResetTimeoutMs: MAX_SETTIMEOUT_DELAY_MS }),
        ).androidResetTimeoutMs,
      ).toBe(MAX_SETTIMEOUT_DELAY_MS);
      for (const timeoutMs of [0, -1, 1.5, MAX_SETTIMEOUT_DELAY_MS + 1]) {
        expect(() =>
          parseSessionBrokerHostConfig(config({ ...options, androidResetTimeoutMs: timeoutMs })),
        ).toThrow();
      }
    }
    for (const options of [
      {},
      { ...android, androidResetMode: "keep-booted" },
      { ...android, androidResetMode: "keep-booted", androidKeepBootedFallback: "destroy" },
    ]) {
      expect(() =>
        parseSessionBrokerHostConfig(config({ ...options, androidResetTimeoutMs: 1000 })),
      ).toThrow();
    }
    expect(() =>
      parseSessionBrokerHostConfig(
        config({ ...android, androidResetMode: "snapshot", androidKeepBootedMaxUses: 5 }),
      ),
    ).toThrow();
    expect(() =>
      parseSessionBrokerHostConfig(
        config({
          ...android,
          androidResetMode: "keep-booted",
          androidKeepBootedFallback: "unknown",
        }),
      ),
    ).toThrow();
  });

  test("iOS reuse modes preserve the legacy erase alias without changing Android", () => {
    expect(iosReusePolicy(parseSessionBrokerHostConfig(config()))).toEqual({ mode: "off" });
    expect(
      iosReusePolicy(parseSessionBrokerHostConfig(config({ reuseCleanDevices: true }))),
    ).toEqual({ mode: "erase", maxUses: 20, fallback: "erase" });
    for (const mode of ["keep-booted", "erase"] as const) {
      expect(
        iosReusePolicy(
          parseSessionBrokerHostConfig(
            config({ reuse: { ios: { mode, maxUses: 3, fallback: "erase" } } }),
          ),
        ),
      ).toEqual({ mode, maxUses: 3, fallback: "erase" });
    }
    expect(
      iosReusePolicy(parseSessionBrokerHostConfig(config({ reuse: { ios: { mode: "off" } } }))),
    ).toEqual({ mode: "off" });
  });

  test("iOS reuse rejects conflicting aliases, invalid bounds, unsupported fallback and Android keys", () => {
    for (const ios of [{ mode: "keep-booted" }, { mode: "off" }]) {
      expect(() =>
        parseSessionBrokerHostConfig(config({ reuseCleanDevices: true, reuse: { ios } })),
      ).toThrow("remove it to select");
    }
    for (const ios of [
      { mode: "keep-booted", maxUses: 0 },
      { mode: "keep-booted", maxUses: 1.5 },
      { mode: "keep-booted", maxUses: Number.MAX_SAFE_INTEGER + 1 },
      { mode: "keep-booted", fallback: "off" },
      { mode: "off", maxUses: 20 },
      { mode: "off", fallback: "erase" },
      { mode: "snapshot" },
    ]) {
      expect(() => parseSessionBrokerHostConfig(config({ reuse: { ios } }))).toThrow(
        "Invalid session broker host configuration",
      );
    }
    expect(() =>
      parseSessionBrokerHostConfig(
        config({ reuse: { ios: { mode: "erase" }, android: { mode: "erase" } } }),
      ),
    ).toThrow("Invalid session broker host configuration");
    expect(() =>
      parseSessionBrokerHostConfig(
        config({
          defaults: { android: androidDefaults() },
          reuse: { ios: { mode: "keep-booted" } },
        }),
      ),
    ).toThrow("explicit defaults.ios");
  });
  test("accepts only positive reset boot concurrency", () => {
    expect(
      parseSessionBrokerHostConfig(config({ limits: { maxConcurrentResetBoots: 2 } })).limits
        .maxConcurrentResetBoots,
    ).toBe(2);
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseSessionBrokerHostConfig(config({ limits: { maxConcurrentResetBoots: limit } })),
      ).toThrow("Invalid session broker host configuration");
    }
  });

  test("legacy reuse flag remains inert on Android-only hosts", () => {
    const parsed = parseSessionBrokerHostConfig(
      config({ defaults: { android: androidDefaults() }, reuseCleanDevices: true }),
    );
    expect(parsed.reuseCleanDevices).toBe(true);
    expect(iosReusePolicy(parsed)).toEqual({ mode: "off" });
  });
  test("requires an explicit operator default policy and fills only safe optional metadata", () => {
    const parsed = parseSessionBrokerHostConfig(config());

    expect<unknown>(parsed).toEqual({
      contractVersion: 1,
      limits: {},
      defaults: { ios: iosDefaults() },
      androidProfileArchetypes: {},
      iosClassifications: [],
      reuseCleanDevices: false,
      reuseAndroidCleanDevices: false,
    });
    expect(() => parseSessionBrokerHostConfig(config({ defaults: {} }))).toThrow(
      "At least one platform must have an explicit default policy",
    );
  });

  test("preserves operator defaults, classifications, and zero or bounded caps", () => {
    const parsed = parseSessionBrokerHostConfig(
      config({
        limits: {
          totalDeviceCap: Number.MAX_SAFE_INTEGER,
          sessionCap: 0,
          idlePoolCap: 7,
        },
        defaults: { ios: iosDefaults(), android: androidDefaults() },
        androidProfileArchetypes: {
          pixel_phone: "phone",
          pixel_tablet: "tablet",
        },
        iosClassifications: [
          {
            simulatorDeviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
            modelType: { family: "iphone", variant: "pro" },
            aliases: ["current-pro"],
          },
        ],
        reuseCleanDevices: true,
      }),
    );

    expect(parsed.limits).toEqual({
      totalDeviceCap: Number.MAX_SAFE_INTEGER,
      sessionCap: 0,
      idlePoolCap: 7,
    });
    expect<unknown>(parsed.defaults).toEqual({
      ios: iosDefaults(),
      android: androidDefaults(),
    });
    expect(parsed.androidProfileArchetypes).toEqual({
      pixel_phone: "phone",
      pixel_tablet: "tablet",
    });
    expect(parsed.iosClassifications[0]?.aliases).toEqual(["current-pro"]);
    expect(parsed.reuseCleanDevices).toBe(true);
    expect(parsed.reuseAndroidCleanDevices).toBe(false);
  });

  test("Android reuse requires its own explicit opt-in", () => {
    expect(parseSessionBrokerHostConfig(config({ reuseAndroidCleanDevices: true }))).toMatchObject({
      reuseAndroidCleanDevices: true,
      reuseCleanDevices: false,
    });
    expect(() =>
      parseSessionBrokerHostConfig(config({ reuseAndroidCleanDevices: "true" })),
    ).toThrow();
  });

  test("keep-booted is an optional operator mode with a positive maxUses limit", () => {
    expect(
      parseSessionBrokerHostConfig(
        config({
          defaults: { android: androidDefaults() },
          reuseAndroidCleanDevices: true,
          androidResetMode: "keep-booted",
          androidKeepBootedMaxUses: 5,
        }),
      ),
    ).toMatchObject({
      androidResetMode: "keep-booted",
      androidKeepBootedMaxUses: 5,
      reuseAndroidCleanDevices: true,
    });
    for (const maxUses of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseSessionBrokerHostConfig(config({ androidKeepBootedMaxUses: maxUses })),
      ).toThrow();
    }
    expect(() => parseSessionBrokerHostConfig(config({ androidResetMode: "unknown" }))).toThrow();
  });

  test.each([
    [
      "reset mode without reuse",
      { androidResetMode: "keep-booted", defaults: { android: androidDefaults() } },
    ],
    [
      "reset mode without Android defaults",
      { androidResetMode: "keep-booted", reuseAndroidCleanDevices: true },
    ],
    [
      "maxUses without mode",
      {
        androidKeepBootedMaxUses: 2,
        reuseAndroidCleanDevices: true,
        defaults: { android: androidDefaults() },
      },
    ],
    ["negative total cap", { limits: { totalDeviceCap: -1 } }],
    ["fractional session cap", { limits: { sessionCap: 1.5 } }],
    ["unsafe idle cap", { limits: { idlePoolCap: Number.MAX_SAFE_INTEGER + 1 } }],
    [
      "malformed preferred version",
      {
        defaults: {
          ios: iosDefaults({
            os: {
              selector: { kind: "exact", version: "27.0" },
              preferredVersion: "latest",
            },
          }),
        },
      },
    ],
    ["unknown allocation control", { runnerNamespace: "consumer-chosen" }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => parseSessionBrokerHostConfig(config(overrides))).toThrow(
      "Invalid session broker host configuration",
    );
  });
});
