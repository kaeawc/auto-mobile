import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { NavigationGraphStreamBridge } from "../../src/daemon/daemonStreamRouting";
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
    return new NavigationGraphManager(new NavigationRepository(harness.db), {
      testCoverageRepository: new TestCoverageRepository(harness.db),
      timer: new FakeTimer(),
    });
  }
  function wiring() {
    // Exercise only the stream bridge, without constructing/starting a resident daemon.
    const server = new DeviceDataStreamSocketServer("/fake/build-context.sock", new FakeTimer());
    const current = { server };
    const bridge = new NavigationGraphStreamBridge({
      server: () => current.server,
      sessionIds: () => [],
      defaultManager: () => manager(),
      managerForSession: () => manager(),
    });
    const daemon = {
      current,
      listenerManagers: bridge.listenerManagers,
      attach: (m: NavigationGraphManager) => bridge.attach(m),
    };
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
    daemon.attach(first);
    daemon.attach(second);
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
    daemon.listenerManagers.delete(second);
    second.clearBuildContext(b.appId);
    expect(push).toHaveBeenCalledTimes(4);
    push.mockRestore();
  });

  test("existing contexts seed each server/manager pair once, including replacement streams", () => {
    const { daemon, push } = wiring();
    const first = manager();
    first.setBuildContext(a);
    daemon.attach(first);
    daemon.attach(first);
    expect(push).toHaveBeenCalledTimes(1);
    const replacement = new DeviceDataStreamSocketServer("/fake/replacement.sock", new FakeTimer());
    const replacementPush = spyOn(replacement, "pushBuildContextUpdate").mockImplementation(
      () => {},
    );
    daemon.current.server = replacement;
    daemon.attach(first);
    daemon.attach(first);
    expect(replacementPush).toHaveBeenCalledTimes(1);
    expect(replacementPush).toHaveBeenCalledWith(a.deviceId, a.appId, {
      packageId: a.appId,
      versionCode: 1,
      contentHash: "hash-a",
    });
    // A different manager paired with the same server must seed independently.
    const second = manager();
    second.setBuildContext(b);
    daemon.attach(second);
    daemon.attach(second);
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
    daemon.attach(first);
    first.setBuildContext({ ...a, deviceId: "legacy", contentHash: "updated" });
    first.clearBuildContext(a.appId);
    expect(push).not.toHaveBeenCalled();
    push.mockRestore();
  });
});
