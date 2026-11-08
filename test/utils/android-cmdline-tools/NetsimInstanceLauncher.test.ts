import { expect, test } from "bun:test";
import { DefaultNetsimInstanceLauncher } from "../../../src/utils/android-cmdline-tools/NetsimInstanceLauncher";
import type { Random } from "../../../src/utils/Random";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntil } from "../../helpers/fakeTimerStepping";

function harness(platform: NodeJS.Platform = "linux") {
  const timer = new FakeTimer();
  const fs = new FakeFileSystem();
  const child = new FakeChildProcess(timer);
  const calls: { binary: string; args: string[] }[] = [];
  const random: Random = { next: () => 0, pick: (items) => items[0]! };
  const launcher = new DefaultNetsimInstanceLauncher({
    emulatorPath: () =>
      platform === "win32" ? "C:\\sdk\\emulator\\emulator.exe" : "/sdk/emulator/emulator",
    spawnFn: (binary, args) => {
      calls.push({ binary, args });
      return child;
    },
    timer,
    random,
    fs,
    tmpDir: "/netsim-test",
    platform,
  });
  return { timer, fs, child, calls, launcher };
}

test("starts the sibling netsimd, skips existing ini, and parses the captured grpc.port", async () => {
  const h = harness();
  h.fs.setFile("/netsim-test/netsim_100.ini", "grpc.port=53078");
  const started = h.launcher.start();
  expect(h.calls).toEqual([
    { binary: "/sdk/emulator/netsimd", args: ["-i", "101", "--no-web-ui"] },
  ]);
  // Verbatim ini line captured from emulator 37.1.11.0 in the task brief.
  h.fs.setFile("/netsim-test/netsim_101.ini", "grpc.port=53078");
  h.timer.advanceTime(100);
  const instance = await started;
  expect(instance).toMatchObject({ instance: 101, port: 53078, pid: h.child.pid });
  expect(h.timer.getSleepHistory()).toEqual([100]);
  instance.stop();
});

test("resolves netsimd.exe beside the Windows emulator", async () => {
  const h = harness("win32");
  const started = h.launcher.start();
  h.fs.setFile("/netsim-test/netsim_100.ini", "grpc.port=53078");
  h.timer.advanceTime(100);
  const instance = await started;
  expect(h.calls[0]?.binary).toBe("C:\\sdk\\emulator\\netsimd.exe");
  instance.stop();
});

test("times out using only FakeTimer and stops its child", async () => {
  const h = harness();
  h.timer.enableAutoAdvance();
  await expect(h.launcher.start()).rejects.toThrow("within 5 seconds");
  expect(h.child.killed).toBe(true);
  expect(h.timer.getSleepHistory()).toEqual(Array.from({ length: 50 }, () => 100));
  h.timer.reset();
});

test("stop is idempotent and targets only the recorded child and PID", async () => {
  const h = harness();
  const unrelated = new FakeChildProcess(h.timer);
  const killedPids: Array<number | undefined> = [];
  h.child.kill = () => {
    killedPids.push(h.child.pid);
    return true;
  };
  const started = h.launcher.start();
  const pid = h.child.pid;
  h.fs.setFile("/netsim-test/netsim_100.ini", "grpc.port=53078");
  h.timer.advanceTime(100);
  const instance = await started;
  instance.stop();
  instance.stop();
  expect(killedPids).toEqual([pid]);
  expect(unrelated.killed).toBe(false);
});

test("child spawn errors fail startup and stop the owned child", async () => {
  const h = harness();
  const started = h.launcher.start();
  h.child.emit("error", new Error("missing netsimd"));
  h.timer.advanceTime(100);
  await expect(started).rejects.toThrow("missing netsimd");
  expect(h.child.killed).toBe(true);
});

test("an exited netsimd is never signalled again", async () => {
  const h = harness();
  const started = h.launcher.start();
  h.fs.setFile("/netsim-test/netsim_100.ini", "grpc.port=53078");
  h.timer.advanceTime(100);
  const instance = await started;
  h.child.emit("exit", 0, null);
  instance.stop();
  expect(h.child.killed).toBe(false);
});

test("concurrent startups reserve distinct instances before ini publication", async () => {
  const h = harness();
  const first = h.launcher.start();
  const second = h.launcher.start();
  expect(h.calls.map((call) => call.args[1])).toEqual(["100", "101"]);
  h.fs.setFile("/netsim-test/netsim_100.ini", "grpc.port=53078");
  h.fs.setFile("/netsim-test/netsim_101.ini", "grpc.port=53078");
  h.timer.advanceTime(100);
  const instances = await Promise.all([first, second]);
  instances.forEach((instance) => instance.stop());
});

test("waits for ini publication with the injected timer", async () => {
  const h = harness();
  const started = h.launcher.start();
  await drainUntil(() => h.timer.getSleepHistory().length === 1, {
    description: "netsimd port poll",
  });
  h.fs.setFile("/netsim-test/netsim_100.ini", "grpc.port=53078");
  h.timer.advanceTime(100);
  (await started).stop();
});

for (const invalidPort of ["0", "65536", "53078garbage", "53078.5"]) {
  test(`does not accept an invalid gRPC port: ${invalidPort}`, async () => {
    const h = harness();
    const started = h.launcher.start();
    // Deliberately corrupt the captured line; these are invalid inputs, not captures.
    h.fs.setFile("/netsim-test/netsim_100.ini", "grpc.port=53078".replace("53078", invalidPort));
    h.timer.enableAutoAdvance();
    await expect(started).rejects.toThrow("within 5 seconds");
    expect(h.child.killed).toBe(true);
    expect(h.timer.getSleepHistory()).toHaveLength(50);
  });
}

test("file read failures stop the recorded child and surface an actionable error", async () => {
  const h = harness();
  h.fs.readFile = async () => {
    throw new Error("read refused");
  };
  const started = h.launcher.start();
  h.fs.setFile("/netsim-test/netsim_100.ini", "grpc.port=53078");
  h.timer.advanceTime(100);
  await expect(started).rejects.toThrow("Private netsimd startup failed: read refused");
  expect(h.child.killed).toBe(true);
});
