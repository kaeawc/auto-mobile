import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DefaultDeviceResourceController } from "../../src/utils/deviceResourceController";
import { DefaultDeviceResourceObserver } from "../../src/utils/deviceResourceObserver";
import {
  DefaultDeviceResourceReconciler,
  type DeviceResourceReconcileRequest,
} from "../../src/utils/deviceResourceReconciler";
import { IosDeviceResourceReader } from "../../src/utils/iosDeviceResourceReader";
import { iosDeviceResourceCatalog } from "../../src/utils/iosDeviceResourceCatalog";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceResourceApplicationStore } from "../fakes/FakeDeviceResourceApplicationStore";
import {
  FakeWallpaperPlist,
  FakeWallpaperSimctl,
  label,
  runtime,
  udid,
} from "../fakes/FakeIosResourceRuntime";

const widgetsLabel = iosDeviceResourceCatalog.widgets[0];
const iPhone16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";

describe("simulator workload profile reconciliation (#6694)", () => {
  let simctl: FakeWallpaperSimctl;
  let plist: FakeWallpaperPlist;
  let timer: FakeTimer;
  let store: FakeDeviceResourceApplicationStore;
  let controller: DefaultDeviceResourceController;
  let reconciler: DefaultDeviceResourceReconciler;
  let request: DeviceResourceReconcileRequest;
  beforeEach(() => {
    simctl = new FakeWallpaperSimctl();
    plist = new FakeWallpaperPlist();
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    store = new FakeDeviceResourceApplicationStore();
    const readDirectory = (path: string) => plist.readDirectory(path);
    controller = new DefaultDeviceResourceController(
      simctl,
      plist,
      timer,
      readDirectory,
      undefined,
      store,
    );
    reconciler = new DefaultDeviceResourceReconciler({
      controller,
      observer: new DefaultDeviceResourceObserver({ simctl, plist, timer, readDirectory }),
      identity: new IosDeviceResourceReader({ simctl, plist, timer, readDirectory }),
      store,
      timer,
    });
    request = {
      device: { platform: "ios", name: "Phone", deviceId: udid },
      profile: { resources: { wallpaperRendering: "disabled", widgets: "disabled" } },
      deadlineMs: 120_000,
    };
  });

  function disableManually(service: string) {
    simctl.state(service).disabled = true;
    simctl.state(service).loaded = false;
  }

  function erase() {
    simctl.states.clear();
    simctl.disabled = false;
    simctl.loaded = true;
  }

  test("report-only reconciliation returns typed drift without writes", async () => {
    disableManually(widgetsLabel);
    const result = await reconciler.reconcile(request);
    expect(result.success).toBe(false);
    expect(result.identity).toEqual({
      platform: "ios",
      udid,
      runtimeId: runtime,
      deviceTypeId: iPhone16,
    });
    expect(result.drift.map(({ resource, kind }) => ({ resource, kind }))).toEqual([
      { resource: "wallpaperRendering", kind: "missingRequested" },
    ]);
    expect(result.remainingDrift).toEqual(result.drift);
    expect(result.applied).toBeUndefined();
    expect(simctl.mutations()).toEqual([]);
    expect(store.writes).toBe(0);
  });

  test("repair applies only the delta, re-reads, and proves the result", async () => {
    disableManually(widgetsLabel);
    const result = await reconciler.reconcile({ ...request, repair: true });
    expect(result.success).toBe(true);
    expect(result.remainingDrift).toEqual([]);
    expect(result.applied?.requested).toEqual({ wallpaperRendering: "disabled" });
    expect(simctl.mutations()).toEqual([
      ["spawn", udid, "launchctl", "disable", `system/${label}`],
      ["spawn", udid, "launchctl", "bootout", `system/${label}`],
    ]);
    expect(result.observed.resources.wallpaperRendering.state).toBe("disabled");
    // Widgets were disabled by someone else, so AutoMobile records only its own change.
    expect((await store.get(result.identity))?.resources).toEqual({
      wallpaperRendering: "disabled",
    });
  });

  test("repeated reconciliation is idempotent", async () => {
    const first = await reconciler.reconcile({ ...request, repair: true });
    const mutations = simctl.mutations().length;
    const second = await reconciler.reconcile({ ...request, repair: true });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.drift).toEqual([]);
    expect(second.applied).toBeUndefined();
    expect(simctl.mutations()).toHaveLength(mutations);
    expect(second.profileFingerprint).toBe(first.profileFingerprint);
  });

  test("after an erase, recorded overrides are reapplied and never reported as extras", async () => {
    await reconciler.reconcile({ ...request, repair: true });
    erase();
    const report = await reconciler.reconcile(request);
    expect(report.drift.map(({ resource, kind }) => [resource, kind])).toEqual([
      ["wallpaperRendering", "missingRequested"],
      ["widgets", "missingRequested"],
    ]);
    const repaired = await reconciler.reconcile({ ...request, repair: true });
    expect(repaired.success).toBe(true);
  });

  test("owned extras are reported, and released only on request", async () => {
    await controller.setResources({
      device: request.device,
      resources: { widgets: "disabled" },
      deadlineMs: 120_000,
    });
    disableManually(iosDeviceResourceCatalog.tipsServices[0]);
    const narrower = { ...request, profile: { resources: { wallpaperRendering: "disabled" } } };
    const report = await reconciler.reconcile({ ...narrower, repair: true });
    expect(report.success).toBe(false);
    expect(report.remainingDrift.map(({ resource, kind }) => [resource, kind])).toEqual([
      ["widgets", "ownedExtra"],
    ]);
    expect(simctl.state(widgetsLabel).disabled).toBe(true);

    const released = await reconciler.reconcile({
      ...narrower,
      repair: true,
      releaseOwnedExtras: true,
    });
    expect(released.success).toBe(true);
    expect(released.applied?.requested).toEqual({ widgets: "enabled" });
    expect(simctl.state(widgetsLabel).disabled).toBe(false);
    // A service AutoMobile never touched stays disabled.
    expect(simctl.state(iosDeviceResourceCatalog.tipsServices[0]).disabled).toBe(true);
    expect((await store.get(released.identity))?.resources).toEqual({
      wallpaperRendering: "disabled",
    });
  });

  test("unsupported runtime behavior fails closed without a write for that resource", async () => {
    plist.missing.add(iosDeviceResourceCatalog.tipsServices[0]);
    simctl.state(iosDeviceResourceCatalog.tipsServices[0]).loaded = false;
    const result = await reconciler.reconcile({
      ...request,
      profile: { resources: { tipsServices: "disabled" } },
      repair: true,
    });
    expect(result.success).toBe(false);
    expect(result.remainingDrift.map(({ kind }) => kind)).toEqual(["unsupported"]);
    expect(result.applied).toBeUndefined();
    expect(simctl.mutations()).toEqual([]);
  });

  test("a partial transition stays visible and is not reported as success", async () => {
    simctl.ignoreWrites = true;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await reconciler.reconcile({ ...request, repair: true });
      expect(result.success).toBe(false);
      expect(result.applied?.success).toBe(false);
      expect(result.remainingDrift.map(({ resource }) => resource)).toEqual([
        "wallpaperRendering",
        "widgets",
      ]);
      expect(store.records.size).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("a recreated simulator of another device type does not inherit the record", async () => {
    await controller.setResources({
      device: request.device,
      resources: { widgets: "disabled" },
      deadlineMs: 120_000,
    });
    simctl.deviceTypeIdentifier = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
    const result = await reconciler.reconcile({
      ...request,
      profile: { resources: { wallpaperRendering: "enabled" } },
    });
    expect(result.drift).toEqual([]);
    expect(result.success).toBe(true);
  });

  test.each([
    { platform: "android" as const, deviceId: "emulator-5554" },
    { platform: "ios" as const, deviceId: "00008110-000A1C2E3F4A801E" },
  ])("rejects $platform target $deviceId without native commands", async (device) => {
    await expect(
      reconciler.reconcile({ ...request, device: { ...device, name: "target" } }),
    ).rejects.toThrow("requires a booted iOS Simulator");
    expect(simctl.calls).toEqual([]);
  });

  test("a simulator that is not booted fails with an actionable error", async () => {
    simctl.booted = false;
    await expect(reconciler.reconcile(request)).rejects.toThrow("is not booted");
    expect(simctl.mutations()).toEqual([]);
  });

  test("cancellation before reconciliation runs no commands", async () => {
    const abort = new AbortController();
    abort.abort(new Error("caller cancelled"));
    await expect(reconciler.reconcile({ ...request, signal: abort.signal })).rejects.toThrow(
      "caller cancelled",
    );
    expect(simctl.calls).toEqual([]);
  });
});
