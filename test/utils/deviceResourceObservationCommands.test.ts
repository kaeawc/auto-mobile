import { expect, test } from "bun:test";
import { DefaultDeviceResourceObserver } from "../../src/utils/deviceResourceObserver";
import { AndroidDeviceResourceReader } from "../../src/utils/androidDeviceResourceReader";
import { IosDeviceResourceReader } from "../../src/utils/iosDeviceResourceReader";
import { androidDeviceResourceCatalog } from "../../src/utils/androidDeviceResourceCatalog";
import { ResourceAdb } from "../fakes/FakeAndroidResourceAdb";
import { FakeWallpaperSimctl, FakeWallpaperPlist, udid } from "../fakes/FakeIosResourceRuntime";
import { FakeTimer } from "../fakes/FakeTimer";

const device = { platform: "android" as const, deviceId: "emulator-5580", name: "resources" };

test("a full Android observation dispatches each distinct package read once per observation", async () => {
  const adb = new ResourceAdb();
  for (const name of Object.values(androidDeviceResourceCatalog).flat()) {
    adb.packages.set(name, "1");
  }
  const observer = new DefaultDeviceResourceObserver({
    adbFactory: { create: () => adb },
    timer: new FakeTimer(),
  });
  const request = { device, deadlineMs: 1000 };
  await observer.observeResources(request);
  const lists = adb.commands.filter((args) => args.slice(0, 4).join(" ") === "pm list packages -s");
  const dumps = adb.commands.filter((args) => args[0] === "dumpsys");
  expect(lists).toHaveLength(1);
  expect(dumps.length).toBe(new Set(dumps.map((args) => args[2])).size);
  expect(dumps.length).toBe(new Set(Object.values(androidDeviceResourceCatalog).flat()).size);
  adb.commands = [];
  adb.packages.set("com.google.android.gms", "3");
  const fresh = await observer.observeResources(request);
  expect(fresh.resources.googlePlayServices?.state).toBe("disabled");
  expect(adb.commands.filter((args) => args[0] === "pm")).toHaveLength(1);
});

test("Android configuration runs re-read package, settings and backup state after writes", async () => {
  const adb = new ResourceAdb();
  const reader = new AndroidDeviceResourceReader({
    adbFactory: { create: () => adb },
    timer: new FakeTimer(),
  });
  const run = reader.createRun({ device, deadlineMs: 1000 });
  run.user = "0";
  const entries = await reader.discover(run, "mailApp");
  const entry = entries.find(({ target }) => target === "com.google.android.gm")!;
  expect(await reader.read(run, entry)).toBe("0");
  await run.command(["pm", "enable", "--user", "0", entry.target]);
  expect(await reader.read(run, entry)).toBe("1");
  const settings = (await reader.discover(run, "animations"))[0]!;
  expect(await reader.read(run, settings)).toBeNull();
  await run.command(["settings", "--user", "0", "put", settings.kind, settings.target, "0"]);
  expect(await reader.read(run, settings)).toBe("0");
  const backup = (await reader.discover(run, "backup"))[0]!;
  expect(await reader.read(run, backup)).toBe("1");
  await run.command(["bmgr", "--user", "0", "enable", "false"]);
  expect(await reader.read(run, backup)).toBe("0");
});

test("Android observation shares in-flight package reads and retries rejected reads", async () => {
  const adb = new ResourceAdb();
  const reader = new AndroidDeviceResourceReader({
    adbFactory: { create: () => adb },
    timer: new FakeTimer(),
  });
  const run = reader.createRun({ device, deadlineMs: 1000 }, true);
  const args = ["pm", "list", "packages", "-s", "--user", "0"];
  const first = run.command(args);
  expect(run.command(args)).toBe(first);
  await first;
  adb.onCommand = () => {
    throw new Error("read failed");
  };
  const dump = ["dumpsys", "package", "com.google.android.gm"];
  await expect(run.command(dump)).rejects.toThrow("read failed");
  adb.onCommand = undefined;
  await run.command(dump);
  expect(adb.commands.filter((words) => words[0] === "dumpsys")).toHaveLength(2);
});

test("iOS observation shares repeated launchctl reads but inventory and directories already run once", async () => {
  const simctl = new FakeWallpaperSimctl();
  const plist = new FakeWallpaperPlist();
  const timer = new FakeTimer();
  const observer = new DefaultDeviceResourceObserver({
    simctl,
    plist,
    timer,
    readDirectory: (path) => plist.readDirectory(path),
  });
  const request = {
    device: { ...device, platform: "ios" as const, deviceId: udid },
    deadlineMs: 1000,
  };
  await observer.observeResources(request);
  expect(simctl.calls.filter((args) => args[3] === "print-disabled")).toHaveLength(1);
  expect(simctl.calls.length).toBe(new Set(simctl.calls.map((args) => JSON.stringify(args))).size);
  expect(simctl.calls.filter((args) => args[0] === "list")).toHaveLength(2);
  expect(plist.directoryReads).toBe(3);
  // The shared configuration reader must still see fresh overrides after a write.
  const reader = new IosDeviceResourceReader({ simctl, plist, timer });
  expect((await reader.readService(request, "com.apple.PosterBoard")).state).toBe("enabled");
  simctl.disabled = true;
  simctl.loaded = false;
  expect((await reader.readService(request, "com.apple.PosterBoard")).state).toBe("disabled");
});
