import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AndroidStartupMeasurement,
  DEFAULT_STARTUP_MEASUREMENT_TIMING,
} from "../../../src/features/performance/AndroidStartupMeasurement";
import { parseResumedActivityForDisplay } from "../../../src/utils/android-cmdline-tools/parseResumedActivity";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

const APP = "dev.l18722.dbg";
const ACTIVITY = "dev.l18722.Main";
const COMPONENT = `${APP}/${ACTIVITY}`;
const DEVICE_TIMESTAMP_MS = 1795080632539;
const DUMPSYS_ACTIVITIES = "shell dumpsys activity activities";
const SETTINGS_RESUMED =
  "    topResumedActivity=ActivityRecord{139507919 u0 com.android.settings/.Settings t13}";
const TARGET_RESUMED = SETTINGS_RESUMED.replace("com.android.settings/.Settings", COMPONENT);

function fixture(name: string): string {
  return readFileSync(path.join(import.meta.dir, "../../fixtures/android-startup", name), "utf8");
}

function amStart(launchState: string, totalTimeMs: number): string {
  return [
    "Status: ok",
    `LaunchState: ${launchState}`,
    `Activity: ${COMPONENT}`,
    `TotalTime: ${totalTimeMs}`,
    `WaitTime: ${totalTimeMs + 8}`,
    "Complete",
  ].join("\n");
}

let adb: FakeAdbExecutor;
let timer: FakeTimer;
let measurement: AndroidStartupMeasurement;

beforeEach(() => {
  adb = new FakeAdbExecutor();
  timer = new FakeTimer();
  timer.enableAutoAdvance();
  adb.setDeviceTimestampMs(DEVICE_TIMESTAMP_MS);
  adb.setCommandResponse(
    "resolve-activity",
    createExecResult(fixture("resolve-activity-launcher.txt"), ""),
  );
  measurement = new AndroidStartupMeasurement(adb, timer);
});

function commandsMatching(pattern: string): string[] {
  return adb.getExecutedCommands().filter((command) => command.includes(pattern));
}

