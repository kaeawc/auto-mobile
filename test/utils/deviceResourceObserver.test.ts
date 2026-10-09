import { describe, expect, spyOn, test } from "bun:test";
import {
  DefaultDeviceResourceObserver,
  type DeviceResourceObservationRequest,
} from "../../src/utils/deviceResourceObserver";
import type { DeviceResourceStatus } from "../../src/models/DeviceResource";
import { androidResourceSettings } from "../../src/utils/androidDeviceResourceCatalog";
import { iosDeviceResourceCatalog } from "../../src/utils/iosDeviceResourceCatalog";
import { logger } from "../../src/utils/logger";
import { ResourceAdb } from "../fakes/FakeAndroidResourceAdb";
import { FakeWallpaperSimctl, FakeWallpaperPlist, udid } from "../fakes/FakeIosResourceRuntime";
import { FakeTimer } from "../fakes/FakeTimer";

const commonKeys = [
  "wallpaperRendering",
  "widgets",
  "liveActivities",
  "backgroundSync",
  "searchIndexing",
  "animations",
];
function setup(platform: "android" | "ios") {
  const adb = new ResourceAdb();
  adb.packages.set("com.google.android.gms", "1");
  for (const key of androidResourceSettings.animations.keys) {
    adb.settings.set(key, "1");
  }
  const simctl = new FakeWallpaperSimctl();
  const plist = new FakeWallpaperPlist();
  const timer = new FakeTimer();
  const observer = new DefaultDeviceResourceObserver({
    adbFactory: { create: () => adb },
    simctl,
    plist,
    timer,
    readDirectory: (path: string) => plist.readDirectory(path),
  });
  const request: DeviceResourceObservationRequest = {
    device: {
      platform,
      deviceId: platform === "android" ? "emulator-5580" : udid,
      name: "resource-test",
    },
    deadlineMs: 1000,
  };
  return { adb, simctl, plist, timer, observer, request };
}
function expectReason(status: DeviceResourceStatus | undefined, state: string) {
  expect(status?.state).toBe(state);
  expect(status?.reason).toBeTruthy();
}

