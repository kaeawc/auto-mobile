import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecResult } from "../../../../src/models";
import {
  IosCameraPosterDeviceWide,
  withoutGate,
  type PosterSimctlRunner,
} from "../../../../src/features/utility/ios/IosCameraPosterDeviceWide";
import {
  FakeIosCameraPosterActivationStore,
  FakeIosCameraPosterDylibProvider,
  FakeIosCameraPosterRegistry,
  FakeSimulatorBootEnvironment,
} from "../../../fakes/FakeIosCameraPoster";

const udid = "A1B2C3D4-0000-4000-8000-000000000001";
const stableGate = "/data/ios-camera-poster-active/libAMCameraPosterGate.dylib";

/** A launchd environment: `getenv` reads what `setenv`/`unsetenv` wrote. */
class FakeLaunchctl implements PosterSimctlRunner {
  readonly calls: string[][] = [];
  readonly env = new Map<string, string>();
  failing = false;
  /** `simctl list devices --json` output; the captured all-Shutdown list by default. */
  deviceList = simctlFixture("list-devices.json");
  async executeCommandArgs(args: string[]): Promise<ExecResult> {
    if (args[0] === "list") {
      return execResult(this.deviceList);
    }
    this.calls.push(args);
    if (this.failing) {
      throw new Error("Unable to lookup in current state: Shutdown");
    }
    const [, , , verb, name, value] = args;
    if (verb === "setenv") {
      this.env.set(name!, value!);
    } else if (verb === "unsetenv") {
      this.env.delete(name!);
    }
    return execResult(verb === "getenv" ? `${this.env.get(name!) ?? ""}\n` : "");
  }
}

function execResult(stdout: string): ExecResult {
  return {
    stdout,
    stderr: "",
    toString: () => stdout,
    trim: () => stdout.trim(),
    includes: (s) => stdout.includes(s),
  };
}

function simctlFixture(name: string): string {
  return readFileSync(join(import.meta.dir, "../../../fixtures/ios-simctl", name), "utf8");
}

function setup() {
  const simctl = new FakeLaunchctl();
  const poster = new FakeIosCameraPosterDylibProvider();
  const gate = new FakeIosCameraPosterDylibProvider();
  gate.path = "/cache/ios-camera-poster/abc-sim-universal/libAMCameraPosterGate.dylib";
  const store = new FakeIosCameraPosterActivationStore();
  const boot = new FakeSimulatorBootEnvironment();
  const deviceWide = new IosCameraPosterDeviceWide({
    simctl,
    posterProvider: poster,
    gateProvider: gate,
    config: { path: (id) => `/data/devices/${id}.json` },
    store,
    bootEnvironment: boot,
  });
  return { simctl, poster, gate, store, boot, deviceWide };
}

const launchctl = (...args: string[]) => ["spawn", udid, "launchctl", ...args];

test("inserts the stable gate copy, not the cache build, after the poster variables", async () => {
  const h = setup();
  await h.deviceWide.activate(udid);
  expect(h.store.installed).toEqual([h.gate.path]);
  expect(h.simctl.calls).toEqual([
    launchctl("getenv", "DYLD_INSERT_LIBRARIES"),
    launchctl("setenv", "AM_CAMERA_POSTER_DYLIB", "/camera/libAMCameraPoster.dylib"),
    launchctl("setenv", "AM_CAMERA_POSTER_CONFIG", `/data/devices/${udid}.json`),
    launchctl("setenv", "DYLD_INSERT_LIBRARIES", stableGate),
  ]);
  expect(h.store.read(udid)).toEqual({ gate: stableGate });
});

test("keeps libraries another feature inserted and does not add the gate twice", async () => {
  const h = setup();
  h.simctl.env.set("DYLD_INSERT_LIBRARIES", `/shaper/libShaper.dylib:${stableGate}`);
  await h.deviceWide.activate(udid);
  expect(h.simctl.env.get("DYLD_INSERT_LIBRARIES")).toBe(`/shaper/libShaper.dylib:${stableGate}`);
});

test("clear restores launchd: unsets all three variables when nothing else was inserted", async () => {
  const h = setup();
  await h.deviceWide.activate(udid);
  await h.deviceWide.deactivate(udid);
  expect([...h.simctl.env.keys()]).toEqual([]);
  expect(h.simctl.calls.slice(4)).toEqual([
    launchctl("getenv", "DYLD_INSERT_LIBRARIES"),
    launchctl("unsetenv", "DYLD_INSERT_LIBRARIES"),
    launchctl("unsetenv", "AM_CAMERA_POSTER_DYLIB"),
    launchctl("unsetenv", "AM_CAMERA_POSTER_CONFIG"),
  ]);
  expect(h.store.read(udid)).toBeUndefined();
});

test("clear removes only the gate and keeps a library inserted before or after activation", async () => {
  const h = setup();
  h.simctl.env.set("DYLD_INSERT_LIBRARIES", "/before/libA.dylib");
  await h.deviceWide.activate(udid);
  h.simctl.env.set(
    "DYLD_INSERT_LIBRARIES",
    `${h.simctl.env.get("DYLD_INSERT_LIBRARIES")}:/after/libB.dylib`,
  );
  await h.deviceWide.deactivate(udid);
  expect(h.simctl.env.get("DYLD_INSERT_LIBRARIES")).toBe("/before/libA.dylib:/after/libB.dylib");
  expect(h.simctl.env.has("AM_CAMERA_POSTER_DYLIB")).toBe(false);
});

test("clear leaves a simulator that was never activated alone", async () => {
  const h = setup();
  await h.deviceWide.deactivate(udid);
  expect(h.simctl.calls).toEqual([]);
});

