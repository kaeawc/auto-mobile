import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DeviceDataStreamSocketServer } from "../../src/daemon/deviceDataStreamSocketServer";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import { NavigationRepository } from "../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../src/db/testCoverageRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../helpers/navigationTestHarness";

describe("daemon build-context stream wiring", () => {
  let harness: InMemoryNavManagerHarness;
  beforeAll(async () => {
    harness = await installInMemoryNavManager();
  });
  afterAll(async () => {
    await harness.dispose();
  });
  function manager(): NavigationGraphManager {
    return new NavigationGraphManager(
      new NavigationRepository(harness.db),
      new TestCoverageRepository(undefined, harness.db),
      new FakeTimer(),
    );
  }
  function wiring() {
    // Exercise only the wiring method, without constructing/starting a resident daemon.
    const daemon: Daemon = Object.create(Daemon.prototype);
    daemon["navigationGraphListenerManagers"] = new WeakSet();
    daemon["navigationGraphSeededStreamManagers"] = new WeakMap();
    const server = new DeviceDataStreamSocketServer("/fake/build-context.sock", new FakeTimer());
    daemon["deviceDataStreamServer"] = server;
    const push = spyOn(server, "pushBuildContextUpdate").mockImplementation(() => {});
    return { daemon, server, push };
  }
  const a = { appId: "app.a", deviceId: "device-a", versionCode: 1, contentHash: "hash-a" };
  const b = {
    appId: "app.b",
    deviceId: "device-b",
    versionCode: 0,
    versionKey: "1.2.3",
    contentHash: "hash-b",
  };

  test("every wired manager forwards set/change/clear, suppresses identical sets and ignores released managers", () => {
    const { daemon, push } = wiring();
    const first = manager();
    const second = manager();
    daemon["setupNavigationGraphUpdateListener"](first);
    daemon["setupNavigationGraphUpdateListener"](second);
    first.setBuildContext(a);
    first.setBuildContext({ ...a });
    second.setBuildContext(b);
    first.setBuildContext({ ...a, contentHash: "reinstalled" });
    first.clearBuildContext(a.appId);
    first.clearBuildContext(a.appId);
    expect(push.mock.calls).toEqual([
      [a.deviceId, a.appId, { packageId: a.appId, versionCode: 1, contentHash: "hash-a" }],
      [
        b.deviceId,
        b.appId,
        { packageId: b.appId, versionCode: 0, versionKey: "1.2.3", contentHash: "hash-b" },
      ],
      [a.deviceId, a.appId, { packageId: a.appId, versionCode: 1, contentHash: "reinstalled" }],
      [a.deviceId, a.appId, null],
    ]);
    daemon["navigationGraphListenerManagers"].delete(second);
    second.clearBuildContext(b.appId);
    expect(push).toHaveBeenCalledTimes(4);
    push.mockRestore();
  });

  test("existing contexts seed each server/manager pair once, including replacement streams", () => {
    const { daemon, push } = wiring();
    const first = manager();
    first.setBuildContext(a);
    daemon["setupNavigationGraphUpdateListener"](first);
    daemon["setupNavigationGraphUpdateListener"](first);
    expect(push).toHaveBeenCalledTimes(1);
    const replacement = new DeviceDataStreamSocketServer("/fake/replacement.sock", new FakeTimer());
    const replacementPush = spyOn(replacement, "pushBuildContextUpdate").mockImplementation(
      () => {},
    );
    daemon["deviceDataStreamServer"] = replacement;
    daemon["setupNavigationGraphUpdateListener"](first);
    daemon["setupNavigationGraphUpdateListener"](first);
    expect(replacementPush).toHaveBeenCalledTimes(1);
    expect(replacementPush).toHaveBeenCalledWith(a.deviceId, a.appId, {
      packageId: a.appId,
      versionCode: 1,
      contentHash: "hash-a",
    });
    // A different manager paired with the same server must seed independently.
    const second = manager();
    second.setBuildContext(b);
    daemon["setupNavigationGraphUpdateListener"](second);
    daemon["setupNavigationGraphUpdateListener"](second);
    expect(replacementPush).toHaveBeenCalledTimes(2);
    expect(replacementPush).toHaveBeenLastCalledWith(b.deviceId, b.appId, {
      packageId: b.appId,
      versionCode: 0,
      versionKey: "1.2.3",
      contentHash: "hash-b",
    });
    replacementPush.mockRestore();
    push.mockRestore();
  });
  test("legacy device contexts emit no frame when seeded, updated or cleared", () => {
    const { daemon, push } = wiring();
    const first = manager();
    first.setBuildContext({ ...a, deviceId: "legacy" });
    daemon["setupNavigationGraphUpdateListener"](first);
    first.setBuildContext({ ...a, deviceId: "legacy", contentHash: "updated" });
    first.clearBuildContext(a.appId);
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });
});
