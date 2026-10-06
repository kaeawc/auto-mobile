import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DisplayTransitionTracker } from "../../../src/features/observe/DisplayTransition";
import { CachingDisplayInventoryProvider } from "../../../src/devices/DisplayInventoryProvider";
import { readAndroidDeviceDisplaysChecked } from "../../../src/utils/android-cmdline-tools/AndroidDisplayInventory";
import { displayInventoryOutcome } from "../../../src/models/DeviceInfo";
import {
  readableDisplayInventory,
  resolveTargetDisplay,
} from "../../../src/features/observe/DisplaySelection";
import { PinnedDisplayUnavailableError } from "../../../src/models/PinnedDisplayError";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

// Captured adb output: the same device before (phone-*) and after (fold-*) a second
// physical display is connected, as the inventory sees it.
const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../../fixtures/android-display", name), "utf8");

class FixtureAdbSource {
  reads = 0;
  private prefix: "phone" | "fold" = "phone";
  connectSecondPanel(): void {
    this.prefix = "fold";
  }
  disconnectSecondPanel(): void {
    this.prefix = "phone";
  }
  async read(): ReturnType<typeof readAndroidDeviceDisplaysChecked> {
    this.reads++;
    const adb = new FakeAdbExecutor();
    const names =
      this.prefix === "phone"
        ? ["phone-surfaceflinger.txt", "phone-display-device-info.txt", "phone-states.txt"]
        : ["fold-surfaceflinger.txt", "fold-open-display-device-info.txt", "fold-states.txt"];
    adb.setCommandResponse(
      "dumpsys SurfaceFlinger --display-id",
      createExecResult(fixture(names[0]), ""),
    );
    adb.setCommandResponse("dumpsys display", createExecResult(fixture(names[1]), ""));
    adb.setCommandResponse(
      "cmd device_state print-states",
      createExecResult(fixture(names[2]), ""),
    );
    return readAndroidDeviceDisplaysChecked(adb);
  }
}

const device: BootedDevice = { deviceId: "emulator-5554", name: "Phone", platform: "android" };
const otherDevice: BootedDevice = { deviceId: "emulator-5556", name: "Other", platform: "android" };

function setup() {
  const source = new FixtureAdbSource();
  const provider = new CachingDisplayInventoryProvider(source, source, new FakeTimer());
  const tracker = new DisplayTransitionTracker(
    () => {},
    (deviceId) => provider.invalidate(deviceId),
  );
  return { source, provider, tracker };
}

