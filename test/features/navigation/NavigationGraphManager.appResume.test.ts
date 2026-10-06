import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { NavigationRepository } from "../../../src/db/navigationRepository";
import { TestCoverageRepository } from "../../../src/db/testCoverageRepository";
import { NavigationGraphManager } from "../../../src/features/navigation/NavigationGraphManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";

const APP = "com.example.resume";
const LAUNCHER = "com.example.launcher";
const T0 = 1_000_000;

/**
 * An SDK app that returns to the foreground on the screen it was left on sends no navigation
 * event, so the manager must remember the screen per app (#10193).
 */
describe("NavigationGraphManager app resume (#10193)", () => {
  let harness: InMemoryNavManagerHarness;
  let repository: NavigationRepository;
  let manager: NavigationGraphManager;
  let timer: FakeTimer;

  beforeAll(async () => {
    harness = await installInMemoryNavManager();
  });
  beforeEach(async () => {
    repository = new NavigationRepository(harness.db);
    await repository.clearAppGraph(APP);
    await repository.clearAppGraph(LAUNCHER);
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

  async function sdkEvent(destination: string, at: number): Promise<void> {
    timer.setCurrentTime(at);
    await manager.recordNavigationEvent({
      applicationId: APP,
      destination,
      source: "sdk",
      arguments: {},
      metadata: {},
      timestamp: at,
      sequenceNumber: 0,
    });
  }

  async function launcherInFront(at: number): Promise<void> {
    timer.setCurrentTime(at);
    await manager.recordHierarchyNavigation({
      packageName: LAUNCHER,
      fromFingerprint: null,
      toFingerprint: "launcher-hash",
      timestamp: at,
    });
  }

  async function edges() {
    return (await repository.getEdges(APP)).map((e) => [e.from_screen, e.to_screen, e.tool_name]);
  }

  async function homeThenLauncher(): Promise<void> {
    await sdkEvent("Home", T0);
    await launcherInFront(T0 + 5000);
    expect(manager.getCurrentScreen()).toBeNull();
  }

  test("the next transition after a warm return is stored as an edge from the remembered screen", async () => {
    await homeThenLauncher();

    // Warm return: the SDK app is in front again and sends no navigation event.
    timer.setCurrentTime(T0 + 8000);
    await manager.recordAppForeground(APP);
    expect(manager.getCurrentAppId()).toBe(APP);
    expect(manager.getCurrentScreen()).toBe("Home");

    timer.setCurrentTime(T0 + 9000);
    manager.recordToolCall("tapOn", { selector: { text: "Settings" } });
    await sdkEvent("Settings", T0 + 9300);

    expect(await edges()).toEqual([["Home", "Settings", "tapOn"]]);
  });

  test("a screen change delivered before any foreground signal still stores the edge", async () => {
    await homeThenLauncher();

    await sdkEvent("Settings", T0 + 9300);

    expect((await edges()).map(([from, to]) => [from, to])).toEqual([["Home", "Settings"]]);
  });

  test("a tool call from before the app switch cannot label the first edge after it", async () => {
    await sdkEvent("Home", T0);
    timer.setCurrentTime(T0 + 4900);
    manager.recordToolCall("pressButton", { button: "home" });
    await launcherInFront(T0 + 5000);

    // Returns and navigates within the 2 s window of the stale call.
    await sdkEvent("Settings", T0 + 6000);

    expect(await edges()).toEqual([["Home", "Settings", null]]);
    expect((await manager.getStats()).toolCallHistorySize).toBe(0);
  });

  test("an unconsumed tool call no longer labels the transition after the one it caused", async () => {
    await homeThenLauncher();
    timer.setCurrentTime(T0 + 8000);
    await manager.recordAppForeground(APP);

    timer.setCurrentTime(T0 + 9000);
    manager.recordToolCall("tapOn", { selector: { text: "Settings" } });
    await sdkEvent("Settings", T0 + 9300);
    await sdkEvent("Details", T0 + 9600);

    expect(await edges()).toEqual([
      ["Home", "Settings", "tapOn"],
      ["Settings", "Details", null],
    ]);
  });

  test("an app that has never been seen resumes on an unknown screen", async () => {
    await manager.recordAppForeground(APP);

    expect(manager.getCurrentAppId()).toBe(APP);
    expect(manager.getCurrentScreen()).toBeNull();
  });

  test("a foreground signal for the app already in front changes nothing", async () => {
    await sdkEvent("Home", T0);

    await manager.recordAppForeground(APP);

    expect(manager.getCurrentScreen()).toBe("Home");
  });

  test("a queued app switch is not hidden by a foreground signal for the app still current", async () => {
    await sdkEvent("Home", T0);

    // The launcher switch is queued but has not landed when the SDK app signals.
    const switching = launcherInFront(T0 + 5000);
    const returning = manager.recordAppForeground(APP);
    await Promise.all([switching, returning]);

    expect(manager.getCurrentAppId()).toBe(APP);
    expect(manager.getCurrentScreen()).toBe("Home");
  });

  test("a hierarchy return with an unproven fingerprint leaves the screen unknown", async () => {
    await homeThenLauncher();

    timer.setCurrentTime(T0 + 8000);
    await manager.recordHierarchyNavigation({
      packageName: APP,
      fromFingerprint: null,
      toFingerprint: "never-correlated",
      timestamp: T0 + 8000,
    });

    expect(manager.getCurrentAppId()).toBe(APP);
    expect(manager.getCurrentScreen()).toBeNull();
  });

  test("forgetting the app's screen stores no edge for the fresh process", async () => {
    await homeThenLauncher();
    manager.forgetAppScreen(APP);

    await manager.recordAppForeground(APP);
    expect(manager.getCurrentScreen()).toBeNull();
    await sdkEvent("Settings", T0 + 9300);

    expect(await edges()).toEqual([]);
  });

  test("forgetting the current app drops its screen so a restarted process stores no edge", async () => {
    await sdkEvent("Home", T0);

    manager.forgetAppScreen(APP);
    await sdkEvent("Settings", T0 + 1000);

    expect(await edges()).toEqual([]);
  });

  test("clearing the app's graph drops the remembered screen", async () => {
    await sdkEvent("Home", T0);
    await manager.clearCurrentGraph();
    await launcherInFront(T0 + 5000);

    await manager.recordAppForeground(APP);
    await sdkEvent("Settings", T0 + 9300);

    expect(await edges()).toEqual([]);
  });

  test("clearing all graphs forgets every remembered screen", async () => {
    await homeThenLauncher();
    await manager.clearAllGraphs();

    await manager.recordAppForeground(APP);

    expect(manager.getCurrentScreen()).toBeNull();
  });
});
