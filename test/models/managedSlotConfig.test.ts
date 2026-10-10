import { describe, expect, test } from "bun:test";
import {
  MANAGED_SLOTS_V1_CAPABILITY,
  ManagedSlotConfigError,
  assertManagedSlotContractSupported,
  assertManagedSlotsSupported,
  daemonSupportsManagedSlots,
  parseManagedSlotConfig,
  parseManagedSlotConfigSource,
  resolveManagedSlotConfig,
  type ManagedSlotConfigErrorCode,
} from "../../src/models/managedSlotConfig";

const androidRequest = {
  slotIndex: 0,
  role: "primary",
  platform: "android",
  requestedSpec: {
    runtime: "system-images;android-34;google_apis;arm64-v8a",
    deviceType: "pixel_8",
  },
};

const validConfig = {
  contractVersion: 1,
  managedHostScope: "host-a",
  runnerNamespace: "ci-lane-1",
  runnerIncarnation: "inc-7",
  localSlotCapacity: 1,
  requests: [androidRequest],
};

function codeOf(run: () => unknown): ManagedSlotConfigErrorCode | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof ManagedSlotConfigError ? error.code : undefined;
  }
  return undefined;
}

const neverRead = (): string => {
  throw new Error("file must not be read");
};

describe("parseManagedSlotConfig", () => {
  test("accepts a minimal android config", () => {
    const config = parseManagedSlotConfig(validConfig);
    expect(config.requests[0].platform).toBe("android");
    expect(config.idleTimeoutMs).toBeUndefined();
  });

  test("accepts an ios config with every optional field", () => {
    const config = parseManagedSlotConfig({
      ...validConfig,
      executionAttempt: "attempt-3",
      preparationTimeoutMs: 120_000,
      idleTimeoutMs: 600_000,
      requests: [
        {
          slotIndex: 0,
          role: "primary",
          platform: "ios",
          requestedSpec: {
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
            deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
          },
          priorDeviceHint: { stableId: "abc" },
        },
      ],
    });
    expect(config.requests[0].priorDeviceHint?.stableId).toBe("abc");
    expect(config.idleTimeoutMs).toBe(600_000);
  });

  test.each([
    ["missing managedHostScope", { managedHostScope: undefined }],
    ["empty runnerNamespace", { runnerNamespace: "  " }],
    ["unknown top-level field", { surprise: true }],
    ["operationId is not accepted", { operationId: "op-1" }],
    ["empty requests", { requests: [] }],
    ["zero capacity", { localSlotCapacity: 0 }],
    ["negative slotIndex", { requests: [{ ...androidRequest, slotIndex: -1 }] }],
    [
      "ios spec on an android request",
      {
        requests: [
          {
            ...androidRequest,
            requestedSpec: {
              runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
              deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
            },
          },
        ],
      },
    ],
    ["unknown platform", { requests: [{ ...androidRequest, platform: "watch" }] }],
    ["preparationTimeoutMs above the provision ceiling", { preparationTimeoutMs: 99_999_999 }],
    ["idleTimeoutMs below the 2 minute default", { idleTimeoutMs: 60_000 }],
    ["idleTimeoutMs above the cap", { idleTimeoutMs: 24 * 60 * 60 * 1000 }],
    ["non-integer idleTimeoutMs", { idleTimeoutMs: 150_000.5 }],
  ])("rejects %s", (_name, override) => {
    expect(codeOf(() => parseManagedSlotConfig({ ...validConfig, ...override }))).toBe(
      "managed_slot_config_invalid",
    );
  });

  test("rejects non-object input", () => {
    expect(codeOf(() => parseManagedSlotConfig("nope"))).toBe("managed_slot_config_invalid");
    expect(codeOf(() => parseManagedSlotConfig(null))).toBe("managed_slot_config_invalid");
  });

  test("rejects an unsupported version before validating any other field", () => {
    expect(codeOf(() => parseManagedSlotConfig({ contractVersion: 2, garbage: true }))).toBe(
      "contract_unsupported",
    );
    expect(codeOf(() => parseManagedSlotConfig({ requests: [] }))).toBe("contract_unsupported");
    expect(codeOf(() => parseManagedSlotConfig({ contractVersion: "1" }))).toBe(
      "contract_unsupported",
    );
  });

  test("rejects groups larger than one slot with a typed error", () => {
    expect(codeOf(() => parseManagedSlotConfig({ ...validConfig, localSlotCapacity: 2 }))).toBe(
      "managed_slot_group_unsupported",
    );
    const second = { ...androidRequest, slotIndex: 1, role: "secondary" };
    expect(
      codeOf(() => parseManagedSlotConfig({ ...validConfig, requests: [androidRequest, second] })),
    ).toBe("managed_slot_group_unsupported");
  });

  test("rejects duplicate slot indexes as invalid", () => {
    expect(
      codeOf(() =>
        parseManagedSlotConfig({ ...validConfig, requests: [androidRequest, androidRequest] }),
      ),
    ).toBe("managed_slot_config_invalid");
  });
});

