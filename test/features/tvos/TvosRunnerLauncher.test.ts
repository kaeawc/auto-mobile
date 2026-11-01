import { drainUntil } from "../../helpers/fakeTimerStepping";
import { afterEach, expect, test } from "bun:test";
import { XcodebuildTvosRunnerLauncher } from "../../../src/features/tvos/TvosRunnerLauncher";
import { tvosRunners } from "../../../src/features/tvos/TvosRunnerRegistry";
import { FakeTvosRunnerLauncher } from "../../fakes/FakeTvosRunnerLauncher";
import { FakeTvosRunnerClient } from "../../fakes/FakeTvosRunnerClient";
import type {
  Xcodebuild,
  XcodebuildStreamingOptions,
} from "../../../src/utils/ios-cmdline-tools/XcodebuildClient";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";

class FakeStreamingXcodebuild implements Pick<Xcodebuild, "startStreaming"> {
  readonly launches: Array<{ args: string[]; options?: XcodebuildStreamingOptions }> = [];

  constructor(readonly child = new FakeChildProcess()) {}

  async startStreaming(args: string[], options?: XcodebuildStreamingOptions) {
    this.launches.push({ args, options });
    return this.child;
  }
}

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});
const options = { deviceId: "tvos-launch", xctestrun: "/build/Tvos.xctestrun", port: 8765 };

test("launches only the service test with the requested port and binds the exact device", async () => {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const xcodebuild = new FakeStreamingXcodebuild(child);
  const client = new FakeTvosRunnerClient();
  const urls: string[] = [];
  const environments: Array<Record<string, string>> = [];
  const launcher = new XcodebuildTvosRunnerLauncher({
    writeRunnerEnvironment: async (file, env) => {
      environments.push(env);
      return file;
    },
    xcodebuild,
    timer,
    connect: (url) => {
      urls.push(url);
      return client;
    },
  });
  ({ stop } = await launcher.launch(options));
  const launch = xcodebuild.launches[0];
  expect(launch.args).toEqual([
    "test-without-building",
    "-xctestrun",
    options.xctestrun,
    "-destination",
    `platform=tvOS Simulator,id=${options.deviceId}`,
    "-only-testing:CtrlProxyTVUITests/CtrlProxyTVUITests/testRunService",
  ]);
  expect(launch.options?.env).toEqual({ ...process.env, TEST_RUNNER_AM_PORT: "8765" });
  expect(launch.options?.stdio).toBe("ignore");
  expect(launch.options?.signal).toBeUndefined();
  expect(environments).toEqual([{ AM_PORT: "8765" }]);
  expect(child.killed).toBe(false);
  expect(urls).toEqual(["ws://127.0.0.1:8765/ws"]);
  expect(tvosRunners.get(options.deviceId)).toBe(client);
  expect(timer.getSleepHistory()).toEqual([]);
  stop();
  expect(child.killed).toBe(true);
  expect(client.closed).toBe(true);
  expect(tvosRunners.get(options.deviceId)).toBeUndefined();
});

test("the fake launcher registers without creating a process", async () => {
  const launcher = new FakeTvosRunnerLauncher();
  ({ stop } = await launcher.launch(options));
  expect(launcher.launches).toEqual([options]);
  expect(tvosRunners.require(options.deviceId)).toBe(launcher.client);
});

test("process exit unregisters the runner", async () => {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const xcodebuild = new FakeStreamingXcodebuild(child);
  const client = new FakeTvosRunnerClient();
  ({ stop } = await new XcodebuildTvosRunnerLauncher({
    writeRunnerEnvironment: async (file) => file,
    xcodebuild,
    timer,
    connect: () => client,
  }).launch(options));
  child.simulateExit(1);
  timer.advanceTime(0);
  expect(tvosRunners.get(options.deviceId)).toBeUndefined();
  expect(client.closed).toBe(true);
});

test("rejects invalid ports and duplicate device bindings before spawning", async () => {
  const xcodebuild = new FakeStreamingXcodebuild();
  const launcher = new XcodebuildTvosRunnerLauncher({
    xcodebuild,
    writeRunnerEnvironment: async (file) => file,
  });
  await expect(launcher.launch({ ...options, port: 0 })).rejects.toThrow("port");
  ({ stop } = await new FakeTvosRunnerLauncher().launch(options));
  await expect(launcher.launch(options)).rejects.toThrow("already connected");
  expect(xcodebuild.launches).toEqual([]);
});

test("startup retries readiness with FakeTimer and closes failed clients", async () => {
  const timer = new FakeTimer();
  const xcodebuild = new FakeStreamingXcodebuild(new FakeChildProcess(timer));
  const first = new FakeTvosRunnerClient();
  first.failure = new Error("connection refused while starting");
  const ready = new FakeTvosRunnerClient();
  let attempts = 0;
  const pending = new XcodebuildTvosRunnerLauncher({
    writeRunnerEnvironment: async (file) => file,
    xcodebuild,
    timer,
    connect: () => (++attempts === 1 ? first : ready),
  }).launch(options);
  await drainUntil(() => timer.getSleepHistory().length === 1, { description: "startup backoff" });
  expect(tvosRunners.get(options.deviceId)).toBeUndefined();
  expect(first.closed).toBe(true);
  timer.advanceTime(100);
  ({ stop } = await pending);
  expect(attempts).toBe(2);
  expect(timer.getSleepHistory()).toEqual([100]);
  expect(tvosRunners.require(options.deviceId)).toBe(ready);
});

test("startup deadline stops only its fake process and cannot register a late runner", async () => {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const xcodebuild = new FakeStreamingXcodebuild(child);
  const client = new FakeTvosRunnerClient();
  client.failure = new Error("not ready");
  const pending = new XcodebuildTvosRunnerLauncher({
    writeRunnerEnvironment: async (file) => file,
    xcodebuild,
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
  expect(tvosRunners.get(options.deviceId)).toBeUndefined();
  expect(xcodebuild.launches).toHaveLength(1);
});

test("startup cancellation stops its child and cannot register after readiness resolves", async () => {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const xcodebuild = new FakeStreamingXcodebuild(child);
  const client = new FakeTvosRunnerClient();
  const ready = Promise.withResolvers<typeof client.tree>();
  client.hierarchy = async () => await ready.promise;
  const request = new AbortController();
  const pending = new XcodebuildTvosRunnerLauncher({
    xcodebuild,
    timer,
    connect: () => client,
    writeRunnerEnvironment: async (file) => file,
  }).launch({ ...options, signal: request.signal });
  const failure = pending.then(
    () => "connected",
    () => "cancelled",
  );
  await drainUntil(() => xcodebuild.launches.length === 1, { description: "runner spawn" });
  request.abort();
  expect(await failure).toBe("cancelled");
  ready.resolve(client.tree);
  await Promise.resolve();
  expect(child.killed).toBe(true);
  expect(client.closed).toBe(true);
  expect(tvosRunners.get(options.deviceId)).toBeUndefined();
  expect(xcodebuild.launches[0]?.options?.signal).toBeUndefined();
  expect(timer.getSleepHistory()).toEqual([]);
});
