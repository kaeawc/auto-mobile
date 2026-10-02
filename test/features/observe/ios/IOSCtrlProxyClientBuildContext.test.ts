import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { iosRecordToMetadata } from "../../../../src/features/observe/GetAppMetadata";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import { NavigationGraphManager } from "../../../../src/features/navigation/NavigationGraphManager";
import { NavigationRepository } from "../../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../../src/db/testCoverageRepository";
import type { BootedDevice } from "../../../../src/models";
import type { IosAppMetadataSource } from "../../../../src/models/IosAppMetadataSource";
import type { ContentHashProvider } from "../../../../src/utils/ContentHashProvider";
import { logger } from "../../../../src/utils/logger";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createSuccessWebSocketFactory } from "../../../fakes/FakeWebSocket";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../../helpers/navigationTestHarness";

const appId = "com.example.build-context";
const simulatorId = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const physicalId = "00008110-001234567890001E";

class FakeIosMetadataSource implements IosAppMetadataSource {
  buildNumber = "42";
  simulatorCalls: (string | undefined)[] = [];
  physicalCalls: [string, string][] = [];
  failure: Error | null = null;
  missing = false;
  pending: Promise<Record<string, unknown>[]> | null = null;
  appIds = [appId];

  private record(): Record<string, unknown> {
    if (this.failure) {
      throw this.failure;
    }
    return { CFBundleIdentifier: appId, CFBundleVersion: this.buildNumber, Path: "/fake/App.app" };
  }

  async listApps(deviceId?: string): Promise<Record<string, unknown>[]> {
    this.simulatorCalls.push(deviceId);
    const record = this.record();
    return (
      this.pending ??
      (this.missing ? [] : this.appIds.map((id) => ({ ...record, CFBundleIdentifier: id })))
    );
  }

  async getPhysicalDeviceAppInfo(
    deviceId: string,
    bundleId: string,
  ): Promise<Record<string, unknown>> {
    this.physicalCalls.push([deviceId, bundleId]);
    return this.record();
  }
}

class FakeContentHashProvider implements ContentHashProvider {
  calls: [BootedDevice, string, number | string][] = [];
  invalidations: [string, string][] = [];
  result: string | null = "fake-content-hash";
  pending: Promise<string | null> | null = null;
  failure: Error | null = null;

  async resolveContentHash(
    device: BootedDevice,
    bundleId: string,
    versionCode: number | string,
  ): Promise<string | null> {
    this.calls.push([device, bundleId, versionCode]);
    if (this.failure) {
      throw this.failure;
    }
    return this.pending ?? this.result;
  }

  invalidate(deviceId: string, bundleId: string): void {
    this.invalidations.push([deviceId, bundleId]);
  }
}

