import { describe, expect, test } from "bun:test";
import {
  IosStartupMeasurement,
  type IosStartupSimulator,
} from "../../../src/features/performance/IosStartupMeasurement";
import { ActionableError } from "../../../src/models/ActionableError";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";

const APP = "com.apple.Preferences";
const UDID = "DD830D62-ACB5-4AEC-BB2A-27EA007B9F27";
const fixtures = new URL("../../fixtures/ios-startup/", import.meta.url);
const [cold, warm, empty, coldLaunch, warmLaunch] = await Promise.all(
  [
    "log-show-cold-ios26.5.ndjson",
    "log-show-warm-ios26.5.ndjson",
    "log-show-empty-ios26.5.ndjson",
    "simctl-launch-cold.txt",
    "simctl-launch-warm.txt",
  ].map((name) => Bun.file(new URL(name, fixtures)).text()),
);

function setup(logs: string[], launches = [coldLaunch, warmLaunch], terminateError?: string) {
  const commands: string[][] = [];
  const timer = new FakeTimer();
  timer.setCurrentTime(0);
  timer.enableAutoAdvance();
  const simulator: IosStartupSimulator = {
    async executeCommandArgs(args) {
      commands.push(args);
      if (args[0] === "terminate" && terminateError) {
        throw new Error(terminateError);
      }
      if (args[0] === "spawn") {
        return createExecResult(logs.shift() ?? empty, "getpwuid_r: no record");
      }
      if (args[0] === "launch" && args[2] === APP) {
        return createExecResult(launches.shift() ?? "", "");
      }
      return createExecResult("", "");
    },
  };
  const measurement = new IosStartupMeasurement(UDID, simulator, timer, {
    preLaunchIdleMs: 500,
    sceneReadyTimeoutMs: 750,
    pollMs: 250,
  });
  return { commands, measurement, timer };
}

describe("iOS Simulator startup measurement", () => {
  test("terminates, idles and polls for a cold sample, ignoring an already stopped app", async () => {
    const { commands, measurement, timer } = setup(
      [empty, empty, cold],
      [coldLaunch],
      "Underlying error: found nothing to terminate",
    );
    const result = await measurement.measure({ appId: APP, mode: "cold", iterations: 1 });
    expect(result).toMatchObject({
      component: APP,
      ttid: { p50: 1557, samples: [1557] },
      launchState: ["COLD"],
      waitTimeMs: [],
      warnings: ["Simulator cannot evict caches; cold means the app process was terminated."],
    });
    expect(result.ttfd).toBeUndefined();
    expect(commands.map(([command]) => command)).toEqual([
      "terminate",
      "spawn",
      "launch",
      "spawn",
      "spawn",
    ]);
    expect(commands[3]).toEqual([
      "spawn",
      UDID,
      "log",
      "show",
      "--last",
      "30s",
      "--style",
      "ndjson",
      "--predicate",
      'subsystem == "com.apple.FrontBoard" AND (eventMessage CONTAINS "Received request to open" OR eventMessage CONTAINS "scene content state changed") AND eventMessage CONTAINS "com.apple.Preferences"',
    ]);
    expect(timer.now()).toBe(750);
  });

  test("primes once, goes Home, and ignores the previous launch while polling", async () => {
    const { commands, measurement } = setup([empty, cold, cold, cold, warm]);
    const result = await measurement.measure({ appId: APP, mode: "warm", iterations: 1 });
    expect(result.ttid.samples).toEqual([71]);
    expect(result.launchState).toEqual(["WARM"]);
    expect(result.warnings).toEqual([]);
    expect(commands.filter(([command]) => command !== "spawn")).toEqual([
      ["terminate", UDID, APP],
      ["launch", UDID, APP],
      ["launch", UDID, "com.apple.springboard"],
      ["launch", UDID, APP],
    ]);
  });

  test("warns when a requested warm launch gets a new PID", async () => {
    const { measurement } = setup([empty, cold, cold, warm], [coldLaunch, `${APP}: 13454\n`]);
    const result = await measurement.measure({ appId: APP, mode: "warm", iterations: 1 });
    expect(result.launchState).toEqual(["COLD"]);
    expect(result.warnings).toEqual([expect.stringContaining("other than WARM: COLD")]);
  });

  test("warns about missing ready events and retains the successful samples", async () => {
    const { measurement } = setup([empty, cold, cold, cold, cold, cold]);
    const result = await measurement.measure({ appId: APP, mode: "cold", iterations: 2 });
    expect(result.ttid.samples).toEqual([1557]);
    expect(result.warnings).toContain("1 of 2 launches logged no scene-ready event.");
  });

  test("fails when no scene is ready and propagates other termination errors", async () => {
    const request = { appId: APP, mode: "cold", iterations: 1 } as const;
    const missing = setup([empty]);
    await expect(missing.measurement.measure(request)).rejects.toThrow("No scene-ready log line");
    expect(missing.timer.now()).toBe(1250);
    await expect(setup([], [], "Invalid device").measurement.measure(request)).rejects.toThrow(
      "Simulator could not terminate com.apple.Preferences: Invalid device",
    );
  });

  test.each([
    { mode: "hot" },
    { mode: "cold", dropCaches: true },
    { mode: "cold", compilation: "speed" },
    { mode: "cold", waitForFullyDrawn: true },
    { mode: "cold", activity: ".Main" },
  ] as const)("refuses unsupported options %j before issuing commands", async (options) => {
    const { commands, measurement } = setup([]);
    await expect(measurement.measure({ appId: APP, ...options })).rejects.toBeInstanceOf(
      ActionableError,
    );
    expect(commands).toEqual([]);
  });
});
