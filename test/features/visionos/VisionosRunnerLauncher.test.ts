import { drainUntil } from "../../helpers/fakeTimerStepping";
import { afterEach, expect, test } from "bun:test";
import { XcodebuildVisionosRunnerLauncher } from "../../../src/features/visionos/VisionosRunnerLauncher";
import { visionosRunners } from "../../../src/features/visionos/VisionosRunnerRegistry";
import { FakeVisionosRunnerLauncher } from "../../fakes/FakeVisionosRunnerLauncher";
import { FakeVisionosRunnerClient } from "../../fakes/FakeVisionosRunnerClient";
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
const options = { deviceId: "visionos-launch", xctestrun: "/build/Visionos.xctestrun", port: 8765 };

test("launches only the service test with the requested port and binds the exact device", async () => {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const xcodebuild = new FakeStreamingXcodebuild(child);
  const client = new FakeVisionosRunnerClient();
  const urls: string[] = [];
  const environments: Array<Record<string, string>> = [];
  const launcher = new XcodebuildVisionosRunnerLauncher({
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
    `platform=visionOS Simulator,id=${options.deviceId}`,
    "-only-testing:CtrlProxyVisionUITests/CtrlProxyVisionUITests/testRunService",
  ]);
  expect(launch.options?.env).toEqual({ ...process.env, TEST_RUNNER_AM_PORT: "8765" });
  expect(launch.options?.stdio).toEqual(["ignore", "pipe", "pipe"]);
  expect(launch.options?.signal).toBeUndefined();
  expect(environments).toEqual([{ AM_PORT: "8765" }]);
  expect(child.killed).toBe(false);
  expect(urls).toEqual(["ws://127.0.0.1:8765/ws"]);
  expect(visionosRunners.get(options.deviceId)).toBe(client);
  expect(client.connectedWaits).toBe(1);
  expect(client.commands).toEqual([]);
  expect(timer.getSleepHistory()).toEqual([]);
  stop();
  expect(child.killed).toBe(true);
  expect(client.closed).toBe(true);
  expect(visionosRunners.get(options.deviceId)).toBeUndefined();
});

test("passes the target bundle id to the runner environment", async () => {
  const xcodebuild = new FakeStreamingXcodebuild(new FakeChildProcess());
  const environments: Array<Record<string, string>> = [];
  const launcher = new XcodebuildVisionosRunnerLauncher({
    writeRunnerEnvironment: async (file, env) => {
      environments.push(env);
      return file;
    },
    xcodebuild,
    timer: new FakeTimer(),
    connect: () => new FakeVisionosRunnerClient(),
  });
  ({ stop } = await launcher.launch({
    ...options,
    deviceId: "visionos-bundle",
    bundleId: " com.example.app ",
  }));
  expect(environments).toEqual([{ AM_PORT: "8765", AM_BUNDLE_ID: "com.example.app" }]);
  expect(xcodebuild.launches[0].options?.env?.TEST_RUNNER_AM_BUNDLE_ID).toBe("com.example.app");
});

test("the fake launcher registers without creating a process", async () => {
  const launcher = new FakeVisionosRunnerLauncher();
  ({ stop } = await launcher.launch(options));
  expect(launcher.launches).toEqual([options]);
  expect(visionosRunners.require(options.deviceId)).toBe(launcher.client);
});

test("process exit unregisters the runner", async () => {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const xcodebuild = new FakeStreamingXcodebuild(child);
  const client = new FakeVisionosRunnerClient();
  ({ stop } = await new XcodebuildVisionosRunnerLauncher({
    writeRunnerEnvironment: async (file) => file,
    xcodebuild,
    timer,
    connect: () => client,
  }).launch(options));
  child.simulateExit(1);
  timer.advanceTime(0);
  expect(visionosRunners.get(options.deviceId)).toBeUndefined();
  expect(client.closed).toBe(true);
});

test("rejects invalid ports and duplicate device bindings before spawning", async () => {
  const xcodebuild = new FakeStreamingXcodebuild();
  const launcher = new XcodebuildVisionosRunnerLauncher({
    xcodebuild,
    writeRunnerEnvironment: async (file) => file,
  });
  await expect(launcher.launch({ ...options, port: 0 })).rejects.toThrow("port");
  ({ stop } = await new FakeVisionosRunnerLauncher().launch(options));
  await expect(launcher.launch(options)).rejects.toThrow("already connected");
  expect(xcodebuild.launches).toEqual([]);
});

