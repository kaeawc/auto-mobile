import { afterEach, describe, expect, test } from "bun:test";
import { WatchAppManager } from "../../../src/features/action/watch/WatchAppManager";
import {
  VisionosRunnerLifecycle,
  requireVisionosRunner,
} from "../../../src/features/visionos/VisionosRunnerLifecycle";
import { InMemoryVisionosTargetApps } from "../../../src/features/visionos/VisionosTargetApps";
import type { BootedDevice } from "../../../src/models";
import { FakeVisionosRunnerLauncher } from "../../fakes/FakeVisionosRunnerLauncher";
import { FakeWatchAppsSimctl, FakeWatchBundleIds } from "../../fakes/FakeWatchApps";

const DEVICE = "vision-target-apps";
const A = "com.example.a";
const B = "com.example.b";

describe("InMemoryVisionosTargetApps", () => {
  test("remembers the last launch per device and forgets only the terminated target", () => {
    const apps = new InMemoryVisionosTargetApps();
    expect(apps.get(DEVICE)).toBeUndefined();
    apps.launched(DEVICE, A);
    apps.launched(DEVICE, B);
    expect(apps.get(DEVICE)).toBe(B);
    expect(apps.get("other")).toBeUndefined();
    apps.terminated(DEVICE, A);
    expect(apps.get(DEVICE)).toBe(B);
    apps.terminated(DEVICE, B);
    expect(apps.get(DEVICE)).toBeUndefined();
  });
});

describe("WatchAppManager target app", () => {
  const APP_PATH = "/build/Debug-xrsimulator/Demo.app";
  async function arrange(platform: BootedDevice["platform"]) {
    const device: BootedDevice = { name: "Vision", deviceId: DEVICE, platform };
    const plist = new FakeWatchBundleIds();
    plist.byPath.set(APP_PATH, A);
    const simctl = new FakeWatchAppsSimctl(plist);
    const targetApps = new InMemoryVisionosTargetApps();
    const manager = new WatchAppManager(device, { simctl, plist, targetApps });
    await manager.install(APP_PATH);
    return { manager, targetApps, simctl };
  }
  const LAUNCH = { clearAppData: false, coldBoot: false };

  test("a visionOS launch records the app and a terminate clears it", async () => {
    const { manager, targetApps } = await arrange("visionos");
    await manager.launch(A, LAUNCH);
    expect(targetApps.get(DEVICE)).toBe(A);
    await manager.terminate(A);
    expect(targetApps.get(DEVICE)).toBeUndefined();
  });

  test("a terminate of an app that already exited clears the target", async () => {
    const { manager, targetApps, simctl } = await arrange("visionos");
    await manager.launch(A, LAUNCH);
    // The app exits on its own, so simctl finds nothing to terminate.
    await simctl.terminateApp(A, DEVICE);
    const result = await manager.terminate(A);
    expect(result).toMatchObject({ success: true, wasRunning: false });
    expect(targetApps.get(DEVICE)).toBeUndefined();
  });

  test("a terminate of an app no longer installed clears the target", async () => {
    const { manager, targetApps, simctl } = await arrange("visionos");
    await manager.launch(A, LAUNCH);
    await simctl.uninstallApp(A, DEVICE);
    const result = await manager.terminate(A);
    expect(result).toMatchObject({ success: true, wasInstalled: false });
    expect(targetApps.get(DEVICE)).toBeUndefined();
  });

  test("a failed terminate keeps the target", async () => {
    const { manager, targetApps, simctl } = await arrange("visionos");
    await manager.launch(A, LAUNCH);
    simctl.terminateError = new Error("simctl terminate: device is busy");
    const result = await manager.terminate(A);
    expect(result.success).toBe(false);
    expect(targetApps.get(DEVICE)).toBe(A);
  });

  test("uninstalling the target clears it and uninstalling another app does not", async () => {
    const { manager, targetApps } = await arrange("visionos");
    await manager.launch(A, LAUNCH);
    await manager.uninstall(B);
    expect(targetApps.get(DEVICE)).toBe(A);
    await manager.uninstall(A);
    expect(targetApps.get(DEVICE)).toBeUndefined();
  });

  test("uninstalling a target that is already gone still clears it", async () => {
    const { manager, targetApps, simctl } = await arrange("visionos");
    await manager.launch(A, LAUNCH);
    await simctl.uninstallApp(A, DEVICE);
    const result = await manager.uninstall(A);
    expect(result).toMatchObject({ success: true, wasInstalled: false });
    expect(targetApps.get(DEVICE)).toBeUndefined();
  });

  test("a failed launch records nothing and a watch launch is not recorded", async () => {
    const visionos = await arrange("visionos");
    await visionos.manager.launch(B, LAUNCH);
    expect(visionos.targetApps.get(DEVICE)).toBeUndefined();
    const watch = await arrange("watchos");
    await watch.manager.launch(A, LAUNCH);
    expect(watch.targetApps.get(DEVICE)).toBeUndefined();
  });
});

describe("VisionosRunnerLifecycle target bundle id", () => {
  const owners: VisionosRunnerLifecycle[] = [];
  afterEach(() => {
    for (const owner of owners.splice(0)) {
      owner.stopAll();
    }
  });

  function fixture() {
    const targetApps = new InMemoryVisionosTargetApps();
    const launcher = new FakeVisionosRunnerLauncher();
    const owner = new VisionosRunnerLifecycle({
      launcher,
      artifacts: { resolve: async () => "/products/x.xctestrun" },
      targetBundleId: (deviceId) => targetApps.get(deviceId),
      ports: { allocate: () => 9011, release: () => {} },
    });
    owners.push(owner);
    return { owner, launcher, targetApps };
  }

  test("starts on the launched app and restarts when another app is launched", async () => {
    const { owner, launcher, targetApps } = fixture();
    targetApps.launched(DEVICE, A);
    await owner.start({ deviceId: DEVICE });
    expect(launcher.launches.map((launch) => launch.bundleId)).toEqual([A]);
    expect(owner.needsRestart(DEVICE)).toBe(false);

    targetApps.launched(DEVICE, B);
    expect(owner.needsRestart(DEVICE)).toBe(true);
    await owner.start({ deviceId: DEVICE });
    expect(launcher.launches.map((launch) => launch.bundleId)).toEqual([A, B]);
    expect(launcher.stops).toBe(1);
    expect(owner.needsRestart(DEVICE)).toBe(false);
  });

  test("with no known app the runner keeps its demo app and is not restarted", async () => {
    const { owner, launcher } = fixture();
    await owner.start({ deviceId: DEVICE });
    expect(launcher.launches.map((launch) => launch.bundleId)).toEqual([undefined]);
    expect(owner.needsRestart(DEVICE)).toBe(false);
  });

  test("terminating the target app restarts the runner on the fallback target", async () => {
    const { owner, launcher, targetApps } = fixture();
    targetApps.launched(DEVICE, A);
    await requireVisionosRunner(DEVICE, undefined, owner);
    expect(launcher.launches.map((launch) => launch.bundleId)).toEqual([A]);

    targetApps.terminated(DEVICE, A);
    expect(owner.needsRestart(DEVICE)).toBe(true);
    await requireVisionosRunner(DEVICE, undefined, owner);
    expect(launcher.launches.map((launch) => launch.bundleId)).toEqual([A, undefined]);
    expect(launcher.stops).toBe(1);
    expect(owner.needsRestart(DEVICE)).toBe(false);
  });
});
