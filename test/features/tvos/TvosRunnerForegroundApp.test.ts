import { describe, expect, test } from "bun:test";
import { WatchAppManager } from "../../../src/features/action/watch/WatchAppManager";
import { WebSocketTvosRunnerClient } from "../../../src/features/tvos/TvosRunnerClient";
import { TvosRunnerDisconnectedError } from "../../../src/features/tvos/TvosRunnerDisconnectedError";
import { TvosRunnerTimeoutError } from "../../../src/features/tvos/TvosRunnerTimeoutError";
import { connectTvosRunnerClient } from "../../../src/features/tvos/TvosRunnerLauncher";
import { tvosTargetApps } from "../../../src/features/tvos/TvosTargetApps";
import { InMemoryVisionosTargetApps } from "../../../src/features/visionos/VisionosTargetApps";
import type { BootedDevice } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWatchAppsSimctl, FakeWatchBundleIds } from "../../fakes/FakeWatchApps";
import { FakeWatchSocket } from "../../fakes/FakeWatchSocket";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import connected from "../../fixtures/tvos-xcuitest/tvos-runner-connected.json";
import b01 from "../../fixtures/tvos-xcuitest/tvos-runner-hierarchy-focus-b01.json";

// The daemon names the app it launched on tvOS runner hierarchy and text requests, so a
// third-party app in front is read instead of the home screen, and a runner that stops answering
// fails fast (#17310).

const DEVICE = "tvos-foreground-hint";
const APP = "com.example.tvshow";

function fixture(foregroundApp?: () => string | undefined) {
  const socket = new FakeWatchSocket();
  const timer = new FakeTimer();
  const client = new WebSocketTvosRunnerClient("ws://fake/ws", {
    factory: () => socket,
    timer,
    foregroundApp,
  });
  socket.receive(connected);
  return { socket, timer, client };
}

const settle = <T>(promise: Promise<T>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("tvOS runner foreground-app hint", () => {
  test("names the launched app on hierarchy and text requests only", async () => {
    const { socket, client } = fixture(() => APP);
    const hierarchy = client.hierarchy();
    await drainMicrotasks(2);
    socket.receive({ ...b01, requestId: socket.sent[0].requestId });
    await hierarchy;
    void settle(client.request({ type: "request_append_text", text: "hi" }));
    void settle(client.request({ type: "request_press_button", action: "down" }));
    void settle(client.request({ type: "request_screenshot" }));
    await drainMicrotasks(2);
    expect(socket.sent.map(({ type, bundleId }) => ({ type, bundleId }))).toEqual([
      { type: "request_hierarchy", bundleId: APP },
      { type: "request_append_text", bundleId: APP },
      { type: "request_press_button", bundleId: undefined },
      { type: "request_screenshot", bundleId: undefined },
    ]);
    client.close();
  });

  test("sends no bundleId when no app was launched, and a caller's own bundleId wins", async () => {
    const targetApps = new InMemoryVisionosTargetApps();
    const { socket, client } = fixture(() => targetApps.get(DEVICE));
    void settle(client.request({ type: "request_hierarchy" }));
    targetApps.launched(DEVICE, APP);
    void settle(client.request({ type: "request_hierarchy", bundleId: "com.apple.TVSettings" }));
    await drainMicrotasks(2);
    expect(Object.hasOwn(socket.sent[0], "bundleId")).toBe(false);
    expect(socket.sent[1].bundleId).toBe("com.apple.TVSettings");
    client.close();
  });

  test("the launcher's client reads the device's current target app per request", async () => {
    const socket = new FakeWatchSocket();
    const targetApps = new InMemoryVisionosTargetApps();
    const client = connectTvosRunnerClient("ws://fake/ws", DEVICE, {
      timer: new FakeTimer(),
      factory: () => socket,
      targetApps,
    });
    socket.receive(connected);
    targetApps.launched("another-device", "com.example.other");
    void settle(client.request({ type: "request_hierarchy" }));
    targetApps.launched(DEVICE, APP);
    void settle(client.request({ type: "request_hierarchy" }));
    await drainMicrotasks(2);
    expect(socket.sent.map((sent) => sent.bundleId)).toEqual([undefined, APP]);
    client.close();
  });

  test("launchApp on an Apple TV records the target app and terminateApp clears it", async () => {
    const device: BootedDevice = { name: "Apple TV 4K", deviceId: DEVICE, platform: "tvos" };
    const appPath = "/build/Debug-appletvsimulator/Show.app";
    const plist = new FakeWatchBundleIds();
    plist.byPath.set(appPath, APP);
    const manager = new WatchAppManager(device, {
      simctl: new FakeWatchAppsSimctl(plist),
      plist,
    });
    await manager.install(appPath);
    try {
      await manager.launch(APP, { clearAppData: false, coldBoot: false });
      expect(tvosTargetApps.get(DEVICE)).toBe(APP);
      await manager.terminate(APP);
      expect(tvosTargetApps.get(DEVICE)).toBeUndefined();
    } finally {
      tvosTargetApps.terminated(DEVICE, APP);
    }
  });
});

describe("tvOS runner command deadline", () => {
  test("a command the runner never answers fails actionably and disconnects the runner", async () => {
    const { socket, timer, client } = fixture();
    const stuck = settle(client.hierarchy());
    await drainMicrotasks(2);
    expect(socket.sent).toHaveLength(1);
    timer.advanceTime(5000);
    const error = await stuck;
    expect(error).toBeInstanceOf(TvosRunnerTimeoutError);
    expect(String(error)).toContain("did not answer request_hierarchy within 5000ms");
    expect(String(error)).toContain("Call startDevice to restart the runner");
    expect(client.isUsable()).toBe(false);
    expect(socket.closed).toBe(true);

    // Later calls fail at once, naming themselves, instead of queueing behind the stuck one.
    const next = await settle(client.request({ type: "request_press_button", action: "down" }));
    expect(next).toBeInstanceOf(TvosRunnerDisconnectedError);
    expect(String(next)).toContain("request_press_button was not sent");
    expect(socket.sent).toHaveLength(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a late answer to a timed-out command is ignored", async () => {
    const { socket, timer, client } = fixture();
    const stuck = settle(client.hierarchy());
    await drainMicrotasks(2);
    timer.advanceTime(5000);
    await stuck;
    socket.receive({ ...b01, requestId: socket.sent[0].requestId });
    expect(client.isUsable()).toBe(false);
  });

  test("a missed handshake keeps the client usable so startup can retry", async () => {
    const socket = new FakeWatchSocket();
    const timer = new FakeTimer();
    const client = new WebSocketTvosRunnerClient("ws://fake/ws", { factory: () => socket, timer });
    const failed = settle(client.hierarchy());
    timer.advanceTime(5000);
    const error = await failed;
    expect(error).not.toBeInstanceOf(TvosRunnerTimeoutError);
    expect(String(error)).toContain("timed out");
    expect(client.isUsable()).toBe(true);
    expect(socket.closed).toBe(false);
    client.close();
  });
});
