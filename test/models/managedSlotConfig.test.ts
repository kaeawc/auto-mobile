import { describe, expect, mock, spyOn, test } from "bun:test";
import {
  assertManagedSlotOwnerIdentity,
  assertManagedSlotOwnerRunning,
  MANAGED_SLOTS_PROXY_WIRED,
  MANAGED_SLOTS_V1_CAPABILITY,
  assertManagedSlotContractSupported,
  assertManagedSlotsSupported,
  daemonSupportsManagedSlots,
  unmetManagedSlotConfigCapabilities,
  MANAGED_SLOTS_V1_DEVICE_FAMILY_CAPABILITY,
  parseBindingConfig,
  parseManagedSlotConfigSource,
  resolveManagedSlotConfig,
} from "../../src/models/managedSlotConfig";
import {
  BindingConfigError,
  type BindingConfigErrorCode,
} from "../../src/daemon/sessionBroker/provisioning/provisionRequest";
import {
  androidProvisionDeviceSpecSchema,
  iosProvisionDeviceSpecSchema,
} from "../../src/server/provisionDeviceSpecSchemas";
import { logger } from "../../src/utils/logger";

const androidRequest = {
  bindingIndex: 0,
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
  localBindingCapacity: 1,
  requests: [androidRequest],
};

function codeOf(run: () => unknown): BindingConfigErrorCode | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof BindingConfigError ? error.code : undefined;
  }
  return undefined;
}

const neverRead = (): string => {
  throw new Error("file must not be read");
};

