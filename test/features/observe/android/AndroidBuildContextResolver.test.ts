import { describe, expect, test } from "bun:test";
import {
  AndroidBuildContextResolver,
  type AndroidBuildContextContext,
} from "../../../../src/features/observe/android/AndroidBuildContextResolver";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

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
});