describe("contract negotiation", () => {
  test("accepts a supported version and rejects others from an injected list", () => {
    expect(() => assertManagedSlotContractSupported(1)).not.toThrow();
    expect(codeOf(() => assertManagedSlotContractSupported(1, [2]))).toBe("contract_unsupported");
  });

  test("detects the daemon capability token", () => {
    expect(
      daemonSupportsManagedSlots(["daemon/registerSession", MANAGED_SLOTS_V1_CAPABILITY]),
    ).toBe(true);
    expect(daemonSupportsManagedSlots(["daemon/registerSession"])).toBe(false);
  });
});

describe("assertManagedSlotsSupported", () => {
  test("is not wired yet, so a supplied config is refused with a typed error", () => {
    expect(codeOf(() => assertManagedSlotsSupported(parseManagedSlotConfig(validConfig)))).toBe(
      "managed_slots_unsupported",
    );
    expect(() => assertManagedSlotsSupported(undefined)).not.toThrow();
    expect(() =>
      assertManagedSlotsSupported(parseManagedSlotConfig(validConfig), true),
    ).not.toThrow();
  });
});

describe("parseManagedSlotConfigSource", () => {
  test("reads inline JSON without touching the filesystem", () => {
    const config = parseManagedSlotConfigSource(JSON.stringify(validConfig), neverRead);
    expect(config.runnerNamespace).toBe("ci-lane-1");
  });

  test("reads a file path", () => {
    const config = parseManagedSlotConfigSource("/cfg.json", (path) => {
      expect(path).toBe("/cfg.json");
      return JSON.stringify(validConfig);
    });
    expect(config.managedHostScope).toBe("host-a");
  });

  test("reports unreadable files, bad JSON and empty values as invalid", () => {
    expect(codeOf(() => parseManagedSlotConfigSource("/missing.json", neverRead))).toBe(
      "managed_slot_config_invalid",
    );
    expect(codeOf(() => parseManagedSlotConfigSource("{not json", neverRead))).toBe(
      "managed_slot_config_invalid",
    );
    expect(codeOf(() => parseManagedSlotConfigSource("  ", neverRead))).toBe(
      "managed_slot_config_invalid",
    );
  });
});

describe("resolveManagedSlotConfig precedence", () => {
  const flagJson = JSON.stringify({ ...validConfig, runnerNamespace: "from-flag" });
  const envJson = JSON.stringify({ ...validConfig, runnerNamespace: "from-env" });

  test("returns undefined when neither is set", () => {
    expect(resolveManagedSlotConfig({ readFile: neverRead })).toBeUndefined();
  });

  test("falls back to the env value", () => {
    expect(
      resolveManagedSlotConfig({ envValue: envJson, readFile: neverRead })?.runnerNamespace,
    ).toBe("from-env");
  });

  test("the flag wins over the env", () => {
    expect(
      resolveManagedSlotConfig({ flagValue: flagJson, envValue: envJson, readFile: neverRead })
        ?.runnerNamespace,
    ).toBe("from-flag");
  });

  test("an invalid flag is not masked by a valid env", () => {
    expect(
      codeOf(() =>
        resolveManagedSlotConfig({ flagValue: "{bad", envValue: envJson, readFile: neverRead }),
      ),
    ).toBe("managed_slot_config_invalid");
  });

  test("is incompatible with --initial-session-uuid and --no-proxy", () => {
    expect(
      codeOf(() =>
        resolveManagedSlotConfig({ flagValue: flagJson, readFile: neverRead, noProxy: true }),
      ),
    ).toBe("managed_slot_config_invalid");
    expect(
      codeOf(() =>
        resolveManagedSlotConfig({
          envValue: envJson,
          readFile: neverRead,
          hasInitialSessionUuid: true,
        }),
      ),
    ).toBe("managed_slot_config_invalid");
  });
});