describe("IOSCtrlProxyClient lazy build context", () => {
  let harness: InMemoryNavManagerHarness;
  let timer: FakeTimer;
  let source: FakeIosMetadataSource;
  let provider: FakeContentHashProvider;
  let client: IOSCtrlProxyClient;
  let setContext: ReturnType<typeof spyOn<NavigationGraphManager, "setBuildContext">>;
  let onHierarchy: ReturnType<typeof spyOn>;
  let warnLog: ReturnType<typeof spyOn<typeof logger, "warn">>;
  let infoLog: ReturnType<typeof spyOn<typeof logger, "info">>;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
  });
  afterAll(async () => {
    await harness.dispose();
  });

  function createClient(deviceId = simulatorId): IOSCtrlProxyClient {
    const device: BootedDevice = { deviceId, platform: "ios", name: "fake iOS device" };
    const created = IOSCtrlProxyClient.createForTesting(
      device,
      8765,
      createSuccessWebSocketFactory(timer),
      timer,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { iosSource: source, contentHashProvider: provider },
    );
    // Suppress unrelated foreground monitoring/SDK probing; exercise the real
    // hierarchy hook and manager context without navigation DB writes or sockets.
    created["lastForegroundBundleId"] = appId;
    onHierarchy = spyOn(
      created.getHierarchyNavigationDetector(),
      "onHierarchyUpdate",
    ).mockImplementation(() => {});
    return created;
  }

  function hierarchyUpdate(bundleId = appId): void {
    client["lastForegroundBundleId"] = bundleId;
    client["handleHierarchyUpdateForNavigation"]({
      updatedAt: timer.now(),
      packageName: bundleId,
      hierarchy: { text: "Home" },
    });
  }

  async function settle(): Promise<void> {
    await timer.advanceTimersByTimeAsync(0);
    // Metadata and hash resolution are layered promises, all controlled locally.
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
    }
  }

  beforeEach(() => {
    warnLog = spyOn(logger, "warn").mockImplementation(() => {});
    infoLog = spyOn(logger, "info").mockImplementation(() => {});
    timer = new FakeTimer();
    source = new FakeIosMetadataSource();
    provider = new FakeContentHashProvider();
    harness.manager.clearBuildContext(appId);
    setContext = spyOn(harness.manager, "setBuildContext");
    client = createClient();
  });

  afterEach(async () => {
    await client.close();
    onHierarchy.mockRestore();
    setContext.mockRestore();
    infoLog.mockRestore();
    warnLog.mockRestore();
    timer.reset();
  });

  test("hierarchy writes proceed immediately, then simulator provenance resolves out of band", async () => {
    hierarchyUpdate();
    expect(onHierarchy).toHaveBeenCalledTimes(1);
    expect(source.simulatorCalls).toEqual([]);
    expect(setContext).not.toHaveBeenCalled();
    await settle();
    expect(source.simulatorCalls).toEqual([simulatorId]);
    expect(source.physicalCalls).toEqual([]);
    expect(provider.calls[0]?.slice(1)).toEqual([appId, 42]);
    expect(setContext).toHaveBeenCalledWith({
      appId,
      deviceId: simulatorId,
      versionCode: 42,
      contentHash: "fake-content-hash",
    });
    expect(harness.manager.getDeviceIdForApp(appId)).toBe(simulatorId);
  });

  test("physical devices resolve device-only context once without metadata or hashing", async () => {
    await client.close();
    onHierarchy.mockRestore();
    client = createClient(physicalId);
    for (let i = 0; i < 20; i++) {
      hierarchyUpdate();
      await settle();
    }
    expect(source.simulatorCalls).toEqual([]);
    expect(source.physicalCalls).toEqual([]);
    expect(provider.calls).toEqual([]);
    expect(infoLog.mock.calls.filter(([message]) => message.includes(appId))).toHaveLength(1);
    expect(harness.manager.getDeviceIdForApp(appId)).toBe(physicalId);
    expect(harness.manager["resolveProvenance"](appId)).toMatchObject({
      versionCode: 0,
      contentHash: "",
      deviceId: physicalId,
    });
  });

  test("coalesces overlapping events and reuses the resolved context", async () => {
    const hash = Promise.withResolvers<string | null>();
    provider.pending = hash.promise;
    hierarchyUpdate();
    hierarchyUpdate();
    await settle();
    hierarchyUpdate();
    await settle();
    expect(provider.calls).toHaveLength(1);
    expect(source.simulatorCalls).toHaveLength(1);
    hash.resolve("cached");
    await settle();
    hierarchyUpdate();
    await settle();
    expect(provider.calls).toHaveLength(1);
    expect(source.simulatorCalls).toHaveLength(1);
    expect(setContext).toHaveBeenCalledTimes(2);
  });

  test("a null hash leaves no context and retries after backoff", async () => {
    provider.result = null;
    hierarchyUpdate();
    await settle();
    expect(setContext).not.toHaveBeenCalled();
    expect(harness.manager.getDeviceIdForApp(appId)).toBeNull();
    await timer.advanceTimersByTimeAsync(5000);
    provider.result = "retry";
    hierarchyUpdate();
    await settle();
    expect(provider.calls).toHaveLength(2);
    expect(harness.manager.getDeviceIdForApp(appId)).toBe(simulatorId);
  });

  test("a metadata exception leaves no context and retries", async () => {
    source.failure = new Error("metadata unavailable");
    hierarchyUpdate();
    await settle();
    expect(setContext).not.toHaveBeenCalled();
    expect(provider.calls).toHaveLength(0);
    await timer.advanceTimersByTimeAsync(5000);
    source.failure = null;
    hierarchyUpdate();
    await settle();
    expect(source.simulatorCalls).toHaveLength(2);
    expect(harness.manager.getDeviceIdForApp(appId)).toBe(simulatorId);
  });

  test("a throwing provider remains best effort and retries", async () => {
    provider.failure = new Error("hash unavailable");
    hierarchyUpdate();
    await settle();
    expect(setContext).not.toHaveBeenCalled();
    expect(onHierarchy).toHaveBeenCalledTimes(1);
    await timer.advanceTimersByTimeAsync(5000);
    provider.failure = null;
    hierarchyUpdate();
    await settle();
    expect(provider.calls).toHaveLength(2);
    expect(harness.manager.getDeviceIdForApp(appId)).toBe(simulatorId);
  });

  test.each(["\t42", "42\n", `${" ".repeat(65)}42`])(
    "trimmed integer build number %j retains the integer provenance path",
    async (buildNumber) => {
      source.buildNumber = buildNumber;
      hierarchyUpdate();
      await settle();
      expect(provider.calls[0]?.slice(1)).toEqual([appId, 42]);
      expect(setContext).toHaveBeenCalledWith({
        appId,
        deviceId: simulatorId,
        versionCode: 42,
        contentHash: "fake-content-hash",
      });
      expect(setContext.mock.calls.at(-1)?.[0]).not.toHaveProperty("versionKey");
    },
  );

  test.each(["   ", "\t42", "42\n", " 1.2.3 "])(
    "metadata trims build number %j before exposing it to resource consumers",
    (buildNumber) => {
      expect(iosRecordToMetadata(appId, { CFBundleVersion: buildNumber }).buildNumber).toBe(
        buildNumber.trim(),
      );
    },
  );

  test.each(["1.2.3", "42.0", "unknown", "-1", "0x2a", "4e1", "9007199254740992", "v".repeat(64)])(
    "string build number %j resolves real provenance without a numeric mapping",
    async (buildNumber) => {
      source.buildNumber = ` ${buildNumber} `;
      hierarchyUpdate();
      await settle();
      expect(provider.calls[0]?.slice(1)).toEqual([appId, buildNumber]);
      expect(setContext).toHaveBeenCalledWith({
        appId,
        deviceId: simulatorId,
        versionCode: 0,
        versionKey: buildNumber,
        contentHash: "fake-content-hash",
      });
      expect(harness.manager.getDeviceIdForApp(appId)).toBe(simulatorId);
    },
  );

  test.each(["", "   ", "v".repeat(65), "1\u00002", "1\n2", " 1\n2 ", "1\u007f2", "1\u00852"])(
    "terminal build number %j attributes the device under the unknown build key until invalidation",
    async (buildNumber) => {
      source.buildNumber = buildNumber;
      hierarchyUpdate();
      await settle();
      expect(provider.calls).toHaveLength(0);
      expect(harness.manager.getDeviceIdForApp(appId)).toBe(simulatorId);
      expect(harness.manager["resolveProvenance"](appId)).toMatchObject({
        versionCode: 0,
        contentHash: "",
        deviceId: simulatorId,
      });
      source.buildNumber = "43";
      for (let i = 0; i < 20; i++) {
        hierarchyUpdate();
        await settle();
      }
      await timer.advanceTimersByTimeAsync(300000);
      hierarchyUpdate();
      await settle();
      expect(source.simulatorCalls).toHaveLength(1);
      expect(
        infoLog.mock.calls.filter(
          ([message]) =>
            message.includes(appId) && message.includes(JSON.stringify(buildNumber.trim())),
        ),
      ).toHaveLength(1);
      client.clearSdkScreenIdentity(appId);
      hierarchyUpdate();
      await settle();
      expect(source.simulatorCalls).toHaveLength(2);
      expect(provider.calls[0]?.[2]).toBe(43);
    },
  );

  test("uses an explicitly reported zero build number", async () => {
    source.buildNumber = "0";
    hierarchyUpdate();
    await settle();
    expect(provider.calls[0]?.[2]).toBe(0);
    expect(harness.manager.getDeviceIdForApp(appId)).toBe(simulatorId);
  });

  test.each([true, false])(
    "invalidation discards an in-flight hash (app-specific=%j)",
    async (appSpecific) => {
      const hash = Promise.withResolvers<string | null>();
      provider.pending = hash.promise;
      hierarchyUpdate();
      await settle();
      client.clearSdkScreenIdentity(appSpecific ? appId : undefined);
      expect(provider.invalidations).toEqual([[simulatorId, appId]]);
      hash.resolve("stale");
      await settle();
      expect(setContext).not.toHaveBeenCalled();
      provider.pending = null;
      provider.result = "new-build";
      hierarchyUpdate();
      await settle();
      expect(provider.calls).toHaveLength(2);
      expect(setContext).toHaveBeenCalledWith({
        appId,
        deviceId: simulatorId,
        versionCode: 42,
        contentHash: "new-build",
      });
    },
  );

  test("invalidation clears resolved provenance and forces a fresh hash", async () => {
    hierarchyUpdate();
    await settle();
    client.clearSdkScreenIdentity(appId);
    expect(harness.manager.getDeviceIdForApp(appId)).toBeNull();
    provider.result = "replacement";
    hierarchyUpdate();
    await settle();
    expect(provider.calls).toHaveLength(2);
    expect(setContext.mock.calls.at(-1)?.[0].contentHash).toBe("replacement");
  });

  test("an SDK process-session replacement invalidates resolved provenance", async () => {
    client["activateSdkScreenIdentitySession"](appId, {
      sessionId: "old-process",
      sessionEpoch: 1,
    });
    hierarchyUpdate();
    await settle();
    expect(
      client["activateSdkScreenIdentitySession"](appId, {
        sessionId: "new-process",
        sessionEpoch: 2,
      }),
    ).toBe(true);
    expect(provider.invalidations).toEqual([[simulatorId, appId]]);
    expect(harness.manager.getDeviceIdForApp(appId)).toBeNull();
    hierarchyUpdate();
    await settle();
    expect(provider.calls).toHaveLength(2);
  });

  test.each(["null metadata", "null hash", "metadata exception", "hash exception"])(
    "%s backs off across rapid events, doubles delays to the cap, and resets on invalidation",
    async (failure) => {
      source.missing = failure === "null metadata";
      source.failure = failure === "metadata exception" ? new Error("metadata failed") : null;
      provider.result = failure === "null hash" ? null : "hash";
      provider.failure = failure === "hash exception" ? new Error("hash failed") : null;
      const delays = [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000];
      hierarchyUpdate();
      await settle();
      for (const [index, delay] of delays.entries()) {
        for (let i = 0; i < 20; i++) {
          hierarchyUpdate();
          await settle();
        }
        expect(source.simulatorCalls).toHaveLength(index + 1);
        // Stale context must still be cleared during the negative-cache window.
        harness.manager.setBuildContext({
          appId,
          deviceId: "stale",
          versionCode: 9,
          contentHash: "stale",
        });
        await timer.advanceTimersByTimeAsync(delay - 1);
        hierarchyUpdate();
        await settle();
        expect(harness.manager.getDeviceIdForApp(appId)).toBeNull();
        expect(source.simulatorCalls).toHaveLength(index + 1);
        await timer.advanceTimersByTimeAsync(1);
        hierarchyUpdate();
        await settle();
        expect(source.simulatorCalls).toHaveLength(index + 2);
      }
      client.clearSdkScreenIdentity();
      hierarchyUpdate();
      await settle();
      expect(source.simulatorCalls).toHaveLength(delays.length + 2);
      await timer.advanceTimersByTimeAsync(4999);
      hierarchyUpdate();
      await settle();
      expect(source.simulatorCalls).toHaveLength(delays.length + 2);
      await timer.advanceTimersByTimeAsync(1);
      hierarchyUpdate();
      await settle();
      expect(source.simulatorCalls).toHaveLength(delays.length + 3);
    },
  );

  test.each(["resolve", "reject"])(
    "hung metadata times out, backs off, and discards late %s",
    async (late) => {
      const metadata = Promise.withResolvers<Record<string, unknown>[]>();
      source.pending = metadata.promise;
      hierarchyUpdate();
      await settle();
      await timer.advanceTimersByTimeAsync(29999);
      hierarchyUpdate();
      await settle();
      expect(source.simulatorCalls).toHaveLength(1);
      await timer.advanceTimersByTimeAsync(1);
      await settle();
      expect(client["buildContextInFlight"].size).toBe(0);
      source.pending = null;
      hierarchyUpdate();
      await settle();
      expect(source.simulatorCalls).toHaveLength(1);
      await timer.advanceTimersByTimeAsync(5000);
      hierarchyUpdate();
      await settle();
      expect(source.simulatorCalls).toHaveLength(2);
      expect(provider.calls).toHaveLength(1);
      if (late === "resolve") {
        metadata.resolve([{ CFBundleIdentifier: appId, CFBundleVersion: "99" }]);
      } else {
        metadata.reject(new Error("late metadata rejection"));
      }
      await settle();
      expect(provider.calls).toHaveLength(1);
      expect(setContext).toHaveBeenCalledTimes(1);
      expect(setContext.mock.calls[0]?.[0].versionCode).toBe(42);
    },
  );

  test("the deadline covers hashing and discards a late hash", async () => {
    const hash = Promise.withResolvers<string | null>();
    provider.pending = hash.promise;
    hierarchyUpdate();
    await settle();
    await timer.advanceTimersByTimeAsync(30000);
    await settle();
    expect(client["buildContextInFlight"].size).toBe(0);
    hash.resolve("late hash");
    await settle();
    expect(setContext).not.toHaveBeenCalled();
    hierarchyUpdate();
    await settle();
    expect(provider.calls).toHaveLength(1);
  });

  test("close cancels a scheduled resolution before metadata reads", async () => {
    hierarchyUpdate();
    await client.close();
    await settle();
    hierarchyUpdate();
    await settle();
    expect(source.simulatorCalls).toEqual([]);
    expect(provider.calls).toEqual([]);
    expect(harness.manager.getDeviceIdForApp(appId)).toBeNull();
    expect(client["buildContextInFlight"].size).toBe(0);
  });

  test.each(["metadata", "hash"])(
    "close during %s discards late results and clears context",
    async (phase) => {
      const metadata = Promise.withResolvers<Record<string, unknown>[]>();
      const hash = Promise.withResolvers<string | null>();
      if (phase === "metadata") {
        source.pending = metadata.promise;
      } else {
        provider.pending = hash.promise;
      }
      hierarchyUpdate();
      await settle();
      await client.close();
      metadata.resolve([{ CFBundleIdentifier: appId, CFBundleVersion: "42" }]);
      hash.resolve("released device");
      await settle();
      expect(setContext).not.toHaveBeenCalled();
      expect(provider.calls).toHaveLength(phase === "metadata" ? 0 : 1);
      expect(harness.manager.getDeviceIdForApp(appId)).toBeNull();
      expect(client["buildContextInFlight"].size).toBe(0);
    },
  );

  test("close clears previously applied contexts", async () => {
    hierarchyUpdate();
    await settle();
    expect(harness.manager.getDeviceIdForApp(appId)).toBe(simulatorId);
    await client.close();
    expect(harness.manager.getDeviceIdForApp(appId)).toBeNull();
    expect(client["resolvedBuildContexts"].size).toBe(0);
  });

  test.each([true, false])(
    "close still tears down when navigation-manager lookup throws (resolved=%j)",
    async (resolved) => {
      hierarchyUpdate();
      if (resolved) {
        await settle();
      }
      const managerLookup = spyOn(client, "getNavigationGraphManager").mockImplementation(() => {
        throw new Error("manager unavailable");
      });
      try {
        await client.close();
        await settle();
        expect(source.simulatorCalls).toHaveLength(resolved ? 1 : 0);
        expect(client["buildContextInFlight"].size).toBe(0);
        expect(harness.manager.getDeviceIdForApp(appId)).toBeNull();
      } finally {
        managerLookup.mockRestore();
      }
    },
  );

  test("rapid A -> B -> A switches discard the first A result without cross-app context", async () => {
    const appB = "com.example.other-build-context";
    source.appIds = [appId, appB];
    const staleHash = Promise.withResolvers<string | null>();
    provider.pending = staleHash.promise;
    hierarchyUpdate(appId);
    await settle();
    client.clearSdkScreenIdentity(appId);
    provider.pending = null;
    provider.result = "B hash";
    hierarchyUpdate(appB);
    await settle();
    client.clearSdkScreenIdentity(appB);
    provider.result = "current A hash";
    hierarchyUpdate(appId);
    await settle();
    staleHash.resolve("stale A hash");
    await settle();
    expect(setContext.mock.calls.map(([context]) => [context.appId, context.contentHash])).toEqual([
      [appB, "B hash"],
      [appId, "current A hash"],
    ]);
    expect(harness.manager.getDeviceIdForApp(appB)).toBeNull();
    expect(harness.manager.getDeviceIdForApp(appId)).toBe(simulatorId);
    expect(client["buildContextInFlight"].size).toBe(0);
  });

  test("production construction leaves metadata and content-hash factories lazy", async () => {
    const production = IOSCtrlProxyClient.getInstance(
      { deviceId: simulatorId, platform: "ios", name: "fake production device" },
      8765,
    );
    try {
      expect(production["iosSource"]).toBeUndefined();
      expect(production["appMetadata"]).toBeUndefined();
      expect(production["contentHashProvider"]).toBeUndefined();
    } finally {
      await production.close();
      IOSCtrlProxyClient.clearInstanceRegistryForTesting();
    }
  });

  test.each([true, false])(
    "rebind applies provenance to the current session (already resolved=%j)",
    async (alreadyResolved) => {
      const nextManager = NavigationGraphManager.createForTesting(
        new NavigationRepository(harness.db),
        new TestCoverageRepository(undefined, harness.db),
        timer,
        "session-B",
      );
      const sessionManager = spyOn(
        NavigationGraphManager,
        "getInstanceForSession",
      ).mockImplementation((sessionId) =>
        sessionId === "session-B" ? nextManager : harness.manager,
      );
      const hash = Promise.withResolvers<string | null>();
      provider.pending = alreadyResolved ? null : hash.promise;
      try {
        client.bindSession("session-A");
        hierarchyUpdate();
        await settle();
        client.bindSession("session-B");
        if (!alreadyResolved) {
          hash.resolve("rebound");
          await settle();
        }
        onHierarchy.mockRestore();
        onHierarchy = spyOn(
          client.getHierarchyNavigationDetector(),
          "onHierarchyUpdate",
        ).mockImplementation(() => {});
        hierarchyUpdate();
        await settle();
        expect(nextManager.getDeviceIdForApp(appId)).toBe(simulatorId);
        expect(provider.calls).toHaveLength(1);
        await client.close();
        expect(harness.manager.getDeviceIdForApp(appId)).toBeNull();
        expect(nextManager.getDeviceIdForApp(appId)).toBeNull();
      } finally {
        client.clearSdkScreenIdentity(appId);
        sessionManager.mockRestore();
        client["boundSessionId"] = null;
      }
    },
  );

  test("without resolved provenance, clears stale context on the current manager before writing", async () => {
    harness.manager.setBuildContext({
      appId,
      deviceId: "previous-device",
      versionCode: 7,
      contentHash: "stale",
    });
    setContext.mockClear();
    provider.result = null;
    hierarchyUpdate();
    expect(harness.manager.getDeviceIdForApp(appId)).toBeNull();
    await settle();
    expect(setContext).not.toHaveBeenCalled();
  });
});
