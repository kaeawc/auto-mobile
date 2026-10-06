import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP_A = "com.example.device.a";
const APP_B = "com.example.device.b";
const DEVICE_1 = "emulator-5554";
const DEVICE_2 = "emulator-5556";
const T0 = 3_000_000;

/**
 * Two unbound devices share the global manager. Its current app follows the device whose SDK
 * event it last saw; a hierarchy tick from another device must not flip the app or retire the
 * tool calls the tracked device made (#10193 review).
 */
describe("NavigationGraphManager with two devices on one manager", () => {
  let harness: InMemoryNavManagerHarness;
  let repository: NavigationRepository;
  let manager: NavigationGraphManager;
  let timer: FakeTimer;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
  });
  beforeEach(async () => {
    repository = new NavigationRepository(harness.db);
    await repository.clearAppGraph(APP_A);
    await repository.clearAppGraph(APP_B);
    timer = new FakeTimer();
    timer.setCurrentTime(T0);
    manager = NavigationGraphManager.createForTesting(
      repository,
      new TestCoverageRepository(undefined, harness.db),
      timer,
    );
  });
  afterAll(async () => {
    await harness.dispose();
  });

  async function sdkEvent(
    appId: string,
    deviceId: string,
    destination: string,
    at: number,
  ): Promise<void> {
    timer.setCurrentTime(at);
    await manager.recordNavigationEvent({
      applicationId: appId,
      destination,
      source: "sdk",
      arguments: {},
      metadata: {},
      timestamp: at,
      sequenceNumber: 0,
      deviceId,
    });
  }

  async function edges(appId: string) {
    return (await repository.getEdges(appId)).map((e) => [e.from_screen, e.to_screen, e.tool_name]);
  }

  test("a foreground tick from the other device changes nothing and keeps the tracked device's tap", async () => {
    await sdkEvent(APP_A, DEVICE_1, "Home", T0);
    timer.setCurrentTime(T0 + 1000);
    manager.recordToolCall("tapOn", { selector: { text: "Settings" } }, undefined, DEVICE_1);

    // Device 2 shows SDK app B and ticks on every hierarchy update.
    timer.setCurrentTime(T0 + 1100);
    await manager.recordAppForeground(APP_B, DEVICE_2);
    timer.setCurrentTime(T0 + 1200);
    await manager.recordAppForeground(APP_B, DEVICE_2);

    expect(manager.getCurrentAppId()).toBe(APP_A);
    expect(manager.getCurrentScreen()).toBe("Home");
    expect((await manager.getStats()).toolCallHistorySize).toBe(1);

    await sdkEvent(APP_A, DEVICE_1, "Settings", T0 + 1300);
    expect(await edges(APP_A)).toEqual([["Home", "Settings", "tapOn"]]);
  });

  test("an SDK event from the other device follows it without retiring the first device's calls", async () => {
    await sdkEvent(APP_A, DEVICE_1, "Home", T0);
    timer.setCurrentTime(T0 + 1000);
    manager.recordToolCall("tapOn", { selector: { text: "Settings" } }, undefined, DEVICE_1);

    await sdkEvent(APP_B, DEVICE_2, "Feed", T0 + 1100);

    expect(manager.getCurrentAppId()).toBe(APP_B);
    expect((await manager.getStats()).toolCallHistorySize).toBe(1);
  });

  test("after following device 2, a foreground tick from device 1 changes nothing", async () => {
    await sdkEvent(APP_A, DEVICE_1, "Home", T0);
    await sdkEvent(APP_B, DEVICE_2, "Feed", T0 + 100);

    timer.setCurrentTime(T0 + 200);
    await manager.recordAppForeground(APP_A, DEVICE_1);

    expect(manager.getCurrentAppId()).toBe(APP_B);
    expect(manager.getCurrentScreen()).toBe("Feed");
  });

  test("a foreground signal queued behind the other device's event is ignored once it lands", async () => {
    await sdkEvent(APP_A, DEVICE_1, "Home", T0);

    timer.setCurrentTime(T0 + 100);
    const event = manager.recordNavigationEvent({
      applicationId: APP_B,
      destination: "Feed",
      source: "sdk",
      arguments: {},
      metadata: {},
      timestamp: T0 + 100,
      sequenceNumber: 0,
      deviceId: DEVICE_2,
    });
    const tick = manager.recordAppForeground(APP_A, DEVICE_1);
    await Promise.all([event, tick]);

    expect(manager.getCurrentAppId()).toBe(APP_B);
  });

  test("a real app switch on the tracked device retires only that device's earlier calls", async () => {
    await sdkEvent(APP_A, DEVICE_1, "Home", T0);
    timer.setCurrentTime(T0 + 500);
    manager.recordToolCall("pressButton", { button: "home" }, undefined, DEVICE_1);
    manager.recordToolCall("tapOn", { selector: { text: "Other" } }, undefined, DEVICE_2);

    timer.setCurrentTime(T0 + 600);
    await manager.recordAppForeground(APP_B, DEVICE_1);

    expect(manager.getCurrentAppId()).toBe(APP_B);
    expect((await manager.getStats()).toolCallHistorySize).toBe(1);
  });

  test("a signal that names no device behaves as before and retires every earlier call", async () => {
    await sdkEvent(APP_A, DEVICE_1, "Home", T0);
    timer.setCurrentTime(T0 + 500);
    manager.recordToolCall("pressButton", { button: "home" }, undefined, DEVICE_1);

    timer.setCurrentTime(T0 + 600);
    await manager.recordAppForeground(APP_B);

    expect(manager.getCurrentAppId()).toBe(APP_B);
    expect((await manager.getStats()).toolCallHistorySize).toBe(0);
  });
});
