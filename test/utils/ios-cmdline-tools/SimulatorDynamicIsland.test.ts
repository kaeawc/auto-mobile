import { describe, expect, test } from "bun:test";
import { SimCtlScreenshot } from "../../../src/utils/ios-cmdline-tools/SimCtlScreenshot";
import {
  cachedDynamicIslandSupport,
  hiddenDynamicIslands,
} from "../../../src/utils/ios-cmdline-tools/SimulatorDynamicIsland";
import type { SimCtlScreenshotContext } from "../../../src/utils/ios-cmdline-tools/SimCtlScreenshot";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";

const UDID = "994D7AD5-32E6-43AA-BB3E-CE61A8D277A1";

function screenshotter(exitCode: number | Error) {
  const spawned: string[][] = [];
  const children: FakeChildProcess[] = [];
  const spawnProcess: SimCtlScreenshotContext["spawnProcess"] = (command, args) => {
    spawned.push([command, ...args]);
    const child = new FakeChildProcess();
    children.push(child);
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
  return { subject, spawned, children };
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

  test("a re-hide still running at the 5 s deadline is killed", async () => {
    hiddenDynamicIslands.set(UDID, true);
    const children: FakeChildProcess[] = [];
    const timer = new FakeTimer();
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
      spawnProcess: () => {
        const child = new FakeChildProcess();
        children.push(child);
        return child;
      },
    });

    const rehide = subject.keepDynamicIslandHidden(UDID);
    await Promise.resolve();
    timer.advanceTime(5_000);
    await rehide;

    expect(children).toHaveLength(1);
    expect(children[0]!.killed).toBe(true);
    hiddenDynamicIslands.set(UDID, false);
  });

  test("a re-hide that exited is not killed", async () => {
    hiddenDynamicIslands.set(UDID, true);
    const { subject, children } = screenshotter(0);

    await subject.keepDynamicIslandHidden(UDID);

    expect(children[0]!.killed).toBe(false);
    hiddenDynamicIslands.set(UDID, false);
  });

  test("a failed re-hide is logged and does not fail the capture", async () => {
    hiddenDynamicIslands.set(UDID, true);
    const { subject } = screenshotter(new Error("spawn xcrun ENOENT"));

    await subject.keepDynamicIslandHidden(UDID);

    hiddenDynamicIslands.set(UDID, false);
  });
});

describe("cachedDynamicIslandSupport (#19018)", () => {
  test("reads a UDID's capability once and does not keep a failed read", async () => {
    let reads = 0;
    let fail = true;
    const cached = cachedDynamicIslandSupport({
      supportsDynamicIsland: async () => {
        reads += 1;
        if (fail) {
          throw new Error("osascript timed out");
        }
        return false;
      },
    });
    const udid = "CACHE-0000-0000-0000-000000000001";

    await expect(cached.supportsDynamicIsland(udid)).rejects.toThrow("osascript timed out");
    fail = false;
    expect(await cached.supportsDynamicIsland(udid)).toBe(false);
    expect(await cached.supportsDynamicIsland(udid)).toBe(false);
    expect(reads).toBe(2);
  });
});
