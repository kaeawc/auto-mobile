import { describe, expect, test } from "bun:test";
import { LaunchctlWatchTargetAppProbe } from "../../../src/features/watch/WatchTargetAppProbe";
import type { BootedDevice } from "../../../src/models";
import { createExecResult } from "../../../src/utils/execResult";

const watch: BootedDevice = {
  name: "Apple Watch Series 11 (46mm)",
  deviceId: "AEC5C81F-B29B-4A0C-976A-6081F3617E1C",
  platform: "watchos",
};
const APP = "dev.dogfood.factorywatch";
const RUNNING = [
  "PID\tStatus\tLabel",
  `31543\t0\tUIKitApplication:${APP}[1f2e][rb-legacy]`,
  "211\t0\tcom.apple.Carousel",
].join("\n");
const EXITED = ["PID\tStatus\tLabel", "211\t0\tcom.apple.Carousel"].join("\n");

function arrange(result: string | Error, target: string | null = APP) {
  const calls: string[][] = [];
  const probe = new LaunchctlWatchTargetAppProbe({
    targetBundleId: () => target ?? undefined,
    simctl: () => ({
      executeCommandArgs: async (args) => {
        calls.push(args);
        if (result instanceof Error) {
          throw result;
        }
        return createExecResult(result, "");
      },
    }),
  });
  return { probe, calls };
}

describe("LaunchctlWatchTargetAppProbe (#18052)", () => {
  test("names the target app when launchctl lists no process for it", async () => {
    const { probe, calls } = arrange(EXITED);
    expect(await probe.notRunningTarget(watch)).toBe(APP);
    expect(calls).toEqual([["spawn", watch.deviceId, "launchctl", "list"]]);
  });

  test("returns undefined while the target app has a process", async () => {
    expect(await arrange(RUNNING).probe.notRunningTarget(watch)).toBeUndefined();
  });

  test("skips simctl when no target app is known", async () => {
    const { probe, calls } = arrange(EXITED, null);
    expect(await probe.notRunningTarget(watch)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("an empty or failed process list is not proof the app exited", async () => {
    expect(await arrange("").probe.notRunningTarget(watch)).toBeUndefined();
    expect(await arrange(new Error("simctl failed")).probe.notRunningTarget(watch)).toBeUndefined();
  });

  test("a cancelled read rethrows", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const { probe } = arrange(new Error("aborted"));
    await expect(probe.notRunningTarget(watch, controller.signal)).rejects.toThrow("aborted");
  });
});
