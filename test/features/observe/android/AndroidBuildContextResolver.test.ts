import { describe, expect, test } from "bun:test";
import {
  AndroidBuildContextResolver,
  type AndroidBuildContextContext,
} from "../../../../src/features/observe/android/AndroidBuildContextResolver";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { NavigationBuildContext } from "../../../../src/features/navigation/NavigationGraphManager";
import type { A11yPackageInfoResult } from "../../../../src/features/observe/android/types";

function resolvedPackageInfo(extra: Partial<A11yPackageInfoResult> = {}): A11yPackageInfoResult {
  return {
    success: true,
    totalTimeMs: 1,
    packageName: "com.app",
    isSystem: false,
    versionCode: 7,
    requestedPermissions: [],
    grantedPermissions: {},
    ...extra,
  };
}

/** Resolve one app end to end against a fixed package-info response and hash. */
async function resolveWith(info: A11yPackageInfoResult): Promise<NavigationBuildContext[]> {
  const timer = new FakeTimer();
  const applied: NavigationBuildContext[] = [];
  const resolver = new AndroidBuildContextResolver({
    closed: false,
    device: { deviceId: "emu", name: "Pixel", platform: "android" },
    adb: new FakeAdbExecutor(),
    timer,
    getNavigationGraphManager: () => ({
      setBuildContext: (context) => applied.push(context),
      clearBuildContext: () => {},
    }),
    requestPackageInfo: async () => info,
  });
  resolver.contentHashProvider = {
    resolveContentHash: async () => "hash-1",
    invalidate: () => {},
  };
  resolver.ensure("com.app");
  timer.advanceTime(0);
  for (let i = 0; i < 5 && applied.length === 0; i++) {
    await Promise.resolve();
  }
  return applied;
}

function harness(options: { closed?: boolean } = {}) {
  const timer = new FakeTimer();
  const cleared: string[] = [];
  const requested: string[] = [];
  const manager = {
    setBuildContext: () => {},
    clearBuildContext: (appId: string) => {
      cleared.push(appId);
    },
  };
  const context: AndroidBuildContextContext = {
    closed: options.closed ?? false,
    device: { deviceId: "emu", name: "Pixel", platform: "android" },
    adb: new FakeAdbExecutor(),
    timer,
    getNavigationGraphManager: () => manager,
    requestPackageInfo: async (appId) => {
      requested.push(appId);
      return { success: false } as never;
    },
  };
  return { resolver: new AndroidBuildContextResolver(context), timer, cleared, requested };
}

describe("AndroidBuildContextResolver", () => {
  test("ensure clears stale context and defers resolution to a macrotask, once per app", () => {
    const { resolver, timer, cleared, requested } = harness();
    resolver.ensure("com.app");
    resolver.ensure("com.app");
    expect(cleared).toEqual(["com.app", "com.app"]);
    expect(requested).toEqual([]);
    expect(resolver.knownApps()).toEqual(["com.app"]);
    timer.advanceTime(0);
    expect(requested).toEqual(["com.app"]);
  });

  test("a closed client never starts deferred device work", async () => {
    const { resolver, timer, requested } = harness({ closed: true });
    resolver.ensure("com.app");
    timer.advanceTime(0);
    await Promise.resolve();
    expect(requested).toEqual([]);
  });

  test("invalidate clears the manager's context for the app", () => {
    const { resolver, cleared } = harness();
    resolver.invalidate("com.app");
    expect(cleared).toEqual(["com.app"]);
  });

  test("records the app-declared git branch and sha with the build context (#16954)", async () => {
    const applied = await resolveWith(
      resolvedPackageInfo({ gitBranch: "feature/login", gitSha: "ABCDEF1234567" }),
    );
    expect(applied).toEqual([
      {
        appId: "com.app",
        deviceId: "emu",
        versionCode: 7,
        contentHash: "hash-1",
        sourceRevision: { gitBranch: "feature/login", gitSha: "abcdef1234567" },
      },
    ]);
  });

  test("builds without declared or with malformed git keys keep the plain build key", async () => {
    for (const info of [
      resolvedPackageInfo(),
      resolvedPackageInfo({ gitBranch: "main" }),
      resolvedPackageInfo({ gitBranch: "main", gitSha: "not-a-sha" }),
    ]) {
      expect(await resolveWith(info)).toEqual([
        { appId: "com.app", deviceId: "emu", versionCode: 7, contentHash: "hash-1" },
      ]);
    }
  });
});
