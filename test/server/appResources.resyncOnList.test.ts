import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { registerAppResources, syncInstalledAppResources } from "../../src/server/appResources";
import {
  installedAppResourceResyncGate,
  registerInstalledAppResourceListRefresher,
} from "../../src/server/installedAppResourceResync";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

const makeDevice = (deviceId: string): BootedDevice => ({
  deviceId,
  name: deviceId,
  platform: "android",
});

/*
 * Registration is once-per-process (#13068), so devices booted or removed outside AutoMobile
 * must still reach resources/list: it resyncs at most once per freshness window.
 */
describe("installed-app resources resync on resources/list", () => {
  let booted: BootedDevice[];
  let probes: number;
  let timer: FakeTimer;

  const listUris = (): string[] => ResourceRegistry.getResourceDefinitions().map((r) => r.uri);
  const refreshForList = async (): Promise<void> => {
    // The resources/list handler awaits exactly the registered refreshers.
    await ResourceRegistry.refreshBeforeList();
  };

  beforeEach(async () => {
    booted = [makeDevice("resync-a")];
    probes = 0;
    timer = new FakeTimer();
    const devices = new FakeDeviceUtils();
    devices.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(devices);
    const original = devices.getBootedDevices.bind(devices);
    spyOn(devices, "getBootedDevices").mockImplementation(async (platform) => {
      probes++;
      devices.setBootedDevices("android", [...booted]);
      return original(platform);
    });
    installedAppResourceResyncGate.reset();
    registerAppResources();
    registerInstalledAppResourceListRefresher(() => syncInstalledAppResources(), timer);
    await syncInstalledAppResources();
  });

  afterEach(async () => {
    booted = [];
    await syncInstalledAppResources();
    ResourceRegistry.clearResources();
    PlatformDeviceManagerFactory.reset();
    installedAppResourceResyncGate.reset();
  });

  test("a device booted outside AutoMobile appears once the window has passed", async () => {
    booted = [makeDevice("resync-a"), makeDevice("resync-b")];
    timer.advanceTime(6000);

    await refreshForList();

    expect(listUris()).toContain("automobile:devices/resync-b/apps");
  });

  test("a device removed outside AutoMobile disappears once the window has passed", async () => {
    booted = [];
    timer.advanceTime(6000);

    await refreshForList();

    expect(listUris()).not.toContain("automobile:devices/resync-a/apps");
  });

  test("lists inside the freshness window do not rediscover devices", async () => {
    await refreshForList();
    const before = probes;
    timer.advanceTime(1000);

    await refreshForList();
    await refreshForList();

    expect(probes).toBe(before);
  });

  test("concurrent stale lists share one discovery", async () => {
    const before = probes;
    timer.advanceTime(6000);

    await Promise.all([
      installedAppResourceResyncGate.resyncIfStale(() => syncInstalledAppResources(), timer),
      installedAppResourceResyncGate.resyncIfStale(() => syncInstalledAppResources(), timer),
    ]);

    expect(probes).toBe(before + 1);
  });
});
