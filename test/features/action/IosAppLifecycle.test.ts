import { describe, expect, test } from "bun:test";
import type { BootedDevice, ExecResult } from "../../../src/models";
import { AppLifecycle } from "../../../src/features/action/AppLifecycle";
import {
  physicalAppProcessControl,
  simulatorAppProcessControl,
  type IosAppProcess,
  type IosAppProcessControl,
} from "../../../src/features/action/IosAppLifecycle";
import type { PhysicalIosAppCrasher } from "../../../src/utils/ios-cmdline-tools/PhysicalIosAppCrasher";
import { FakeTimer } from "../../fakes/FakeTimer";

const APP = "com.example.app";
const SIM = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const PHONE = "00008110-001A2B3C4D5E6F70";
const device = (deviceId: string): BootedDevice => ({ deviceId, name: "iPhone", platform: "ios" });
const noopInvalidator = { retireAppProcess: () => {}, invalidate: () => {} };

const exec = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value) => stdout.includes(value),
});

/** Scripted process table: each find() consumes one entry; the last repeats. */
function fakeControl(table: Array<IosAppProcess | null | undefined>) {
  const events: string[] = [];
  let reads = 0;
  const control: IosAppProcessControl = {
    find: async () => {
      events.push("find");
      return table[Math.min(reads++, table.length - 1)];
    },
    kill: async (_appId, process) => {
      events.push(`kill ${process.pid}`);
      return "signalled";
    },
  };
  return { control, events };
}

function harness(deviceId: string, control: IosAppProcessControl, homeError?: Error) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const events: string[] = [];
  const home = {
    calls: 0,
    execute: async () => {
      home.calls += 1;
      events.push("home");
      if (homeError) {
        throw homeError;
      }
    },
  };
  const mutations: number[] = [];
  const lifecycle = new AppLifecycle(device(deviceId), {
    timer,
    home,
    cacheInvalidator: noopInvalidator,
    iosProcesses: control,
  });
  return { lifecycle, home, events, mutations, onMutation: () => mutations.push(1) };
}

