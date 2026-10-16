import { describe, expect, test } from "bun:test";
import { parseSessionBrokerHostConfig } from "../../../src/daemon/sessionBroker/hostConfig";
import { androidDefaults, iosDefaults } from "../../devices/sessionRequirements/fixtures";

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    limits: {},
    defaults: { ios: iosDefaults() },
    ...overrides,
  };
}

describe("session broker host configuration", () => {
  test("requires an explicit operator default policy and fills only safe optional metadata", () => {
    const parsed = parseSessionBrokerHostConfig(config());

    expect(parsed).toEqual({
      contractVersion: 1,
      limits: {},
      defaults: { ios: iosDefaults() },
      androidProfileArchetypes: {},
      iosClassifications: [],
      reuseCleanDevices: false,
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
    expect(parsed.defaults).toEqual({
      ios: iosDefaults(),
      android: androidDefaults(),
    });
    expect(parsed.androidProfileArchetypes).toEqual({
      pixel_phone: "phone",
      pixel_tablet: "tablet",
    });
    expect(parsed.iosClassifications[0]?.aliases).toEqual(["current-pro"]);
    expect(parsed.reuseCleanDevices).toBe(true);
  });

  test.each([
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
