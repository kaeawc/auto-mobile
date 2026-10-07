import { describe, it, expect } from "bun:test";
import {
  computeStorageCapabilities,
  findOperationCapability,
  isStorageOperationAvailable,
  STORAGE_CAPABILITIES_SCHEMA_VERSION,
  type StorageCapabilityContext,
} from "../../../src/features/storage/storageCapabilities";

function ctx(overrides: Partial<StorageCapabilityContext> = {}): StorageCapabilityContext {
  return {
    platform: "android",
    deviceType: "emulator",
    embeddedSdk: true,
    sessionActive: true,
    ...overrides,
  };
}

describe("computeStorageCapabilities envelope", () => {
  it("stamps the schema version so the resource is versioned", () => {
    const report = computeStorageCapabilities(ctx());
    expect(report.schemaVersion).toBe(STORAGE_CAPABILITIES_SCHEMA_VERSION);
    expect(report.schemaVersion).toBe(1);
  });

  it("echoes the resolved context signals", () => {
    const report = computeStorageCapabilities(
      ctx({ appId: "com.example", debuggableBuild: false, authorized: undefined }),
    );
    expect(report.appId).toBe("com.example");
    expect(report.context.embeddedSdk).toBe(true);
    expect(report.context.debuggableBuild).toBe(false);
  });

  it("reports every logical domain", () => {
    const report = computeStorageCapabilities(ctx());
    expect(report.domains.map((d) => d.domain).sort()).toEqual([
      "app_containers",
      "databases",
      "key_value",
      "media_library",
      "secure_state",
      "user_files",
    ]);
  });

  it("documents extension points without advertising them as portable", () => {
    const report = computeStorageCapabilities(ctx());
    // user_files and secure_state are platform-specific extension points.
    const userFiles = report.domains.find((d) => d.domain === "user_files")!;
    const secure = report.domains.find((d) => d.domain === "secure_state")!;
    expect(userFiles.portable).toBe(false);
    expect(secure.portable).toBe(false);
    expect(report.extensionPoints.length).toBeGreaterThan(0);
    expect(report.extensionPoints.map((e) => e.domain)).toContain("user_files");
  });
});

// AC1: a client can determine whether a proposed operation is available before invoking.
describe("AC1: availability is queryable before invocation", () => {
  it("exposes a definitive state for every domain/operation pair", () => {
    const report = computeStorageCapabilities(ctx());
    for (const domain of report.domains) {
      for (const op of domain.operations) {
        expect(["supported", "partial", "unavailable", "unsupported"]).toContain(op.state);
      }
    }
  });

  it("isStorageOperationAvailable is true only for fully-supported operations", () => {
    const report = computeStorageCapabilities(ctx());
    expect(isStorageOperationAvailable(report, "key_value", "write")).toBe(true);
    // Secure-state mutation is a hard non-goal.
    expect(isStorageOperationAvailable(report, "secure_state", "write")).toBe(false);
    expect(findOperationCapability(report, "secure_state", "write")?.state).toBe("unsupported");
  });

  it("database writes are supported via the sqlQuery tool when the SDK is embedded", () => {
    // sqlQuery (embeddedSdkOnly) executes INSERT/UPDATE/DELETE and DDL, so DB
    // mutation is a real, config-gated capability — not unsupported.
    const report = computeStorageCapabilities(ctx());
    expect(isStorageOperationAvailable(report, "databases", "write")).toBe(true);

    const noSdk = computeStorageCapabilities(ctx({ embeddedSdk: false }));
    expect(findOperationCapability(noSdk, "databases", "write")?.state).toBe("unavailable");
  });

  it("returns undefined for an operation a domain does not expose", () => {
    const report = computeStorageCapabilities(ctx());
    expect(findOperationCapability(report, "key_value", "media_indexing")).toBeUndefined();
    expect(isStorageOperationAvailable(report, "key_value", "media_indexing")).toBe(false);
  });
});