describe("AndroidStartupMeasurement", () => {
  test("reads the package from a captured top-resumed activity record", () => {
    expect(parseResumedActivityForDisplay(SETTINGS_RESUMED).activity?.packageName).toBe(
      "com.android.settings",
    );
  });

  test("cold: force-stops before every launch and summarizes TotalTime", async () => {
    adb.setCommandResponseSequence(
      "am start -W",
      [1300, 1100, 1200].map((ms) => createExecResult(amStart("COLD", ms), "")),
    );

    const result = await measurement.measure({ appId: APP, mode: "cold", iterations: 3 });

    expect(result.component).toBe(COMPONENT);
    expect(result.ttid).toEqual({
      min: 1100,
      p50: 1200,
      p90: 1280,
      max: 1300,
      samples: [1300, 1100, 1200],
    });
    expect(result.launchState).toEqual(["COLD", "COLD", "COLD"]);
    expect(result.waitTimeMs).toEqual([1308, 1108, 1208]);
    expect(commandsMatching("am force-stop")).toHaveLength(3);
    expect(commandsMatching("am start -W")).toHaveLength(3);
    expect(commandsMatching("--activity-clear-task")).toEqual([]);
    expect(commandsMatching(DUMPSYS_ACTIVITIES)).toEqual([]);
  });

  test.each(["hot", "warm"] as const)(
    "%s: waits for HOME to move the target out of the foreground before launching",
    async (mode) => {
      const launchSleepHistories: number[][] = [];
      measurement = new AndroidStartupMeasurement(
        {
          async executeCommand(command, options) {
            if (command.includes("am start -W")) {
              launchSleepHistories.push(timer.getSleepHistory());
            }
            return adb.executeCommand(command, options);
          },
          getDeviceTimestampMs: () => adb.getDeviceTimestampMs(),
        },
        timer,
      );
      adb.setCommandResponseSequence(
        DUMPSYS_ACTIVITIES,
        [TARGET_RESUMED, TARGET_RESUMED, SETTINGS_RESUMED].map((out) => createExecResult(out, "")),
      );
      adb.setCommandResponseSequence(
        "am start -W",
        [amStart("COLD", 1300), amStart(mode.toUpperCase(), 128)].map((out) =>
          createExecResult(out, ""),
        ),
      );

      const result = await measurement.measure({ appId: APP, mode, iterations: 1 });

      expect(result.ttid.samples).toEqual([128]);
      expect(launchSleepHistories).toEqual([[], [1500, 250, 250, 500]]);
      expect(
        adb
          .getExecutedCommands()
          .filter(
            (command) =>
              command.includes("KEYCODE_HOME") ||
              command.includes(DUMPSYS_ACTIVITIES) ||
              command.includes("am start -W"),
          )
          .map((command) => command.split(" ").slice(0, 4).join(" ")),
      ).toEqual([
        "shell am start -W",
        "shell input keyevent KEYCODE_HOME",
        DUMPSYS_ACTIVITIES,
        DUMPSYS_ACTIVITIES,
        DUMPSYS_ACTIVITIES,
        "shell am start -W",
      ]);
    },
  );

  test("hot: continues with the measured launch when HOME settling times out", async () => {
    adb.setCommandResponse(DUMPSYS_ACTIVITIES, createExecResult(TARGET_RESUMED, ""));
    adb.setCommandResponse("am start -W", createExecResult(amStart("HOT", 128), ""));

    const result = await measurement.measure({ appId: APP, mode: "hot", iterations: 1 });

    expect(result.ttid.samples).toEqual([128]);
    expect(commandsMatching(DUMPSYS_ACTIVITIES)).toHaveLength(20);
    const polls = adb.getCommandCalls().filter(({ command }) => command === DUMPSYS_ACTIVITIES);
    expect(polls[0]?.timeoutMs).toBe(5000);
    expect(polls.at(-1)?.timeoutMs).toBe(250);
    expect(timer.getSleepHistory()).toEqual([1500, ...Array<number>(20).fill(250), 500, 1500]);
  });

  test("warm: primes once, then recreates the activity in the live process", async () => {
    adb.setCommandResponseSequence(
      "am start -W",
      ["cold", "warm", "warm"].map((state) =>
        createExecResult(fixture(`am-start-W-${state}-api35.txt`), ""),
      ),
    );

    const result = await measurement.measure({ appId: APP, mode: "warm", iterations: 2 });

    expect(result.launchState).toEqual(["WARM", "WARM"]);
    expect(result.ttid.samples).toEqual([75, 75]);
    expect(commandsMatching("am force-stop")).toHaveLength(1);
    expect(commandsMatching("--activity-clear-task")).toHaveLength(2);
    expect(commandsMatching("KEYCODE_HOME")).toHaveLength(2);
  });

  test("hot: goes home and relaunches without clearing the task", async () => {
    adb.setCommandResponseSequence(
      "am start -W",
      ["cold", "hot", "hot"].map((state) =>
        createExecResult(fixture(`am-start-W-${state}-api35.txt`), ""),
      ),
    );

    const result = await measurement.measure({ appId: APP, mode: "hot", iterations: 2 });

    expect(result.ttid.samples).toEqual([86, 86]);
    expect(result.warnings.filter((w) => w.includes("launch state"))).toEqual([]);
    expect(commandsMatching("--activity-clear-task")).toEqual([]);
  });

  test("warns when a launch reports a different state than the mode asked for", async () => {
    adb.setCommandResponseSequence(
      "am start -W",
      ["cold", "warm"].map((state) =>
        createExecResult(fixture(`am-start-W-${state}-api35.txt`), ""),
      ),
    );

    const result = await measurement.measure({ appId: APP, mode: "hot", iterations: 1 });

    expect(result.warnings).toContain(
      "1 of 1 launches reported a launch state other than HOT: WARM.",
    );
  });

  test("reports TTFD from Fully drawn when the app calls reportFullyDrawn", async () => {
    adb.setCommandResponse(
      "am start -W",
      createExecResult(fixture("am-start-W-cold-api35.txt"), ""),
    );
    adb.setCommandResponse(
      "logcat -d",
      createExecResult(fixture("logcat-fully-drawn-api35.txt"), ""),
    );

    const result = await measurement.measure({
      appId: APP,
      mode: "cold",
      iterations: 2,
      waitForFullyDrawn: true,
    });

    expect(result.ttid.samples).toEqual([457, 457]);
    expect(result.waitTimeMs).toEqual([461, 461]);
    expect(result.ttfd?.samples).toEqual([1781, 1781]);
    expect(result.warnings).toEqual([]);
    expect(commandsMatching("logcat -d")[0]).toContain("-T '1795080632.539'");
  });

  test("omits TTFD with a warning after polling until the timeout when none is logged", async () => {
    adb.setCommandResponse(
      "am start -W",
      createExecResult(fixture("am-start-W-cold-api35.txt"), ""),
    );

    const result = await measurement.measure({
      appId: APP,
      mode: "cold",
      iterations: 1,
      waitForFullyDrawn: true,
    });

    expect(result.ttfd).toBeUndefined();
    expect(result.warnings[0]).toContain('No "Fully drawn" report within 10000 ms');
    const polls =
      DEFAULT_STARTUP_MEASUREMENT_TIMING.fullyDrawnTimeoutMs /
      DEFAULT_STARTUP_MEASUREMENT_TIMING.fullyDrawnPollMs;
    expect(commandsMatching("logcat -d")).toHaveLength(polls + 1);
  });

  test("reads logcat once per launch, without polling, when not waiting for Fully drawn", async () => {
    adb.setCommandResponse(
      "am start -W",
      createExecResult(fixture("am-start-W-cold-api35.txt"), ""),
    );

    const result = await measurement.measure({ appId: APP, mode: "cold", iterations: 2 });

    expect(result.ttfd).toBeUndefined();
    expect(result.warnings[0]).toContain("Set waitForFullyDrawn");
    expect(commandsMatching("logcat -d")).toHaveLength(2);
  });

  test.each([ACTIVITY, ".Main"])(
    "uses explicit activity %s without resolving the launcher",
    async (activity) => {
      const component = `${APP}/${activity}`;
      adb.setCommandResponse(
        "am start -W",
        createExecResult(fixture("am-start-W-cold-api35.txt").replaceAll(COMPONENT, component), ""),
      );

      const result = await measurement.measure({
        appId: APP,
        activity,
        mode: "cold",
        iterations: 1,
      });

      expect(result.component).toBe(component);
      expect(commandsMatching("resolve-activity")).toEqual([]);
    },
  );

  test("recompiles before measuring and fails loudly when compile fails", async () => {
    adb.setCommandResponse(
      "am start -W",
      createExecResult(fixture("am-start-W-cold-api35.txt"), ""),
    );
    adb.setCommandResponse("cmd package compile", createExecResult("Success\n", ""));

    await measurement.measure({ appId: APP, mode: "cold", iterations: 1, compilation: "speed" });
    expect(commandsMatching("cmd package compile")).toEqual([
      `shell cmd package compile -m speed -f '${APP}'`,
    ]);

    adb.setCommandResponse(
      "cmd package compile",
      createExecResult("Failure: package not found\n", ""),
    );
    await expect(
      measurement.measure({ appId: APP, mode: "cold", iterations: 1, compilation: "speed" }),
    ).rejects.toThrow("cmd package compile -m speed failed");
  });

  test("drops caches through the root shell before every cold launch", async () => {
    adb.setCommandResponse(
      "am start -W",
      createExecResult(fixture("am-start-W-cold-api35.txt"), ""),
    );
    adb.setCommandResponse("shell id", createExecResult("uid=0(root) gid=0(root)\n", ""));

    await measurement.measure({ appId: APP, mode: "cold", iterations: 2, dropCaches: true });

    expect(commandsMatching("drop_caches")).toEqual([
      "shell sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'",
      "shell sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'",
    ]);
  });

  test("refuses dropCaches without a root shell, before launching anything", async () => {
    adb.setCommandResponse("shell id", createExecResult("uid=2000(shell) gid=2000(shell)\n", ""));
    adb.setCommandResponse(
      "su 0 id",
      createExecResult("", "/system/bin/sh: su: inaccessible or not found"),
    );

    await expect(
      measurement.measure({ appId: APP, mode: "cold", dropCaches: true }),
    ).rejects.toThrow("dropCaches needs a root shell");
    expect(commandsMatching("am start")).toEqual([]);
  });

  test("refuses dropCaches for warm and hot starts", async () => {
    await expect(
      measurement.measure({ appId: APP, mode: "warm", dropCaches: true }),
    ).rejects.toThrow("dropCaches only applies to cold starts");
  });

  test("fails when no launch reported a TotalTime", async () => {
    adb.setCommandResponse(
      "am start -W",
      createExecResult(fixture("am-start-W-already-top-api35.txt"), ""),
    );

    await expect(measurement.measure({ appId: APP, mode: "cold", iterations: 2 })).rejects.toThrow(
      "reported no TotalTime",
    );
  });

  test("excludes an already-on-top launch from the TTID samples and warns", async () => {
    adb.setCommandResponseSequence("am start -W", [
      createExecResult(fixture("am-start-W-cold-api35.txt"), ""),
      createExecResult(fixture("am-start-W-already-top-api35.txt"), ""),
    ]);

    const result = await measurement.measure({ appId: APP, mode: "cold", iterations: 2 });

    expect(result.ttid.min).toBeGreaterThan(0);
    expect(result.warnings).toContain("1 of 2 launches reported no TotalTime.");
  });

  test("surfaces an am start error", async () => {
    adb.setCommandResponse(
      "am start -W",
      createExecResult("Error type 3\nError: Activity class {x} does not exist.\n", ""),
    );

    await expect(measurement.measure({ appId: APP, mode: "cold", iterations: 1 })).rejects.toThrow(
      "am start failed",
    );
  });

  test("fails when the app has no launcher activity", async () => {
    adb.setCommandResponse("resolve-activity", createExecResult("No activity found\n", ""));

    await expect(measurement.measure({ appId: APP, mode: "cold" })).rejects.toThrow(
      "No launcher activity",
    );
  });

  test("defaults to five iterations", async () => {
    adb.setCommandResponse(
      "am start -W",
      createExecResult(fixture("am-start-W-cold-api35.txt"), ""),
    );

    const result = await measurement.measure({ appId: APP, mode: "cold" });

    expect(result.iterations).toBe(5);
  });

  test("stops between iterations once aborted", async () => {
    adb.setCommandResponse(
      "am start -W",
      createExecResult(fixture("am-start-W-cold-api35.txt"), ""),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      measurement.measure({ appId: APP, mode: "cold" }, controller.signal),
    ).rejects.toThrow();
    expect(commandsMatching("am start")).toEqual([]);
  });
});