describe("display inventory follows pushed display transitions (#10105)", () => {
  test("a secondary display added after the first read is offered on the next call", async () => {
    const { source, provider, tracker } = setup();
    const before = await provider.hydrate(device, "1:avd");
    expect(before.displays).toBeUndefined();
    expect(before[displayInventoryOutcome]).toEqual({ kind: "single" });
    expect(source.reads).toBe(1);

    // Without an event the clean single read is served from cache with no retry.
    await provider.hydrate(device, "1:avd");
    expect(source.reads).toBe(1);

    source.connectSecondPanel();
    tracker.notifyAndroidTransition(device.deviceId, { change: "added", displayId: 2 });

    const after = await provider.hydrate(device, "1:avd");
    expect(source.reads).toBe(2);
    expect(after.displays?.panels.map((panel) => panel.key).length).toBeGreaterThan(1);
  });

  test("a removed secondary display leaves the inventory on the next call", async () => {
    const { source, provider, tracker } = setup();
    source.connectSecondPanel();
    const before = await provider.hydrate(device, "1:avd");
    expect(before.displays?.panels.length).toBeGreaterThan(1);

    source.disconnectSecondPanel();
    tracker.notifyAndroidTransition(device.deviceId, { change: "removed", displayId: 2 });

    const after = await provider.hydrate(device, "1:avd");
    expect(after.displays).toBeUndefined();
    expect(source.reads).toBe(2);
  });

  test("a changed secondary display re-reads without bumping the default panel's generation", async () => {
    const { source, provider, tracker } = setup();
    await provider.hydrate(device, "1:avd");
    const revision = tracker.revision(device.deviceId);

    tracker.notifyAndroidTransition(device.deviceId, { change: "changed", displayId: 2 });

    expect(tracker.revision(device.deviceId)).toBe(revision);
    await provider.hydrate(device, "1:avd");
    expect(source.reads).toBe(2);
  });

  test("a display-0 added or removed event invalidates even when it reconciles a pending push", async () => {
    const { source, provider, tracker } = setup();
    await provider.hydrate(device, "1:avd");
    tracker.notifyAndroidTransition(device.deviceId, { change: "added", displayId: 0 });
    await provider.hydrate(device, "1:avd");
    expect(source.reads).toBe(2);
    tracker.notifyAndroidTransition(device.deviceId, { change: "removed", displayId: 0 });
    await provider.hydrate(device, "1:avd");
    expect(source.reads).toBe(3);
  });

  test("a posture (device state) transition re-reads the inventory", async () => {
    const { source, provider, tracker } = setup();
    await provider.hydrate(device, "1:avd");
    tracker.notifyAndroidTransition(device.deviceId, {
      change: "device_state",
      displayId: 0,
      deviceState: 1,
    });
    await provider.hydrate(device, "1:avd");
    expect(source.reads).toBe(2);
  });

  test("an observed posture or panel transition re-reads the inventory", async () => {
    const { source, provider, tracker } = setup();
    await provider.hydrate(device, "1:avd");
    tracker.notifyTransition(device.deviceId, "display key, role, or posture changed");
    await provider.hydrate(device, "1:avd");
    expect(source.reads).toBe(2);
  });

  test("a rotation-only change of the default display keeps the cached inventory", async () => {
    const { source, provider, tracker } = setup();
    await provider.hydrate(device, "1:avd");
    tracker.record(device.deviceId, {
      display: { key: "inner", role: "inner", posture: "opened", generation: 1 },
      screenSize: { width: 100, height: 200 },
    });
    tracker.notifyAndroidTransition(device.deviceId, {
      change: "changed",
      displayId: 0,
      panelUniqueId: "local:inner",
      width: 200,
      height: 100,
    });
    await provider.hydrate(device, "1:avd");
    expect(source.reads).toBe(1);
  });

  test("an event only invalidates the device it names", async () => {
    const { source, provider, tracker } = setup();
    await provider.hydrate(device, "1:avd");
    await provider.hydrate(otherDevice, "1:avd");
    expect(source.reads).toBe(2);

    tracker.notifyAndroidTransition(device.deviceId, { change: "added", displayId: 2 });

    await provider.hydrate(otherDevice, "1:avd");
    expect(source.reads).toBe(2);
    await provider.hydrate(device, "1:avd");
    expect(source.reads).toBe(3);
  });

  test("a pin whose display was unplugged gets the stale-display error, never display 0", async () => {
    const { source, provider, tracker } = setup();
    source.connectSecondPanel();
    const connected = await provider.hydrate(device, "1:avd");
    const pinned = connected.displays?.panels.find((panel) => panel.role === "inner")?.key;
    const pin = connected.displays?.panels.find((panel) => panel.role === "cover")?.key;
    expect(pinned).toBeDefined();
    expect(pin).toBeDefined();
    expect(resolveTargetDisplay(connected.displays, undefined, { displayPin: pin }).key).toBe(pin!);

    source.disconnectSecondPanel();
    tracker.notifyAndroidTransition(device.deviceId, { change: "removed", displayId: 2 });
    const after = await provider.hydrate(device, "1:avd");

    // The pinned-session path (runPinnedSessionDisplay) resolves through the outcome-aware
    // inventory, so a proven single panel yields the pin error rather than panel "0".
    const inventory = readableDisplayInventory({
      inventory: after.displays,
      outcome: after[displayInventoryOutcome],
      pin,
    });
    expect(() => resolveTargetDisplay(inventory, undefined, { displayPin: pin })).toThrow(
      PinnedDisplayUnavailableError,
    );
  });
});