// AC2: platform-qualified user files and app-container access.
describe("AC2: platform-qualified domains", () => {
  it.each([
    [true, "supported"],
    [false, "unavailable"],
    [undefined, "partial"],
  ] as const)(
    "iOS user_files fixture installed=%p yields %s writes and reset",
    (installed, state) => {
      const report = computeStorageCapabilities(
        ctx({ platform: "ios", deviceType: "simulator", iosFilesFixtureInstalled: installed }),
      );
      const userFiles = report.domains.find((d) => d.domain === "user_files")!;
      expect(userFiles.platformScope).toBe("cross-platform");
      expect(userFiles.portable).toBe(false);
      expect(report.context.iosFilesFixtureInstalled).toBe(installed);
      for (const operation of ["write", "namespace_reset"] as const) {
        const capability = findOperationCapability(report, "user_files", operation)!;
        expect(capability.state).toBe(state);
        if (installed !== true) {
          expect(capability.prerequisites).toContain("managed iOS Files fixture app installed");
        }
      }
      for (const operation of ["list", "read"] as const) {
        expect(findOperationCapability(report, "user_files", operation)?.state).toBe("supported");
      }
      expect(findOperationCapability(report, "user_files", "media_indexing")?.state).toBe(
        "unsupported",
      );
    },
  );

  it("iOS user_files absent provider overrides verified fixture installation", () => {
    const report = computeStorageCapabilities(
      ctx({
        platform: "ios",
        deviceType: "simulator",
        iosFilesFixtureInstalled: true,
        providerCoverage: [],
      }),
    );
    for (const operation of ["write", "namespace_reset"] as const) {
      const capability = findOperationCapability(report, "user_files", operation)!;
      expect(capability.state).toBe("unavailable");
      expect(capability.reason).toContain("ios:user_files");
    }
  });

  it("physical iOS user_files remains unsupported even with generic integration and fixture flags", () => {
    const report = computeStorageCapabilities(
      ctx({
        platform: "ios",
        deviceType: "physical",
        iosFileIntegration: true,
        iosFilesFixtureInstalled: true,
      }),
    );
    const userFiles = report.domains.find((d) => d.domain === "user_files")!;
    for (const operation of userFiles.operations) {
      expect(operation.state).toBe("unsupported");
      expect(operation.reason).toContain("on-device fixture-app integration");
    }
    expect(
      report.extensionPoints.find(
        (entry) => entry.domain === "user_files" && entry.platform === "ios",
      )?.description,
    ).toContain("Simulator");
  });

  it("user_files listing, reading, and staging are available with an active Android profile", () => {
    const report = computeStorageCapabilities(
      ctx({ platform: "android", activeUserProfile: true }),
    );
    // putAppFile and the shared-storage resource templates back these operations.
    expect(isStorageOperationAvailable(report, "user_files", "write")).toBe(true);
    for (const operation of ["list", "read"] as const) {
      const capability = findOperationCapability(report, "user_files", operation)!;
      expect(capability.state).toBe("supported");
      expect(capability.reason).toContain("MCP resource template");
    }
    const userFiles = report.domains.find((domain) => domain.domain === "user_files")!;
    expect(userFiles.note).toContain("Downloads Namespace Files");
    expect(userFiles.note).toContain("Downloads Namespace File");
    expect(userFiles.note).toContain(
      "automobile:devices/{deviceId}/downloads/{namespace}[/{path}]",
    );
  });

  it("user_files listing and reading are partial when the active Android profile is unverified", () => {
    const report = computeStorageCapabilities(ctx({ activeUserProfile: undefined }));
    for (const operation of ["list", "read"] as const) {
      const capability = findOperationCapability(report, "user_files", operation)!;
      expect(capability.state).toBe("partial");
      expect(capability.prerequisites).toContain("active Android user/profile");
    }
  });

  it("user_files listing and reading are unavailable without an active Android profile", () => {
    const report = computeStorageCapabilities(ctx({ activeUserProfile: false }));
    for (const operation of ["list", "read"] as const) {
      const capability = findOperationCapability(report, "user_files", operation)!;
      expect(capability.state).toBe("unavailable");
      expect(capability.reason).toBe("Missing prerequisite: active Android user/profile.");
    }
  });

  it("app_containers is supported on iOS simulator", () => {
    const report = computeStorageCapabilities(ctx({ platform: "ios", deviceType: "simulator" }));
    expect(isStorageOperationAvailable(report, "app_containers", "read")).toBe(true);
    expect(isStorageOperationAvailable(report, "app_containers", "write")).toBe(true);
  });

  it("app_containers is supported on Android emulator", () => {
    const report = computeStorageCapabilities(ctx({ platform: "android", deviceType: "emulator" }));
    expect(isStorageOperationAvailable(report, "app_containers", "read")).toBe(true);
  });

  it("non-debuggable physical Android retains externalFiles for every app-container operation", () => {
    const report = computeStorageCapabilities(
      ctx({ platform: "android", deviceType: "physical", debuggableBuild: false }),
    );
    for (const operation of ["list", "read", "write"] as const) {
      const capability = findOperationCapability(report, "app_containers", operation)!;
      expect(capability.state).toBe("partial");
      expect(capability.reason).toBe(
        "Private containers require a debuggable app build; externalFiles remains available.",
      );
      expect(capability.prerequisites).toEqual(["debuggable app build"]);
    }
  });

  it("app_containers on physical Android is gated on a debuggable build", () => {
    const unknown = computeStorageCapabilities(
      ctx({ platform: "android", deviceType: "physical", debuggableBuild: undefined }),
    );
    expect(findOperationCapability(unknown, "app_containers", "read")).toEqual({
      operation: "read",
      state: "partial",
      reason: "Available pending verification of: debuggable app build.",
      prerequisites: ["debuggable app build"],
    });

    const nonDebuggable = computeStorageCapabilities(
      ctx({ platform: "android", deviceType: "physical", debuggableBuild: false }),
    );
    expect(findOperationCapability(nonDebuggable, "app_containers", "read")?.state).toBe("partial");

    const debuggable = computeStorageCapabilities(
      ctx({ platform: "android", deviceType: "physical", debuggableBuild: true }),
    );
    expect(isStorageOperationAvailable(debuggable, "app_containers", "read")).toBe(true);
  });
});

