import { drainUntil } from "../../helpers/fakeTimerStepping";
import { afterEach, expect, test } from "bun:test";
import { XcodebuildWatchRunnerLauncher } from "../../../src/features/watch/WatchRunnerLauncher";
import { watchRunners } from "../../../src/features/watch/WatchRunnerRegistry";
import { FakeWatchRunnerLauncher } from "../../fakes/FakeWatchRunnerLauncher";
import { FakeWatchRunnerClient } from "../../fakes/FakeWatchRunnerClient";
import { FakeProcessExecutor } from "../../fakes/FakeProcessExecutor";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});
const options = { deviceId: "watch-launch", xctestrun: "/build/Watch.xctestrun", port: 8765 };

test("launches only the service test with the requested port and binds the exact device", async () => {
  const timer = new FakeTimer();
  const processes = new FakeProcessExecutor();
  const child = new FakeChildProcess(timer);
  processes.setNextSpawnProcess(child);
  const client = new FakeWatchRunnerClient();
  const urls: string[] = [];
  const launcher = new XcodebuildWatchRunnerLauncher({
    processes,
    timer,
    connect: (url) => {
      urls.push(url);
      return client;
    },
  });
  ({ stop } = await launcher.launch(options));
  const launch = processes.getSpawnedProcesses()[0];
  expect(launch.command).toBe("xcodebuild");
  expect(launch.args).toEqual([
    "test-without-building",
    "-xctestrun",
    options.xctestrun,
    "-destination",
    `platform=watchOS Simulator,id=${options.deviceId}`,
    "-only-testing:CtrlProxyWatchUITests/CtrlProxyWatchUITests/testRunService",
  ]);
  expect(launch.options?.env?.TEST_RUNNER_AM_PORT).toBe("8765");
  expect(urls).toEqual(["ws://127.0.0.1:8765/ws"]);
  expect(watchRunners.get(options.deviceId)).toBe(client);
  expect(timer.getSleepHistory()).toEqual([]);
  stop();
  expect(child.killed).toBe(true);
  expect(client.closed).toBe(true);
  expect(watchRunners.get(options.deviceId)).toBeUndefined();
});

test("the fake launcher registers without creating a process", async () => {
  const launcher = new FakeWatchRunnerLauncher();
  ({ stop } = await launcher.launch(options));
  expect(launcher.launches).toEqual([options]);
  expect(watchRunners.require(options.deviceId)).toBe(launcher.client);
});

test("process exit unregisters the runner", async () => {
  const timer = new FakeTimer();
  const processes = new FakeProcessExecutor();
  const child = new FakeChildProcess(timer);
  processes.setNextSpawnProcess(child);
  const client = new FakeWatchRunnerClient();
  ({ stop } = await new XcodebuildWatchRunnerLauncher({
    processes,
    timer,
    connect: () => client,
  }).launch(options));
  child.simulateExit(1);
  timer.advanceTime(0);
  expect(watchRunners.get(options.deviceId)).toBeUndefined();
  expect(client.closed).toBe(true);
});

test("rejects invalid ports and duplicate device bindings before spawning", async () => {
  const processes = new FakeProcessExecutor();
  const launcher = new XcodebuildWatchRunnerLauncher({ processes });
  await expect(launcher.launch({ ...options, port: 0 })).rejects.toThrow("port");
  ({ stop } = await new FakeWatchRunnerLauncher().launch(options));
  await expect(launcher.launch(options)).rejects.toThrow("already connected");
  expect(processes.getSpawnedProcesses()).toEqual([]);
});

test("startup retries readiness with FakeTimer and closes failed clients", async () => {
  const timer = new FakeTimer();
  const processes = new FakeProcessExecutor();
  processes.setNextSpawnProcess(new FakeChildProcess(timer));
  const first = new FakeWatchRunnerClient();
  first.failure = new Error("connection refused while starting");
  const ready = new FakeWatchRunnerClient();
  let attempts = 0;
  const pending = new XcodebuildWatchRunnerLauncher({
    processes,
    timer,
    connect: () => (++attempts === 1 ? first : ready),
  }).launch(options);
  await drainUntil(() => timer.getSleepHistory().length === 1, { description: "startup backoff" });
  expect(watchRunners.get(options.deviceId)).toBeUndefined();
  expect(first.closed).toBe(true);
  timer.advanceTime(100);
  ({ stop } = await pending);
  expect(attempts).toBe(2);
  expect(timer.getSleepHistory()).toEqual([100]);
  expect(watchRunners.require(options.deviceId)).toBe(ready);
});

test("startup deadline stops only its fake process and cannot register a late runner", async () => {
  const timer = new FakeTimer();
  const processes = new FakeProcessExecutor();
  const child = new FakeChildProcess(timer);
  processes.setNextSpawnProcess(child);
  const client = new FakeWatchRunnerClient();
  client.failure = new Error("not ready");
  const pending = new XcodebuildWatchRunnerLauncher({
    processes,
    timer,
    connect: () => client,
  }).launch(options);
  const failure = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  await drainUntil(() => timer.getSleepHistory().length === 1, { description: "startup retry" });
  timer.advanceTime(60_000);
  expect(String(await failure)).toContain("timed out");
  expect(client.closed).toBe(true);
  expect(child.killed).toBe(true);
  expect(watchRunners.get(options.deviceId)).toBeUndefined();
  expect(processes.getSpawnedProcesses()).toHaveLength(1);
});
