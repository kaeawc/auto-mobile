import { describe, expect, test } from "bun:test";
import { SimCtlScreenshot } from "../../../src/utils/ios-cmdline-tools/SimCtlScreenshot";
import { hiddenDynamicIslands } from "../../../src/utils/ios-cmdline-tools/SimulatorDynamicIsland";
import type { SimCtlScreenshotContext } from "../../../src/utils/ios-cmdline-tools/SimCtlScreenshot";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";

const UDID = "994D7AD5-32E6-43AA-BB3E-CE61A8D277A1";

function screenshotter(exitCode: number | Error) {
  const spawned: string[][] = [];
  const spawnProcess: SimCtlScreenshotContext["spawnProcess"] = (command, args) => {
    spawned.push([command, ...args]);
    const child = new FakeChildProcess();
    queueMicrotask(() =>
      exitCode instanceof Error ? child.emit("error", exitCode) : child.emit("close", exitCode),
    );
    return child;
  };
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const subject = new SimCtlScreenshot({
    timer,
    idGenerator: new CountingIdGenerator(),
    fileSystem: {
      mkdtemp: async () => "dir",
      writeFile: async () => {},
      readFile: async () => "",
      readFileBuffer: async () => Buffer.alloc(0),
      rm: async () => {},
    },
    spawnProcess,
  });
  return { subject, spawned };
}

describe("Dynamic Island kept hidden across simctl screenshots (#19018)", () => {
  test("a Simulator whose island was not hidden gets no command", async () => {
    hiddenDynamicIslands.set(UDID, false);
    const { subject, spawned } = screenshotter(0);

    await subject.keepDynamicIslandHidden(UDID);

    expect(spawned).toEqual([]);
  });

  test("a hidden island is written back after the capture reset it", async () => {
    hiddenDynamicIslands.set(UDID, true);
    const { subject, spawned } = screenshotter(0);

    await subject.keepDynamicIslandHidden(UDID);

    expect(spawned).toEqual([
      [
        "xcrun",
        "simctl",
        "spawn",
        UDID,
        "defaults",
        "write",
        "com.apple.springboard",
        "SBSuppressDynamicIslandCompletely",
        "-bool",
        "YES",
      ],
    ]);
    hiddenDynamicIslands.set(UDID, false);
  });

  test("a failed re-hide is logged and does not fail the capture", async () => {
    hiddenDynamicIslands.set(UDID, true);
    const { subject } = screenshotter(new Error("spawn xcrun ENOENT"));

    await subject.keepDynamicIslandHidden(UDID);

    hiddenDynamicIslands.set(UDID, false);
  });
});