// AC3: iOS physical-device file behavior is unsupported unless an opt-in integration advertises it.
describe("AC3: iOS physical-device file access", () => {
  it("is unsupported by default on physical iOS", () => {
    const report = computeStorageCapabilities(ctx({ platform: "ios", deviceType: "physical" }));
    const appContainers = report.domains.find((d) => d.domain === "app_containers")!;
    for (const op of appContainers.operations) {
      expect(op.state).toBe("unsupported");
    }
  });

  it("becomes partial (opt-in) when an app integration advertises it", () => {
    const report = computeStorageCapabilities(
      ctx({ platform: "ios", deviceType: "physical", iosFileIntegration: true }),
    );
    const read = findOperationCapability(report, "app_containers", "read")!;
    expect(read.state).toBe("partial");
    expect(read.prerequisites).toContain("opt-in iOS app file-access integration");
  });
});

// AC4: partial, disabled, unsupported, and conflicting capability inputs.
describe("AC4: partial / disabled / unsupported / conflicting inputs", () => {
  it("partial: SDK on but a runtime prerequisite is unverified", () => {
    const report = computeStorageCapabilities(
      ctx({ platform: "android", activeUserProfile: undefined }),
    );
    // Shared-storage staging needs an active user/profile the descriptor can't verify.
    const write = findOperationCapability(report, "user_files", "write")!;
    expect(write.state).toBe("partial");
    expect(write.prerequisites?.length).toBeGreaterThan(0);
  });

  it("disabled: embedded SDK off makes key-value operations unavailable", () => {
    const report = computeStorageCapabilities(ctx({ embeddedSdk: false }));
    for (const op of report.domains.find((d) => d.domain === "key_value")!.operations) {
      expect(op.state).toBe("unavailable");
      expect(op.prerequisites).toContain("AutoMobile SDK embedded with storage inspection");
    }
  });

  it("unsupported: secure-state mutation and DataStore-on-iOS are never advertised", () => {
    const android = computeStorageCapabilities(ctx());
    expect(findOperationCapability(android, "secure_state", "write")?.state).toBe("unsupported");

    const ios = computeStorageCapabilities(ctx({ platform: "ios", deviceType: "simulator" }));
    expect(findOperationCapability(ios, "media_library", "media_indexing")?.state).toBe(
      "unsupported",
    );
  });

  it("conflicting: embeddedSdk true but sessionActive false resolves to the blocker (unavailable)", () => {
    const report = computeStorageCapabilities(ctx({ embeddedSdk: true, sessionActive: false }));
    const write = findOperationCapability(report, "key_value", "write")!;
    expect(write.state).toBe("unavailable");
    expect(write.prerequisites).toContain("active CtrlProxy runner session");
    // The satisfied SDK prerequisite is not listed as missing.
    expect(write.reason).not.toContain("AutoMobile SDK");
  });

  it("conflicting: a known-unmet prerequisite dominates an unverified one", () => {
    const report = computeStorageCapabilities(
      // databases read needs the SDK AND a session; here the SDK is known-off
      // (a hard blocker) while the session is merely unverified.
      ctx({ embeddedSdk: false, sessionActive: undefined }),
    );
    const read = findOperationCapability(report, "databases", "read")!;
    expect(read.state).toBe("unavailable");
  });

  it("Android media reads are supported with an active profile and gated by registration", () => {
    const report = computeStorageCapabilities(ctx({ activeUserProfile: true }));
    for (const operation of ["list", "read"] as const) {
      expect(findOperationCapability(report, "media_library", operation)?.state).toBe("supported");
      const absent = computeStorageCapabilities(
        ctx({ activeUserProfile: true, mediaLibraryReadCoverage: { list: false, read: false } }),
      );
      expect(findOperationCapability(absent, "media_library", operation)?.state).toBe(
        "unavailable",
      );
      const ios = computeStorageCapabilities(ctx({ platform: "ios", deviceType: "simulator" }));
      expect(findOperationCapability(ios, "media_library", operation)?.state).toBe("unavailable");
      expect(findOperationCapability(ios, "media_library", operation)?.reason).toContain(
        "simctl addmedia",
      );
    }
  });

  it("advertises Android media_library writes only when an active profile is available", () => {
    const available = computeStorageCapabilities(ctx({ activeUserProfile: true }));
    expect(isStorageOperationAvailable(available, "media_library", "write")).toBe(true);
    expect(findOperationCapability(available, "media_library", "media_indexing")?.state).toBe(
      "supported",
    );

    const ios = computeStorageCapabilities(ctx({ platform: "ios", deviceType: "simulator" }));
    expect(findOperationCapability(ios, "media_library", "write")?.state).toBe("supported");
    expect(
      findOperationCapability(
        computeStorageCapabilities(ctx({ platform: "ios", deviceType: "physical" })),
        "media_library",
        "write",
      )?.state,
    ).toBe("unsupported");
  });

  it("iOS secure_state read is unavailable pending the #5161 host policy, not unsupported", () => {
    const report = computeStorageCapabilities(ctx({ platform: "ios", deviceType: "simulator" }));
    const read = findOperationCapability(report, "secure_state", "read")!;
    expect(read.state).toBe("unavailable");
    expect(read.prerequisites?.some((p) => p.includes("5161"))).toBe(true);
  });
});