describe("parseBindingConfig", () => {
  test.each(["phone", "tablet", "foldable"])(
    "accepts family %s with and without a model on both platforms",
    (deviceFamily) => {
      for (const platform of ["android", "ios"] as const) {
        const runtime =
          platform === "android"
            ? androidRequest.requestedSpec.runtime
            : "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
        const model =
          platform === "android" ? "pixel_8" : "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
        for (const deviceType of [undefined, model]) {
          const requestedSpec = { runtime, deviceFamily, ...(deviceType ? { deviceType } : {}) };
          const config = parseBindingConfig({
            ...validConfig,
            requests: [{ bindingIndex: 0, role: "primary", platform, requestedSpec }],
          });
          expect(config.requests[0]?.requestedSpec).toEqual(requestedSpec);
        }
      }
    },
  );

  test.each(["android", "ios"] as const)("%s rejects an unknown family", (platform) => {
    const runtime =
      platform === "android"
        ? androidRequest.requestedSpec.runtime
        : "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
    expect(
      codeOf(() =>
        parseBindingConfig({
          ...validConfig,
          requests: [
            {
              bindingIndex: 0,
              role: "primary",
              platform,
              requestedSpec: { runtime, deviceFamily: "watch" },
            },
          ],
        }),
      ),
    ).toBe("binding_config_invalid");
  });

  test.each(["phone", "tablet", "foldable"])(
    "provisionDevice rejects family %s even with an exact model",
    (deviceFamily) => {
      expect(
        androidProvisionDeviceSpecSchema.safeParse({
          ...androidRequest.requestedSpec,
          deviceFamily,
        }).success,
      ).toBe(false);
      expect(
        iosProvisionDeviceSpecSchema.safeParse({
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
          deviceFamily,
        }).success,
      ).toBe(false);
    },
  );

  test("accepts a minimal android config", () => {
    const config = parseBindingConfig(validConfig);
    expect(config.requests[0].platform).toBe("android");
    expect(config.idleTimeoutMs).toBeUndefined();
  });

  test("accepts an ios config with every optional field", () => {
    const config = parseBindingConfig({
      ...validConfig,
      executionAttempt: "attempt-3",
      preparationTimeoutMs: 120_000,
      idleTimeoutMs: 600_000,
      requests: [
        {
          bindingIndex: 0,
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
    ["zero capacity", { localBindingCapacity: 0 }],
    ["negative slotIndex", { requests: [{ ...androidRequest, bindingIndex: -1 }] }],
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
    expect(codeOf(() => parseBindingConfig({ ...validConfig, ...override }))).toBe(
      "binding_config_invalid",
    );
  });

  test("an omitted deviceType is unconstrained on both platforms (owner decision Q4)", () => {
    const anyModel = parseBindingConfig({
      ...validConfig,
      requests: [
        { ...androidRequest, requestedSpec: { runtime: androidRequest.requestedSpec.runtime } },
      ],
    });
    expect(anyModel.requests[0]!.requestedSpec).toEqual({
      runtime: androidRequest.requestedSpec.runtime,
    });
    const iosAnyModel = parseBindingConfig({
      ...validConfig,
      requests: [
        {
          bindingIndex: 0,
          role: "primary",
          platform: "ios",
          requestedSpec: { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0" },
        },
      ],
    });
    expect(iosAnyModel.requests[0]!.requestedSpec).toEqual({
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
    });
  });

  test("the generic provisionDevice specs still require an exact deviceType", () => {
    expect(
      androidProvisionDeviceSpecSchema.safeParse({ runtime: androidRequest.requestedSpec.runtime })
        .success,
    ).toBe(false);
    expect(
      iosProvisionDeviceSpecSchema.safeParse({
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
      }).success,
    ).toBe(false);
  });

  test("a supplied deviceType is still checked against its platform", () => {
    expect(
      codeOf(() =>
        parseBindingConfig({
          ...validConfig,
          requests: [
            {
              ...androidRequest,
              requestedSpec: {
                runtime: androidRequest.requestedSpec.runtime,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
              },
            },
          ],
        }),
      ),
    ).toBe("binding_config_invalid");
  });

  test("rejects non-object input", () => {
    expect(codeOf(() => parseBindingConfig("nope"))).toBe("binding_config_invalid");
    expect(codeOf(() => parseBindingConfig(null))).toBe("binding_config_invalid");
  });

  test("rejects an unsupported version before validating any other field", () => {
    expect(codeOf(() => parseBindingConfig({ contractVersion: 2, garbage: true }))).toBe(
      "contract_unsupported",
    );
    expect(codeOf(() => parseBindingConfig({ requests: [] }))).toBe("contract_unsupported");
    expect(codeOf(() => parseBindingConfig({ contractVersion: "1" }))).toBe("contract_unsupported");
  });

  test("rejects groups larger than one binding with a typed error", () => {
    expect(codeOf(() => parseBindingConfig({ ...validConfig, localBindingCapacity: 2 }))).toBe(
      "binding_group_unsupported",
    );
    const second = { ...androidRequest, bindingIndex: 1, role: "secondary" };
    expect(
      codeOf(() => parseBindingConfig({ ...validConfig, requests: [androidRequest, second] })),
    ).toBe("binding_group_unsupported");
  });

  test("rejects duplicate binding indexes as invalid", () => {
    expect(
      codeOf(() =>
        parseBindingConfig({ ...validConfig, requests: [androidRequest, androidRequest] }),
      ),
    ).toBe("binding_config_invalid");
  });
});

describe("executionOwnerPid", () => {
  test("accepts a positive integer and stays optional", () => {
    expect(parseBindingConfig({ ...validConfig, executionOwnerPid: 4242 }).executionOwnerPid).toBe(
      4242,
    );
    expect(parseBindingConfig(validConfig).executionOwnerPid).toBeUndefined();
  });

  test.each([0, -5, 1.5, "42", null])("rejects %p", (value) => {
    expect(codeOf(() => parseBindingConfig({ ...validConfig, executionOwnerPid: value }))).toBe(
      "binding_config_invalid",
    );
  });

  test("startup validation requires the owner process to exist", () => {
    const config = parseBindingConfig({ ...validConfig, executionOwnerPid: 4242 });
    expect(codeOf(() => assertManagedSlotOwnerRunning(config, () => false))).toBe(
      "binding_config_invalid",
    );
    expect(
      codeOf(() => assertManagedSlotOwnerRunning(config, (pid) => pid === 4242)),
    ).toBeUndefined();
    expect(codeOf(() => assertManagedSlotOwnerRunning(undefined, () => false))).toBeUndefined();
    expect(
      codeOf(() => assertManagedSlotOwnerRunning(parseBindingConfig(validConfig), () => false)),
    ).toBeUndefined();
  });
});

describe("executionOwnerStartIdentity", () => {
  const base = parseBindingConfig(validConfig);
  const owner = {
    ...base,
    executionOwnerPid: 4242,
    executionOwnerStartIdentity: "linux:boot-id:12345",
  };

  test("parses an opaque identity with its owner PID", () => {
    expect(parseBindingConfig(owner).executionOwnerStartIdentity).toBe(
      owner.executionOwnerStartIdentity,
    );
  });

  test("rejects identity without an owner PID", () => {
    const config = {
      ...validConfig,
      executionOwnerStartIdentity: owner.executionOwnerStartIdentity,
    };
    expect(codeOf(() => parseBindingConfig(config))).toBe("binding_config_invalid");
    expect(() => parseBindingConfig(config)).toThrow(
      "executionOwnerStartIdentity requires executionOwnerPid",
    );
  });

  test.each(["", "x".repeat(257)])("rejects invalid identity length %p", (identity) => {
    expect(
      codeOf(() => parseBindingConfig({ ...owner, executionOwnerStartIdentity: identity })),
    ).toBe("binding_config_invalid");
  });

  test("refuses a different process and names the PID", () => {
    expect(codeOf(() => assertManagedSlotOwnerIdentity(owner, () => "different"))).toBe(
      "binding_config_invalid",
    );
    expect(() => assertManagedSlotOwnerIdentity(owner, () => "different")).toThrow(
      "executionOwnerPid 4242 no longer names the process described by executionOwnerStartIdentity (the PID was reused)",
    );
  });

  test("returns same and compares exactly the declared PID and identity", () => {
    const compare = mock(() => "same" as const);
    expect(assertManagedSlotOwnerIdentity(owner, compare)).toBe("same");
    expect(compare.mock.calls).toEqual([[4242, owner.executionOwnerStartIdentity]]);
  });

  test("returns unknown and warns when comparison is unavailable", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(assertManagedSlotOwnerIdentity(owner, () => "unknown")).toBe("unknown");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("trusting the PID alone");
    } finally {
      warn.mockRestore();
    }
  });

  test("logs a throwing comparison and returns unknown", () => {
    const error = new Error("identity unreadable");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(
        assertManagedSlotOwnerIdentity(owner, () => {
          throw error;
        }),
      ).toBe("unknown");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toBe(error);
    } finally {
      warn.mockRestore();
    }
  });

  test("skips comparison when config, PID, or identity is omitted", () => {
    const compare = mock(() => "same" as const);
    expect(assertManagedSlotOwnerIdentity(undefined, compare)).toBeUndefined();
    expect(
      assertManagedSlotOwnerIdentity({ ...base, executionOwnerPid: 4242 }, compare),
    ).toBeUndefined();
    expect(
      assertManagedSlotOwnerIdentity(
        { ...base, executionOwnerStartIdentity: owner.executionOwnerStartIdentity },
        compare,
      ),
    ).toBeUndefined();
    expect(compare).toHaveBeenCalledTimes(0);
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
  test("is wired (#11173): a supplied config is accepted", () => {
    expect(MANAGED_SLOTS_PROXY_WIRED).toBe(true);
    expect(() => assertManagedSlotsSupported(parseBindingConfig(validConfig))).not.toThrow();
    expect(() => assertManagedSlotsSupported(undefined)).not.toThrow();
  });

  test("a build without the wiring refuses a supplied config with a typed error", () => {
    expect(codeOf(() => assertManagedSlotsSupported(parseBindingConfig(validConfig), false))).toBe(
      "bindings_unsupported",
    );
    expect(() => assertManagedSlotsSupported(undefined, false)).not.toThrow();
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
      "binding_config_invalid",
    );
    expect(codeOf(() => parseManagedSlotConfigSource("{not json", neverRead))).toBe(
      "binding_config_invalid",
    );
    expect(codeOf(() => parseManagedSlotConfigSource("  ", neverRead))).toBe(
      "binding_config_invalid",
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
    ).toBe("binding_config_invalid");
  });

  test("is incompatible with --initial-session-uuid and --no-proxy", () => {
    expect(
      codeOf(() =>
        resolveManagedSlotConfig({ flagValue: flagJson, readFile: neverRead, noProxy: true }),
      ),
    ).toBe("binding_config_invalid");
    expect(
      codeOf(() =>
        resolveManagedSlotConfig({
          envValue: envJson,
          readFile: neverRead,
          hasInitialSessionUuid: true,
        }),
      ),
    ).toBe("binding_config_invalid");
  });
});

describe("binding config field capabilities", () => {
  test("base fields need no additive capability", () => {
    expect(unmetManagedSlotConfigCapabilities(parseBindingConfig(validConfig), [])).toEqual([]);
  });

  test.each(["android", "ios"] as const)("deviceFamily needs its capability on %s", (platform) => {
    const config = parseBindingConfig({
      ...validConfig,
      requests: [
        {
          ...androidRequest,
          platform,
          requestedSpec: { runtime: "runtime", deviceFamily: "phone" },
        },
      ],
    });
    expect(unmetManagedSlotConfigCapabilities(config, [])).toEqual([
      {
        field: "requests.0.requestedSpec.deviceFamily",
        capability: "managed-slots/v1.deviceFamily",
      },
    ]);
    expect(
      unmetManagedSlotConfigCapabilities(config, [MANAGED_SLOTS_V1_DEVICE_FAMILY_CAPABILITY]),
    ).toEqual([]);
  });

  test("reports only the first request using deviceFamily", () => {
    const base = parseBindingConfig(validConfig);
    const family = {
      ...base.requests[0]!,
      requestedSpec: { runtime: "runtime", deviceFamily: "tablet" as const },
    };
    expect(
      unmetManagedSlotConfigCapabilities(
        { ...base, requests: [base.requests[0]!, family, family] },
        [],
      ),
    ).toEqual([
      {
        field: "requests.1.requestedSpec.deviceFamily",
        capability: "managed-slots/v1.deviceFamily",
      },
    ]);
  });

  test.each(["android", "ios"] as const)("strictly rejects unknown spec keys on %s", (platform) => {
    const parse = () =>
      parseBindingConfig({
        ...validConfig,
        requests: [
          { ...androidRequest, platform, requestedSpec: { runtime: "runtime", futureKey: true } },
        ],
      });
    expect(parse).toThrow(BindingConfigError);
    expect(codeOf(parse)).toBe("binding_config_invalid");
    expect(parse).toThrow('requests.0.requestedSpec: Unrecognized key: "futureKey"');
  });
});
