import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  NavigationGraphManager,
  type NavigationBuildContext,
} from "../../../src/features/navigation/NavigationGraphManager";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

describe("navigation build-context changes", () => {
  let harness: InMemoryNavManagerHarness;
  beforeAll(async () => {
    harness = await installInMemoryNavManager();
  });
  afterAll(async () => {
    await harness.dispose();
  });

  test("set, change and clear notify once; identical sets and absent clears do nothing", () => {
    const manager = new NavigationGraphManager(
      new NavigationRepository(harness.db),
      new TestCoverageRepository(undefined, harness.db),
      new FakeTimer(),
    );
    const changes: Array<{
      appId: string;
      deviceId: string;
      buildContext: NavigationBuildContext | null;
    }> = [];
    manager.setBuildContextUpdateListener((change) => changes.push(change));
    const context = {
      appId: "app",
      deviceId: "device-a",
      versionCode: 0,
      versionKey: "1.2.3",
      contentHash: "hash",
    };
    manager.setBuildContext(context);
    manager.setBuildContext({ ...context });
    manager.setBuildContext({ ...context, versionKey: "1.2.4" });
    manager.clearBuildContext("app");
    manager.clearBuildContext("app");
    expect(changes).toEqual([
      { appId: "app", deviceId: "device-a", buildContext: context },
      { appId: "app", deviceId: "device-a", buildContext: { ...context, versionKey: "1.2.4" } },
      { appId: "app", deviceId: "device-a", buildContext: null },
    ]);
    expect(manager.getDeviceIdForApp("app")).toBeNull();
  });

  test("changing device attribution publishes only that device's new context", () => {
    const manager = new NavigationGraphManager(
      new NavigationRepository(harness.db),
      new TestCoverageRepository(undefined, harness.db),
      new FakeTimer(),
    );
    const context = { appId: "app", deviceId: "device-a", versionCode: 1, contentHash: "hash" };
    manager.setBuildContext(context);
    const changes: Array<{ deviceId: string; buildContext: NavigationBuildContext | null }> = [];
    manager.setBuildContextUpdateListener((change) => changes.push(change));
    manager.setBuildContext({ ...context, deviceId: "device-b" });
    expect(changes).toEqual([
      { appId: "app", deviceId: "device-b", buildContext: { ...context, deviceId: "device-b" } },
    ]);
  });
});
