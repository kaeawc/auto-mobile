import { describe, expect, test } from "bun:test";
import { AppLifecycle } from "../../../src/features/action/AppLifecycle";
import type {
  IosAppProcess,
  IosAppProcessControl,
} from "../../../src/features/action/IosAppLifecycle";
import { simulatorMemoryWarningPath } from "../../../src/features/action/IosSimulatorMemoryWarning";
import type { BootedDevice } from "../../../src/models";
import { FakeMemoryWarningFileSystem } from "../../fakes/FakeMemoryWarningFileSystem";
import { FakeTimer } from "../../fakes/FakeTimer";

// Captured on an iOS 26.5 simulator (#18718); the user home is replaced by `<user>`.
const PLUTIL_MEMORY_LINE =
  '      "SIMULATOR_MEMORY_WARNINGS" => "/Users/<user>/Library/Developer/CoreSimulator/Devices/C4B39FB3-4062-488E-9984-C37653E73326/data/var/run/memory_warning_simulation"';
const SIM = "C4B39FB3-4062-488E-9984-C37653E73326";
const PHONE = "00008110-001A2B3C4D5E6F70";
const HOME = "/Users/<user>";
const APP = "dev.memwarn.probe";
const OTHER_APP = "dev.memwarn.probe2";
// The epoch second the probe app logged applicationDidReceiveMemoryWarning (#18718).
const WARNING_AT_MS = 1795093932464;
const pathOptions = { homeDirectory: HOME, environment: {} };
const SIM_PATH = simulatorMemoryWarningPath(SIM, pathOptions);

const device = (deviceId: string): BootedDevice => ({
  deviceId,
  name: "iPhone 17",
  platform: "ios",
});

interface HarnessOptions {
  deviceId?: string;
  process?: IosAppProcess | null | undefined;
  foreground?: string | undefined | Error;
  existing?: ReadonlySet<string>;
}

function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const timer = new FakeTimer();
  timer.setCurrentTime(WARNING_AT_MS);
  const process = "process" in options ? options.process : { pid: 19573 };
  const control: IosAppProcessControl = {
    find: async () => {
      events.push("find");
      return process;
    },
    kill: async () => {
      events.push("kill");
      return "signalled";
    },
  };
  const fileSystem = new FakeMemoryWarningFileSystem(options.existing ?? new Set([SIM_PATH]));
  const foreground = "foreground" in options ? options.foreground : APP;
  const lifecycle = new AppLifecycle(device(options.deviceId ?? SIM), {
    timer,
    home: {
      execute: async () => {
        events.push("home");
      },
    },
    cacheInvalidator: { retireAppProcess: () => {}, invalidate: () => {} },
    iosProcesses: control,
    iosMemoryWarning: {
      fileSystem,
      path: pathOptions,
      foregroundApp: async () => {
        events.push("foreground");
        if (foreground instanceof Error) {
          throw foreground;
        }
        return foreground;
      },
    },
  });
  const mutations: number[] = [];
  const run = (appId = APP, trimLevel: "memoryWarning" | "COMPLETE" = "memoryWarning") =>
    lifecycle.execute(appId, "trimMemory", { trimLevel, onMutation: () => mutations.push(1) });
  return { run, lifecycle, fileSystem, events, mutations };
}

describe("iOS simulator trimMemory memoryWarning (#18754)", () => {
  test("resolves the same path CoreSimulator exports as SIMULATOR_MEMORY_WARNINGS", () => {
    const posixPath = SIM_PATH.replaceAll("\\", "/");
    expect(PLUTIL_MEMORY_LINE).toContain(`"${posixPath}"`);
  });

  test("a custom device set root replaces the default Devices directory", () => {
    const path = simulatorMemoryWarningPath(SIM, {
      homeDirectory: HOME,
      environment: { CORESIMULATOR_DEVICE_SET_PATH: "/tmp/automobile-set" },
    }).replaceAll("\\", "/");
    expect(path).toEndWith(`/tmp/automobile-set/${SIM}/data/var/run/memory_warning_simulation`);
  });

  test("touches the file's mtime for the foreground app without pressing Home or killing", async () => {
    const h = harness();

    const result = await h.run();

    expect(result).toMatchObject({
      success: true,
      supported: true,
      platform: "ios",
      mechanism: "simulator-memory-warning-file",
      trimLevel: "memoryWarning",
      pid: 19573,
    });
    expect(result.message).toContain("Simulated a memory warning for dev.memwarn.probe");
    expect(h.fileSystem.calls).toEqual([
      { path: SIM_PATH, atime: new Date(WARNING_AT_MS), mtime: new Date(WARNING_AT_MS) },
    ]);
    expect(h.events).toEqual(["find", "foreground"]);
    expect(h.mutations).toEqual([1]);
  });

  test("another foreground app is refused without touching the file", async () => {
    const h = harness({ foreground: OTHER_APP });

    const result = await h.run();

    expect(result).toMatchObject({
      success: false,
      mechanism: "simulator-memory-warning-file",
      errorCode: "app_not_foreground",
    });
    expect(result.error).toContain(`${OTHER_APP} is`);
    expect(result.error).toContain("reaches only the foreground app");
    expect(h.fileSystem.calls).toEqual([]);
    expect(h.mutations).toEqual([]);
  });

  test("an unreadable foreground still sends the warning and says delivery is unverified", async () => {
    for (const foreground of [undefined, new Error("observe timed out")]) {
      const h = harness({ foreground });

      const result = await h.run();

      expect(result).toMatchObject({ success: true, trimLevel: "memoryWarning" });
      expect(result.message).toContain("foreground app could not be read");
      expect(h.fileSystem.calls).toHaveLength(1);
    }
  });

  test("a missing file is a trim_failed result that asks for a booted simulator", async () => {
    const h = harness({ existing: new Set() });

    const result = await h.run();

    expect(result).toMatchObject({ success: false, errorCode: "trim_failed" });
    expect(result.error).toContain("does not exist; boot simulator");
  });

  test("another filesystem failure is a trim_failed result with its reason", async () => {
    const h = harness();
    h.fileSystem.failure = new Error("EPERM: operation not permitted");

    const result = await h.run();

    expect(result).toMatchObject({ success: false, errorCode: "trim_failed" });
    expect(result.error).toContain("EPERM: operation not permitted");
  });

  test("an app that is not running is refused before the foreground read", async () => {
    const h = harness({ process: null });

    expect(await h.run()).toMatchObject({ success: false, errorCode: "app_not_running" });
    expect(h.events).toEqual(["find"]);
    expect(h.fileSystem.calls).toEqual([]);
  });

  test("a missing or Android level is refused before any device read", async () => {
    const h = harness();

    expect(await h.lifecycle.execute(APP, "trimMemory", {})).toMatchObject({
      errorCode: "trim_level_required",
    });
    const android = await h.run(APP, "COMPLETE");
    expect(android).toMatchObject({ errorCode: "trim_level_not_applicable" });
    expect(android.error).toContain("memoryWarning");
    expect(
      await h.lifecycle.execute(APP, "background", { trimLevel: "memoryWarning" }),
    ).toMatchObject({ errorCode: "trim_level_not_applicable" });
    expect(h.events).toEqual([]);
  });

  test("a physical device keeps the unsupported refusal and touches nothing", async () => {
    const h = harness({ deviceId: PHONE });

    const result = await h.run();

    expect(result).toMatchObject({ success: false, supported: false, mechanism: "unsupported" });
    expect(h.events).toEqual([]);
    expect(h.fileSystem.calls).toEqual([]);
  });
});