describe("determinism", () => {
  it("produces identical reports for identical contexts", () => {
    const a = computeStorageCapabilities(ctx({ appId: "com.x" }));
    const b = computeStorageCapabilities(ctx({ appId: "com.x" }));
    expect(a).toEqual(b);
  });
});

describe("Android app-owned Keystore capability", () => {
  it("reports discovered metadata support and keeps host read and mutation unavailable", () => {
    const keystore = {
      schemaVersion: 1,
      capability: "storage.keystore",
      outcome: "ok",
      bridgeAvailable: true,
      metadata: "supported",
      mutation: "declared_unsupported",
      deviceLocked: "locked",
      scopes: ["fixture"],
    } as const;
    const report = computeStorageCapabilities(
      ctx({ keystore: { ...keystore, scopes: [...keystore.scopes] } }),
    );
    const secure = report.domains.find((d) => d.domain === "secure_state")!;
    expect(secure.capabilities).toEqual([keystore]);
    expect(findOperationCapability(report, "secure_state", "read")?.state).toBe("unavailable");
    expect(findOperationCapability(report, "secure_state", "write")?.state).toBe("unsupported");
    expect(findOperationCapability(report, "secure_state", "namespace_reset")?.state).toBe(
      "unsupported",
    );
  });
  it("does not infer Keystore bridge availability from embedded SDK", () => {
    expect(
      computeStorageCapabilities(ctx()).domains.find((d) => d.domain === "secure_state")
        ?.capabilities,
    ).toEqual([]);
  });
});