test("concurrent clears share one launchd restore", async () => {
  const h = setup();
  await h.deviceWide.activate(udid);
  h.simctl.calls.length = 0;
  await Promise.all([h.deviceWide.deactivate(udid), h.deviceWide.deactivate(udid)]);
  expect(h.simctl.calls.filter((call) => call[3] === "unsetenv")).toHaveLength(3);
});

test("a boot-time DYLD_INSERT_LIBRARIES blocks activation before launchd is touched", async () => {
  const h = setup();
  h.boot.value = "/shaper/libShaper.dylib";
  await expect(h.deviceWide.activate(udid)).rejects.toThrow(
    "booted with DYLD_INSERT_LIBRARIES=/shaper/libShaper.dylib",
  );
  expect(h.simctl.calls).toEqual([]);
  expect(h.store.read(udid)).toBeUndefined();
});

test("a boot-time gate alone does not block activation and needs no DYLD setenv", async () => {
  const h = setup();
  h.boot.value = stableGate;
  await h.deviceWide.activate(udid);
  expect(h.simctl.env.get("AM_CAMERA_POSTER_DYLIB")).toBe("/camera/libAMCameraPoster.dylib");
  expect(h.simctl.env.has("DYLD_INSERT_LIBRARIES")).toBe(false);
});

test("a shaped boot that carries the gate takes the poster through its variables only", async () => {
  const h = setup();
  h.boot.value = `/shaper/libShaper.dylib:${stableGate}`;
  await h.deviceWide.activate(udid);
  expect(h.simctl.calls).toEqual([
    launchctl("getenv", "DYLD_INSERT_LIBRARIES"),
    launchctl("setenv", "AM_CAMERA_POSTER_DYLIB", "/camera/libAMCameraPoster.dylib"),
    launchctl("setenv", "AM_CAMERA_POSTER_CONFIG", `/data/devices/${udid}.json`),
  ]);
  expect(h.store.read(udid)).toEqual({ gate: stableGate });
  await h.deviceWide.deactivate(udid);
  expect(h.simctl.env.has("AM_CAMERA_POSTER_DYLIB")).toBe(false);
  expect(h.store.read(udid)).toBeUndefined();
});

test("after a boot the recorded poster is applied again", async () => {
  const h = setup();
  const registry = new FakeIosCameraPosterRegistry();
  await h.deviceWide.activate(udid);
  h.simctl.env.clear(); // The reboot reset launchd's environment.
  registry.set(udid, { kind: "image", path: "/p.png" });
  await h.deviceWide.afterBoot(udid, registry);
  expect(h.simctl.env.get("DYLD_INSERT_LIBRARIES")).toBe(stableGate);
  expect(h.simctl.env.get("AM_CAMERA_POSTER_CONFIG")).toBe(`/data/devices/${udid}.json`);
});

test("after a boot with no recorded poster a stale activation is undone", async () => {
  const h = setup();
  await h.deviceWide.activate(udid);
  await h.deviceWide.afterBoot(udid, new FakeIosCameraPosterRegistry());
  expect(h.store.read(udid)).toBeUndefined();
  expect(h.simctl.env.size).toBe(0);
});

test("daemon start undoes every recorded activation and forgets ones it cannot reach", async () => {
  const h = setup();
  await h.deviceWide.activate(udid);
  h.store.write("SHUTDOWN-SIM", { gate: stableGate });
  const reachable = h.simctl.executeCommandArgs.bind(h.simctl);
  h.simctl.executeCommandArgs = async (args) => {
    if (args[1] === "SHUTDOWN-SIM") {
      throw new Error("Unable to lookup in current state: Shutdown");
    }
    return reachable(args);
  };
  await h.deviceWide.sweep();
  expect(h.store.list()).toEqual([]);
  expect(h.simctl.env.size).toBe(0);
});

test("daemon start keeps the record of a still-booted simulator it could not clean (#19119)", async () => {
  const h = setup();
  // The captured list shows this simulator Booted (Xcode 27.2, iOS 27.2).
  const booted = "8B529975-BB5F-4ED5-8309-0FF04764BAE6";
  h.simctl.deviceList = simctlFixture("list-devices-booted-ios27-2.json");
  h.store.write(booted, { gate: stableGate });
  h.simctl.failing = true;
  await h.deviceWide.sweep();
  expect(h.store.list()).toEqual([booted]);
});

test("a clear during an in-flight activation waits for it and then removes the gate (#19119)", async () => {
  const h = setup();
  let releasePoster!: () => void;
  const posterReady = new Promise<void>((resolve) => {
    releasePoster = resolve;
  });
  const ensure = h.poster.ensure.bind(h.poster);
  h.poster.ensure = async () => {
    await posterReady;
    return ensure();
  };
  const activation = h.deviceWide.activate(udid);
  const clear = h.deviceWide.deactivate(udid);
  releasePoster();
  await Promise.all([activation, clear]);
  expect(h.store.read(udid)).toBeUndefined();
  expect(h.simctl.env.size).toBe(0);
});

test("a library that cannot be built fails before launchd is touched", async () => {
  const h = setup();
  h.gate.error = new Error("no clang");
  await expect(h.deviceWide.activate(udid)).rejects.toThrow("no clang");
  expect(h.simctl.calls).toEqual([]);
});

test("withoutGate drops any gate copy, including an older cache path", () => {
  expect(
    withoutGate(`/a.dylib:/cache/x/libAMCameraPosterGate.dylib:${stableGate}:/b.dylib`, stableGate),
  ).toBe("/a.dylib:/b.dylib");
});
