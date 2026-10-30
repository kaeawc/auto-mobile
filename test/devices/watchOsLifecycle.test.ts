import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models";
import { WatchSimulatorInventory } from "../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import { WatchSimulatorLifecycle } from "../../src/utils/ios-cmdline-tools/WatchSimulatorLifecycle";
import { MultiPlatformDeviceManager } from "../../src/devices/deviceUtils";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { createFakeAndroidEmulator } from "../fakes/FakeAndroidEmulator";
import { FakeWatchLifecycleSimctl, IPHONE_UDID, watchDevice } from "../fakes/FakeWatchSimctl";
import { fakeDeviceManagerSimctl } from "../helpers/fakeDeviceManagerSimctl";

// Apple Watch simulators boot and shut down through their own lifecycle; targets resolve only from
// the watch listing, so nothing else is ever booted or stopped as a watch (#14908).

const WATCH_UDID = watchDevice().udid;

function lifecycleOver(simctl: FakeWatchLifecycleSimctl): WatchSimulatorLifecycle {
  return new WatchSimulatorLifecycle(simctl, new WatchSimulatorInventory(simctl, "arm64"));
}

async function refusal(operation: Promise<unknown>): Promise<string> {
  const error = await operation.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ActionableError);
  return error instanceof Error ? error.message : "";
}

describe("Apple Watch simulator lifecycle", () => {
  test("boots a shutdown watch and labels the result watchos", async () => {
    const simctl = new FakeWatchLifecycleSimctl();
    const lifecycle = lifecycleOver(simctl);

    const watch = await lifecycle.findWatch({ deviceId: WATCH_UDID });
    const result = await lifecycle.boot(watch, { timeoutMs: 30_000 });

    expect(result).toEqual({
      device: {
        name: "Apple Watch Series 10 (46mm)",
        platform: "watchos",
        deviceId: WATCH_UDID,
        observedAt: 7,
      },
      acquisition: "cold-boot",
    });
    expect(simctl.commands).toEqual([`boot ${WATCH_UDID} 30000`]);
    expect(simctl.stateOf(WATCH_UDID)).toBe("Booted");
  });

  test("adopts an already-booted watch without a boot command", async () => {
    const simctl = new FakeWatchLifecycleSimctl([watchDevice({ state: "Booted" })]);
    const lifecycle = lifecycleOver(simctl);

    const result = await lifecycle.boot(await lifecycle.findWatch({ name: watchDevice().name }));

    expect(result).toEqual({
      device: { name: "Apple Watch Series 10 (46mm)", platform: "watchos", deviceId: WATCH_UDID },
      acquisition: "already-booted",
    });
    expect(simctl.commands).toEqual([]);
  });

  test("refuses an iPhone UDID and names the available watches, before any command", async () => {
    const simctl = new FakeWatchLifecycleSimctl();

    const message = await refusal(lifecycleOver(simctl).findWatch({ deviceId: IPHONE_UDID }));

    expect(message).toContain(`No Apple Watch simulator matches UDID ${IPHONE_UDID}`);
    expect(message).toContain(`Apple Watch Series 10 (46mm) (${WATCH_UDID}, Shutdown)`);
    expect(simctl.commands).toEqual([]);
  });

  test("refuses an ambiguous name and a selector with neither id nor name", async () => {
    const simctl = new FakeWatchLifecycleSimctl([
      watchDevice(),
      watchDevice({ udid: "SECOND-WATCH" }),
    ]);
    const lifecycle = lifecycleOver(simctl);

    expect(await refusal(lifecycle.findWatch({ name: watchDevice().name }))).toContain(
      "is ambiguous; pass deviceId",
    );
    expect(await refusal(lifecycle.findWatch({}))).toContain("needs deviceId");
  });

  test("refuses an unavailable watch with its availability error", async () => {
    const simctl = new FakeWatchLifecycleSimctl([
      watchDevice({ isAvailable: false, availabilityError: "runtime profile not found" }),
    ]);

    expect(await refusal(lifecycleOver(simctl).findWatch({ deviceId: WATCH_UDID }))).toContain(
      "unavailable: runtime profile not found",
    );
  });

  test("shuts down a booted watch and skips one already shut down", async () => {
    const simctl = new FakeWatchLifecycleSimctl([watchDevice({ state: "Booted" })]);
    const lifecycle = lifecycleOver(simctl);
    const device = { name: watchDevice().name, platform: "watchos" as const, deviceId: WATCH_UDID };

    await lifecycle.shutdown(device);
    await lifecycle.shutdown(device);

    expect(simctl.commands).toEqual([`shutdown ${WATCH_UDID}`]);
    expect(simctl.stateOf(WATCH_UDID)).toBe("Shutdown");
  });

  test("never shuts down an iPhone through the watch path", async () => {
    const simctl = new FakeWatchLifecycleSimctl();
    const lifecycle = lifecycleOver(simctl);

    expect(
      await refusal(
        lifecycle.shutdown({ name: "iPhone 16", platform: "watchos", deviceId: IPHONE_UDID }),
      ),
    ).toContain("No Apple Watch simulator matches");
    expect(
      await refusal(
        lifecycle.shutdown({ name: "iPhone 16", platform: "ios", deviceId: IPHONE_UDID }),
      ),
    ).toContain("as an Apple Watch simulator");
    expect(simctl.commands).toEqual([]);
    expect(simctl.stateOf(IPHONE_UDID)).toBe("Booted");
  });
});

describe("MultiPlatformDeviceManager.killDevice for a watch", () => {
  function managerOver(simctl: FakeWatchLifecycleSimctl, withInventory = true) {
    const manager = new MultiPlatformDeviceManager(
      new FakeAdbClient(),
      fakeDeviceManagerSimctl({ killSimulator: (device) => simctl.killSimulator(device) }),
      createFakeAndroidEmulator(),
    );
    return withInventory
      ? manager.withWatchSimulators(new WatchSimulatorInventory(simctl, "arm64"))
      : manager;
  }

  test("shuts the watch down through the watch lifecycle", async () => {
    const simctl = new FakeWatchLifecycleSimctl([watchDevice({ state: "Booted" })]);

    await managerOver(simctl).killDevice({
      name: watchDevice().name,
      platform: "watchos",
      deviceId: WATCH_UDID,
    });

    expect(simctl.commands).toEqual([`shutdown ${WATCH_UDID}`]);
  });

  test("refuses when no watch listing is wired, before any command", async () => {
    const simctl = new FakeWatchLifecycleSimctl([watchDevice({ state: "Booted" })]);

    const message = await refusal(
      managerOver(simctl, false).killDevice({
        name: watchDevice().name,
        platform: "watchos",
        deviceId: WATCH_UDID,
      }),
    );

    expect(message).toContain("inventory is not available");
    expect(simctl.commands).toEqual([]);
  });
});
