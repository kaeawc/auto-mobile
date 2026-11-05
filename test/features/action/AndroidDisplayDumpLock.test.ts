import { expect, test } from "bun:test";
import { readAndroidDisplayHierarchy } from "../../../src/features/action/AndroidHierarchyFallback";
import type { AdbExecuteOptions } from "../../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

const xml = `<?xml version="1.0"?><hierarchy rotation="0"><node package="com.test" class="Button" text="Row" bounds="[0,0][100,100]"/></hierarchy>`;

/** Holds every dump open until released, recording when each dump-and-read starts and ends. */
class GatedDumpAdb extends FakeAdbClient {
  readonly events: string[] = [];
  readonly gates: Array<() => void> = [];

  override async execute(args: string[], options?: AdbExecuteOptions) {
    const command = args.join(" ");
    if (command.includes("uiautomator dump")) {
      this.events.push(`dump ${args.at(-1)}`);
      await new Promise<void>((resolve) => this.gates.push(resolve));
    }
    const result = await super.execute(args, options);
    if (command.startsWith("shell cat ")) {
      this.events.push(`read ${args.at(-1)}`);
    }
    return result;
  }
}

function setup() {
  const adb = new GatedDumpAdb();
  adb.setCommandResult(
    "shell dumpsys display",
    `  Display id 2: DisplayInfo{"Overlay", real 1080 x 720, uniqueId "overlay:1"}`,
  );
  for (const id of ["a", "b"]) {
    adb.setCommandResult(`shell cat /data/local/tmp/automobile-hierarchy-${id}.xml`, xml);
  }
  const deps = {
    adb,
    timer: new FakeTimer(),
    idGenerator: new FakeIdGenerator(["a", "b"]),
    deviceId: "dump-lock-device",
  };
  return { adb, read: () => readAndroidDisplayHierarchy(2, deps, 10_000) };
}

test("overlapping display dumps on one device run one at a time", async () => {
  const { adb, read } = setup();
  const first = read();
  const second = read();
  await drainMicrotasks(50);
  expect(adb.events).toEqual(["dump /data/local/tmp/automobile-hierarchy-a.xml"]);
  adb.gates.shift()?.();
  await drainMicrotasks(50);
  expect(adb.events).toEqual([
    "dump /data/local/tmp/automobile-hierarchy-a.xml",
    "read /data/local/tmp/automobile-hierarchy-a.xml",
    "dump /data/local/tmp/automobile-hierarchy-b.xml",
  ]);
  adb.gates.shift()?.();
  const results = await Promise.all([first, second]);
  expect(results.map((result) => result.packageName)).toEqual(["com.test", "com.test"]);
});
