import { describe, expect, test } from "bun:test";
import {
  computeStorageCapabilities,
  findOperationCapability,
  type StorageCapabilityContext,
  type StorageOperation,
} from "../../../src/features/storage/storageCapabilities";
import {
  createAppFileServiceForTesting,
  describeProviderCoverage,
  describeDefaultAppFileProviderCoverage,
  type AppFileProvider,
  type AppFileWriteProvider,
} from "../../../src/server/appFileService";
import { describeDefaultSharedStorageReadCoverage } from "../../../src/server/sharedStorageReadService";
import type { StorageDomain } from "../../../src/server/appFileContract";

const context: StorageCapabilityContext = {
  platform: "android",
  deviceType: "emulator",
  embeddedSdk: false,
  activeUserProfile: true,
};
function writeProvider(
  domain: StorageDomain,
  platform: "android" | "ios" = "android",
): AppFileWriteProvider {
  return {
    platform,
    domain,
    features: { namespaceReset: true, mediaIndexing: true },
    putFile: async () => {
      throw new Error("metadata must not perform writes");
    },
  };
}
function state(domain: StorageDomain, operation: StorageOperation, ctx: StorageCapabilityContext) {
  return findOperationCapability(computeStorageCapabilities(ctx), domain, operation);
}

describe("registered storage provider coverage", () => {
  test.each(["write", "namespace_reset", "media_indexing"] as const)(
    "user_files %s follows the write provider",
    (operation) => {
      const coverage = describeProviderCoverage([writeProvider("user_files")]);
      expect(
        state("user_files", operation, { ...context, providerCoverage: coverage })?.state,
      ).toBe("supported");
      const absent = state("user_files", operation, { ...context, providerCoverage: [] });
      expect(absent?.state).toBe("unavailable");
      expect(absent?.reason).toContain("provider");
      expect(absent?.reason).toContain("android:user_files");
    },
  );

  test.each(["list", "read"] as const)(
    "user_files %s follows separate shared read coverage",
    (operation) => {
      for (const present of [true, false]) {
        const ctx = {
          ...context,
          providerCoverage: [],
          sharedStorageReadCoverage: { list: present, read: present },
        };
        expect(state("user_files", operation, ctx)?.state).toBe(
          present ? "supported" : "unavailable",
        );
      }
      expect(describeDefaultSharedStorageReadCoverage("ios")).toEqual({ list: true, read: true });
      expect(describeDefaultSharedStorageReadCoverage("ios", "media_library")).toEqual({
        list: false,
        read: false,
      });
    },
  );

  test.each(["android", "ios"] as const)(
    "write-only %s media coverage does not imply reads",
    (platform) => {
      const ctx = {
        ...context,
        platform,
        deviceType: platform === "ios" ? ("simulator" as const) : ("emulator" as const),
        providerCoverage: describeProviderCoverage([writeProvider("media_library", platform)]),
        mediaLibraryReadCoverage: { list: false, read: false },
      };
      expect(state("media_library", "write", ctx)?.state).toBe("supported");
      for (const operation of ["list", "read"] as const) {
        expect(state("media_library", operation, ctx)?.state).toBe("unavailable");
        expect(state("media_library", operation, ctx)?.reason).toContain(
          `No SharedStorageReadService ${operation} provider`,
        );
      }
      expect(state("media_library", "write", { ...ctx, providerCoverage: [] })?.state).toBe(
        "unavailable",
      );
    },
  );

  test.each(["write", "list", "read"] as const)(
    "app_containers %s follows its own registration",
    (operation) => {
      const provider: AppFileProvider =
        operation === "write"
          ? writeProvider("app_containers")
          : operation === "list"
            ? {
                platform: "android",
                domain: "app_containers",
                listFiles: async () => {
                  throw new Error("unused");
                },
              }
            : {
                platform: "android",
                domain: "app_containers",
                readFile: async () => {
                  throw new Error("unused");
                },
              };
      const ctx = { ...context, providerCoverage: describeProviderCoverage([provider]) };
      expect(state("app_containers", operation, ctx)?.state).toBe("supported");
      expect(state("app_containers", operation, { ...ctx, providerCoverage: [] })?.state).toBe(
        "unavailable",
      );
    },
  );

  test("Android media indexing follows the registered declaring write provider", () => {
    const present = {
      ...context,
      providerCoverage: describeProviderCoverage([writeProvider("media_library")]),
    };
    expect(state("media_library", "media_indexing", present)?.state).toBe("supported");
    expect(
      state("media_library", "media_indexing", { ...present, providerCoverage: [] })?.state,
    ).toBe("unavailable");
    expect(
      state("media_library", "media_indexing", { ...present, activeUserProfile: false })?.state,
    ).toBe("unavailable");
    const ios = { ...context, platform: "ios" as const, deviceType: "simulator" as const };
    expect(state("media_library", "media_indexing", ios)?.state).toBe("unsupported");
  });

  test("features require declarations and prerequisites even when write is registered", () => {
    const provider = { ...writeProvider("user_files"), features: undefined };
    const coverage = describeProviderCoverage([provider]);
    expect(state("user_files", "write", { ...context, providerCoverage: coverage })?.state).toBe(
      "supported",
    );
    expect(
      state("user_files", "namespace_reset", { ...context, providerCoverage: coverage })?.state,
    ).toBe("unavailable");
    expect(
      state("user_files", "media_indexing", { ...context, providerCoverage: coverage })?.state,
    ).toBe("unavailable");
    expect(
      state("user_files", "write", {
        ...context,
        activeUserProfile: false,
        providerCoverage: coverage,
      })?.state,
    ).toBe("unavailable");
  });

  test("physical iOS restrictions remain authoritative", () => {
    const ctx = { ...context, platform: "ios" as const, deviceType: "physical" as const };
    for (const providerCoverage of [[], describeDefaultAppFileProviderCoverage()]) {
      for (const operation of ["list", "read", "write"] as const) {
        expect(state("app_containers", operation, { ...ctx, providerCoverage })?.state).toBe(
          "unsupported",
        );
      }
      expect(state("media_library", "write", { ...ctx, providerCoverage })?.state).toBe(
        "unsupported",
      );
    }
  });

  test("registry coverage uses the same last-wins write provider as routing", () => {
    const first = writeProvider("user_files");
    const last = { ...first, features: undefined };
    const service = createAppFileServiceForTesting({
      providers: [first, last],
      deviceResolver: async () => {
        throw new Error("unused");
      },
    });
    expect(service.describeProviderCoverage?.()).toEqual(describeProviderCoverage([last]));
    expect(service.describeProviderCoverage?.()[0]?.namespaceReset).toBe(false);
  });

  test("default metadata comes from production providers including declared features", () => {
    const coverage = describeDefaultAppFileProviderCoverage();
    expect(
      coverage.find((entry) => entry.platform === "android" && entry.domain === "user_files"),
    ).toMatchObject({
      write: true,
      list: false,
      read: false,
      namespaceReset: true,
      mediaIndexing: true,
    });
    expect(
      coverage.find((entry) => entry.platform === "ios" && entry.domain === "media_library"),
    ).toMatchObject({
      write: true,
      list: false,
      read: false,
      namespaceReset: false,
      mediaIndexing: false,
    });
  });
});