describe("Android resource observation", () => {
  test("returns every required key with native observations and no configuration receipt", async () => {
    const { observer, request } = setup("android");
    const result = await observer.observeResources(request);
    expect(result.deviceId).toBe(request.device.deviceId);
    expect(result.platform).toBe("android");
    expect(Object.keys(result.resources)).toEqual(
      expect.arrayContaining([...commonKeys, "googlePlayServices"]),
    );
    expect(result.resources.animations.state).toBe("enabled");
    expect(result.resources).toMatchObject({ googlePlayServices: { state: "enabled" } });
    expect(Object.keys(result).sort()).toEqual(["deviceId", "platform", "resources"]);
    for (const key of [
      "wallpaperRendering",
      "widgets",
      "liveActivities",
      "backgroundSync",
      "searchIndexing",
    ] as const) {
      expectReason(result.resources[key], "unsupported");
    }
  });
  test("mixed animation scales are unknown", async () => {
    const { observer, request, adb } = setup("android");
    adb.settings.set("window_animation_scale", "0");
    expectReason((await observer.observeResources(request)).resources.animations, "unknown");
  });
  test("absent setting and default package override are unknown, never inferred", async () => {
    const { observer, request, adb } = setup("android");
    adb.settings.delete("window_animation_scale");
    adb.packages.set("com.google.android.gms", "0");
    const result = await observer.observeResources(request);
    expectReason(result.resources.animations, "unknown");
    expectReason(result.resources.googlePlayServices, "unknown");
  });
  test("fully disabled groups are verified from every target", async () => {
    const { observer, request, adb } = setup("android");
    for (const key of androidResourceSettings.animations.keys) {
      adb.settings.set(key, "0");
    }
    adb.packages.set("com.google.android.gms", "3");
    const result = await observer.observeResources(request);
    expect(result.resources.animations.state).toBe("disabled");
    expect(result.resources.googlePlayServices?.state).toBe("disabled");
  });
  test("partially installed optional groups are unknown; wholly absent groups unsupported", async () => {
    const { observer, request } = setup("android");
    const result = await observer.observeResources(request);
    expectReason(result.resources.mailApp, "unknown");
    expectReason(result.resources.calendarApp, "unsupported");
  });
  test("missing Play services is unsupported with a reason", async () => {
    const { observer, request, adb } = setup("android");
    adb.packages.delete("com.google.android.gms");
    expectReason(
      (await observer.observeResources(request)).resources.googlePlayServices,
      "unsupported",
    );
  });
  test("native read failures are logged unknown while independent groups remain observed", async () => {
    const { observer, request, adb } = setup("android");
    adb.settings.set("window_animation_scale", "permission denied");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await observer.observeResources(request);
      expectReason(result.resources.animations, "unknown");
      expect(result.resources.googlePlayServices?.state).toBe("enabled");
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
  test("physical devices return unsupported required keys without native commands", async () => {
    const { observer, request, adb } = setup("android");
    request.device.deviceId = "physical-device";
    const result = await observer.observeResources(request);
    expect(Object.keys(result.resources)).toEqual(
      expect.arrayContaining([...commonKeys, "googlePlayServices"]),
    );
    for (const status of Object.values(result.resources)) {
      expectReason(status, "unsupported");
    }
    expect(adb.commands).toEqual([]);
  });
  test("never dispatches package/settings/backup writes, including optional groups", async () => {
    const { observer, request, adb } = setup("android");
    await observer.observeResources(request);
    expect(
      adb.commands.some(
        (words) =>
          (words[0] === "pm" && words[1] !== "list") ||
          (words[0] === "settings" && ["put", "delete"].includes(words[3]!)) ||
          (words[0] === "bmgr" && words[3] === "enable"),
      ),
    ).toBe(false);
    expect(adb.commands.some((words) => words[0] === "bmgr")).toBe(true);
  });
});

describe("iOS Simulator resource observation", () => {
  test("returns complete required keys with native enabled evidence", async () => {
    const { observer, request, plist } = setup("ios");
    const result = await observer.observeResources(request);
    expect(result.deviceId).toBe(udid);
    expect(result.platform).toBe("ios");
    expect(Object.keys(result.resources)).toEqual(
      expect.arrayContaining([...commonKeys, "icloudSync", "photoAnalysis"]),
    );
    for (const key of [
      "wallpaperRendering",
      "widgets",
      "liveActivities",
      "searchIndexing",
    ] as const) {
      expect(result.resources[key].state).toBe("enabled");
    }
    expect(result.resources.photoAnalysis?.state).toBe("enabled");
    for (const key of ["animations", "backgroundSync"] as const) {
      expectReason(result.resources[key], "unsupported");
    }
    expectReason(result.resources.icloudSync, "unsupported");
    expect(Object.keys(result.resources)).toEqual(
      expect.arrayContaining(Object.keys(iosDeviceResourceCatalog)),
    );
    expect(plist.directoryReads).toBe(3);
    expect(Object.keys(result).sort()).toEqual(["deviceId", "platform", "resources"]);
  });
  test("reads disabled override plus absent registration without writes", async () => {
    const { observer, request, simctl } = setup("ios");
    simctl.disabled = true;
    simctl.loaded = false;
    expect((await observer.observeResources(request)).resources.wallpaperRendering.state).toBe(
      "disabled",
    );
    expect(simctl.mutations()).toEqual([]);
  });
  test("mixed group evidence is unknown", async () => {
    const { observer, request, simctl } = setup("ios");
    simctl.states.set("com.apple.healthd", { disabled: true, loaded: false });
    expectReason((await observer.observeResources(request)).resources.healthServices, "unknown");
  });
  test("missing one definition yields incomplete unknown evidence", async () => {
    const { observer, request, simctl, plist } = setup("ios");
    plist.missing.add("com.apple.healthd");
    simctl.states.set("com.apple.healthd", { disabled: false, loaded: false });
    expectReason((await observer.observeResources(request)).resources.healthServices, "unknown");
  });
  test("wholly absent groups are unsupported", async () => {
    const { observer, request, simctl, plist } = setup("ios");
    plist.missing.add("com.apple.photoanalysisd");
    simctl.states.set("com.apple.photoanalysisd", { disabled: false, loaded: false });
    expectReason((await observer.observeResources(request)).resources.photoAnalysis, "unsupported");
  });
  test("incompatible installed definition yields unknown incomplete evidence", async () => {
    const { observer, request, plist } = setup("ios");
    plist.definitions.set("com.apple.healthd", { Label: "com.apple.healthd", Disabled: true });
    expectReason((await observer.observeResources(request)).resources.healthServices, "unknown");
  });
  test("override/registration disagreement is unknown", async () => {
    const { observer, request, simctl } = setup("ios");
    simctl.disabled = true;
    expectReason(
      (await observer.observeResources(request)).resources.wallpaperRendering,
      "unknown",
    );
  });
  test("malformed native read evidence is logged unknown", async () => {
    const { observer, request, simctl } = setup("ios");
    simctl.malformed = true;
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expectReason(
        (await observer.observeResources(request)).resources.wallpaperRendering,
        "unknown",
      );
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
  test("physical iOS has a complete unsupported snapshot without native reads", async () => {
    const { observer, request, simctl, plist } = setup("ios");
    request.device.deviceId = "physical-device";
    const result = await observer.observeResources(request);
    for (const status of Object.values(result.resources)) {
      expectReason(status, "unsupported");
    }
    expect(simctl.calls).toEqual([]);
    expect(plist.paths).toEqual([]);
  });
  test("a non-booted simulator is unsupported without service reads", async () => {
    const { observer, request, simctl } = setup("ios");
    simctl.booted = false;
    const result = await observer.observeResources(request);
    expectReason(result.resources.wallpaperRendering, "unsupported");
    expect(simctl.calls).toHaveLength(1);
  });
  test("never issues launchctl writes across the full catalog", async () => {
    const { observer, request, simctl } = setup("ios");
    await observer.observeResources(request);
    expect(simctl.mutations()).toEqual([]);
    expect(
      simctl.calls
        .filter((args) => args[0] === "spawn")
        .every((args) => ["print", "print-disabled"].includes(args[3]!)),
    ).toBe(true);
    expect(simctl.calls.some((args) => args[3] === "print")).toBe(true);
  });
});

for (const platform of ["android", "ios"] as const) {
  test(`${platform} stops dispatching at the injected deadline`, async () => {
    const { observer, request, timer, adb, simctl } = setup(platform);
    request.deadlineMs = timer.now();
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expectReason(
        (await observer.observeResources(request)).resources.animations,
        platform === "android" ? "unknown" : "unsupported",
      );
      expect(adb.commands).toEqual([]);
      expect(simctl.calls).toEqual([]);
    } finally {
      warning.mockRestore();
    }
  });
  test(`${platform} propagates cancellation and stops dispatching`, async () => {
    const { observer, request, adb, simctl } = setup(platform);
    const abort = new AbortController();
    const reason = new Error("preempted");
    request.signal = abort.signal;
    adb.onCommand = () => abort.abort(reason);
    simctl.onCommand = () => abort.abort(reason);
    await expect(observer.observeResources(request)).rejects.toBe(reason);
    expect(platform === "android" ? adb.commands.length : simctl.calls.length).toBe(1);
  });
}

test("observer fake records requests and returns an independent configured snapshot", async () => {
  const { FakeDeviceResourceObserver } = await import("../fakes/FakeDeviceResourceObserver");
  const { request } = setup("ios");
  const fake = new FakeDeviceResourceObserver();
  fake.result.deviceId = request.device.deviceId;
  const result = await fake.observeResources(request);
  expect(fake.requests).toEqual([request]);
  expect(result).toEqual(fake.result);
});

for (const platform of ["android", "ios"] as const) {
  test(`${platform} discovery failure is logged unknown for supported groups`, async () => {
    const { observer, request, adb, simctl, timer } = setup(platform);
    // iOS inventory reads back off between bounded retries.
    timer.enableAutoAdvance();
    adb.onCommand = () => {
      throw new Error("permission denied");
    };
    simctl.onCommand = () => {
      throw new Error("permission denied");
    };
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await observer.observeResources(request);
      expectReason(
        platform === "android"
          ? result.resources.googlePlayServices
          : result.resources.wallpaperRendering,
        "unknown",
      );
      expectReason(result.resources.backgroundSync, "unsupported");
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
  test(`${platform} ignores a structurally supplied requested configuration`, async () => {
    const { observer, request } = setup(platform);
    const extra = {
      ...request,
      resources: {
        animations: "disabled",
        wallpaperRendering: "disabled",
        googlePlayServices: "disabled",
      },
    };
    const result = await observer.observeResources(extra);
    expect(
      platform === "android"
        ? result.resources.animations.state
        : result.resources.wallpaperRendering.state,
    ).toBe("enabled");
  });
  test(`${platform} propagates an already aborted signal without reads`, async () => {
    const { observer, request, adb, simctl } = setup(platform);
    const abort = new AbortController();
    const reason = new Error("preempted before observation");
    abort.abort(reason);
    request.signal = abort.signal;
    await expect(observer.observeResources(request)).rejects.toBe(reason);
    expect(adb.commands).toEqual([]);
    expect(simctl.calls).toEqual([]);
  });
}

test("Android mixed installed package evidence is unknown and optional settings/backup are observed", async () => {
  const { observer, request, adb } = setup("android");
  adb.packages.set("com.google.android.gm", "1");
  adb.packages.set("com.android.email", "3");
  adb.settings.set("screensaver_enabled", "0");
  adb.backupEnabled = false;
  const result = await observer.observeResources(request);
  expectReason(result.resources.mailApp, "unknown");
  expect(result.resources.screensavers?.state).toBe("disabled");
  expect(result.resources.backup?.state).toBe("disabled");
});

test("iOS permission failure in one native service is unknown without obscuring other groups", async () => {
  const { observer, request, simctl } = setup("ios");
  simctl.failVerb = "print";
  simctl.failLabel = "com.apple.PosterBoard";
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const result = await observer.observeResources(request);
    expectReason(result.resources.wallpaperRendering, "unknown");
    expect(result.resources.photoAnalysis?.state).toBe("enabled");
    expect(warning).toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

test("iOS filesystem read failure is unknown, not runtime absence", async () => {
  const { request, simctl, plist, timer } = setup("ios");
  const observer = new DefaultDeviceResourceObserver({
    simctl,
    plist,
    timer,
    readDirectory: async () => {
      throw new Error("permission denied reading runtime");
    },
  });
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expectReason(
      (await observer.observeResources(request)).resources.wallpaperRendering,
      "unknown",
    );
    expect(warning).toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});