describe("iOS appLifecycle (#14098)", () => {
  test("background presses a verified Home and reports the app pid", async () => {
    const { control } = fakeControl([{ pid: 4242 }]);
    const h = harness(SIM, control);

    const result = await h.lifecycle.execute(APP, "background", { onMutation: h.onMutation });

    expect(result).toMatchObject({
      success: true,
      supported: true,
      platform: "ios",
      mechanism: "home",
      pid: 4242,
    });
    expect(h.home.calls).toBe(1);
    expect(h.mutations).toHaveLength(1);
  });

  test("killBackgrounded backgrounds, settles, SIGKILLs and confirms the pid is gone", async () => {
    const { control, events } = fakeControl([{ pid: 4242 }, { pid: 4242 }, null]);
    const h = harness(SIM, control);

    const result = await h.lifecycle.execute(APP, "killBackgrounded", {
      onMutation: h.onMutation,
    });

    expect(result).toMatchObject({
      success: true,
      mechanism: "ios-sigkill",
      pidBefore: 4242,
      pidAfter: null,
      processReclaimed: true,
    });
    // Initial lookup, re-lookup after the settle, the kill, then the reclaim check.
    expect(events).toEqual(["find", "find", "kill 4242", "find"]);
    expect(h.home.calls).toBe(1);
    expect(h.mutations).toHaveLength(2);
  });

  test("a process that survives SIGKILL is kill_failed, not success", async () => {
    const { control } = fakeControl([{ pid: 7 }]);
    const h = harness(SIM, control);

    const result = await h.lifecycle.execute(APP, "killBackgrounded", {});

    expect(result).toMatchObject({
      success: false,
      errorCode: "kill_failed",
      pidBefore: 7,
      pidAfter: 7,
      processReclaimed: false,
    });
  });

  test("a new pid after the kill counts as reclaimed", async () => {
    const { control } = fakeControl([{ pid: 7 }, { pid: 7 }, { pid: 7 }, { pid: 99 }]);
    const h = harness(SIM, control);

    expect(await h.lifecycle.execute(APP, "killBackgrounded", {})).toMatchObject({
      success: true,
      pidAfter: 99,
      processReclaimed: true,
    });
  });

  test("an app that is not running is refused before Home or any kill", async () => {
    const { control, events } = fakeControl([null]);
    const h = harness(SIM, control);

    expect(await h.lifecycle.execute(APP, "killBackgrounded", {})).toMatchObject({
      success: false,
      errorCode: "app_not_running",
      error: `${APP} is not running`,
    });
    expect(h.home.calls).toBe(0);
    expect(events).toEqual(["find"]);
  });

  test("an app that is not installed says so", async () => {
    const { control } = fakeControl([undefined]);
    const h = harness(PHONE, control);

    expect(await h.lifecycle.execute(APP, "background", {})).toMatchObject({
      success: false,
      errorCode: "app_not_running",
      error: expect.stringContaining("not installed"),
    });
  });

  test("an unverified Home press is background_not_verified and nothing is killed", async () => {
    const { control, events } = fakeControl([{ pid: 4242 }]);
    const h = harness(
      SIM,
      control,
      new Error("Home press did not bring SpringBoard to the foreground"),
    );

    const result = await h.lifecycle.execute(APP, "killBackgrounded", {});

    expect(result).toMatchObject({
      success: false,
      errorCode: "background_not_verified",
      pidBefore: 4242,
    });
    expect(events.some((event) => event.startsWith("kill"))).toBe(false);
  });

  test("an app that exits while backgrounding is not killed", async () => {
    const { control, events } = fakeControl([{ pid: 4242 }, null]);
    const h = harness(SIM, control);

    expect(await h.lifecycle.execute(APP, "killBackgrounded", {})).toMatchObject({
      success: false,
      errorCode: "app_not_running",
    });
    expect(events.some((event) => event.startsWith("kill"))).toBe(false);
  });

  test("a kill that lands after the process exited is reported, not claimed", async () => {
    const control: IosAppProcessControl = {
      find: async () => ({ pid: 5 }),
      kill: async () => "already_exited",
    };
    const h = harness(PHONE, control);

    expect(await h.lifecycle.execute(APP, "killBackgrounded", {})).toMatchObject({
      success: false,
      errorCode: "app_not_running",
    });
  });

  test("a failing kill command is kill_failed with its message", async () => {
    const control: IosAppProcessControl = {
      find: async () => ({ pid: 5 }),
      kill: async () => {
        throw new Error("launchctl: Could not find service");
      },
    };
    const h = harness(SIM, control);

    expect(await h.lifecycle.execute(APP, "killBackgrounded", {})).toMatchObject({
      success: false,
      errorCode: "kill_failed",
      error: "launchctl: Could not find service",
    });
  });

  test("trimMemory and malformed bundle ids are refused without touching the device", async () => {
    const { control, events } = fakeControl([{ pid: 1 }]);
    const h = harness(SIM, control);

    expect(await h.lifecycle.execute(APP, "trimMemory", { trimLevel: "COMPLETE" })).toMatchObject({
      success: false,
      supported: false,
      mechanism: "unsupported",
    });
    expect(await h.lifecycle.execute("bad id;", "background", {})).toMatchObject({
      success: false,
      errorCode: "invalid_app_id",
    });
    expect(events).toEqual([]);
    expect(h.home.calls).toBe(0);
  });

  test("an aborted request throws instead of reporting a result", async () => {
    const { control } = fakeControl([{ pid: 1 }]);
    const h = harness(SIM, control);
    const controller = new AbortController();
    controller.abort();

    await expect(
      h.lifecycle.execute(APP, "background", { signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe("iOS process controls (#14098)", () => {
  test("the Simulator control finds the app and kills it with launchctl SIGKILL", async () => {
    const calls: string[][] = [];
    const runner = {
      executeCommandArgs: async (args: string[]) => {
        calls.push(args);
        return exec(
          [
            "PID\tStatus\tLabel",
            "100\t0\tcom.apple.SpringBoard",
            `4242\t0\tUIKitApplication:${APP}[1a2b][rb-legacy]`,
            "4300\t0\tUIKitApplication:com.example.app.extra[3c4d][rb-legacy]",
          ].join("\n"),
        );
      },
    };
    const control = simulatorAppProcessControl(SIM, runner, () => 501);

    const found = await control.find(APP);
    expect(found).toEqual({ pid: 4242, serviceLabel: `UIKitApplication:${APP}[1a2b][rb-legacy]` });
    expect(await control.kill(APP, found!)).toBe("signalled");

    expect(calls[0]).toEqual(["spawn", SIM, "launchctl", "list"]);
    expect(calls[1]).toEqual([
      "spawn",
      SIM,
      "launchctl",
      "kill",
      "SIGKILL",
      `user/501/UIKitApplication:${APP}[1a2b][rb-legacy]`,
    ]);
  });

  test("the Simulator control reports an app with no process as not running", async () => {
    const runner = { executeCommandArgs: async () => exec("PID\tStatus\tLabel\n") };
    expect(await simulatorAppProcessControl(SIM, runner, () => 501).find(APP)).toBeNull();
  });

  test("the physical control maps devicectl lookups and sends SIGKILL by pid", async () => {
    const sent: number[] = [];
    const crasher: Pick<PhysicalIosAppCrasher, "findAppPid" | "sendKill"> = {
      findAppPid: async (bundleId) =>
        bundleId === "missing" ? undefined : bundleId === "stopped" ? null : 321,
      sendKill: async (pid) => {
        sent.push(pid);
        return "signalled";
      },
    };
    const control = physicalAppProcessControl(crasher);

    expect(await control.find(APP)).toEqual({ pid: 321 });
    expect(await control.find("stopped")).toBeNull();
    expect(await control.find("missing")).toBeUndefined();
    expect(await control.kill(APP, { pid: 321 })).toBe("signalled");
    expect(sent).toEqual([321]);
  });
});