test("startup retries readiness with FakeTimer and closes failed clients", async () => {
  const timer = new FakeTimer();
  const xcodebuild = new FakeStreamingXcodebuild(new FakeChildProcess(timer));
  const first = new FakeVisionosRunnerClient();
  first.failure = new Error("connection refused while starting");
  const ready = new FakeVisionosRunnerClient();
  let attempts = 0;
  const pending = new XcodebuildVisionosRunnerLauncher({
    writeRunnerEnvironment: async (file) => file,
    xcodebuild,
    timer,
    connect: () => (++attempts === 1 ? first : ready),
  }).launch(options);
  await drainUntil(() => timer.getSleepHistory().length === 1, { description: "startup backoff" });
  expect(visionosRunners.get(options.deviceId)).toBeUndefined();
  expect(first.closed).toBe(true);
  timer.advanceTime(100);
  ({ stop } = await pending);
  expect(attempts).toBe(2);
  expect(timer.getSleepHistory()).toEqual([100]);
  expect(visionosRunners.require(options.deviceId)).toBe(ready);
});

test("startup deadline stops only its fake process and cannot register a late runner", async () => {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const xcodebuild = new FakeStreamingXcodebuild(child);
  const client = new FakeVisionosRunnerClient();
  client.failure = new Error("not ready");
  const pending = new XcodebuildVisionosRunnerLauncher({
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
  expect(visionosRunners.get(options.deviceId)).toBeUndefined();
  expect(xcodebuild.launches).toHaveLength(1);
});

test("startup cancellation stops its child and cannot register after readiness resolves", async () => {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const xcodebuild = new FakeStreamingXcodebuild(child);
  const client = new FakeVisionosRunnerClient();
  const ready = Promise.withResolvers<void>();
  client.waitUntilConnected = async () => await ready.promise;
  const request = new AbortController();
  const pending = new XcodebuildVisionosRunnerLauncher({
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
  ready.resolve();
  await Promise.resolve();
  expect(child.killed).toBe(true);
  expect(client.closed).toBe(true);
  expect(visionosRunners.get(options.deviceId)).toBeUndefined();
  expect(xcodebuild.launches[0]?.options?.signal).toBeUndefined();
  expect(timer.getSleepHistory()).toEqual([]);
});

test("readiness waits on the handshake, not a slow system-app hierarchy (#17199)", async () => {
  // Issue #17199: against Safari the runner listened within ~5 s but its first hierarchy reply
  // took 8.2 s, so a hierarchy-based readiness check timed out on every retry until 60 s.
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const xcodebuild = new FakeStreamingXcodebuild(child);
  const client = new FakeVisionosRunnerClient();
  client.hierarchy = async () => {
    await timer.sleep(8200);
    return client.tree;
  };
  const pending = new XcodebuildVisionosRunnerLauncher({
    writeRunnerEnvironment: async (file) => file,
    xcodebuild,
    timer,
    connect: () => client,
  }).launch({ ...options, deviceId: "visionos-safari", bundleId: "com.apple.mobilesafari" });
  ({ stop } = await pending);
  expect(visionosRunners.require("visionos-safari")).toBe(client);
  expect(client.connectedWaits).toBe(1);
  expect(client.commands).toEqual([]);
  expect(timer.getSleepHistory()).toEqual([]);
  expect(timer.getPendingTimeoutCount()).toBe(0);
  expect(child.killed).toBe(false);
});

test("runner output is drained so a chatty xcodebuild cannot block on a full pipe", async () => {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const xcodebuild = new FakeStreamingXcodebuild(child);
  ({ stop } = await new XcodebuildVisionosRunnerLauncher({
    writeRunnerEnvironment: async (file) => file,
    xcodebuild,
    timer,
    connect: () => new FakeVisionosRunnerClient(),
  }).launch({ ...options, deviceId: "visionos-output" }));
  expect(child.stdout.listenerCount("data")).toBe(1);
  expect(child.stderr.listenerCount("data")).toBe(1);
});
