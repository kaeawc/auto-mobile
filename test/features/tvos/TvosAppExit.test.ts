import { FakeSimctl } from "../../fakes/FakeSimctl";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  TvosAppExit,
  TvosAppExitError,
  simulatorTvosAppLiveness,
} from "../../../src/features/tvos/TvosAppExit";
import { WebSocketTvosRunnerClient } from "../../../src/features/tvos/TvosRunnerClient";
import { TvosRunnerTimeoutError } from "../../../src/features/tvos/TvosRunnerTimeoutError";
import { SimctlCommandTimeoutError } from "../../../src/utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { IosSimulatorCrashReportFinder } from "../../../src/features/crashReports/IosSimulatorCrashReportFinder";
import { FakeTvosAppLiveness } from "../../fakes/FakeTvosAppLiveness";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWatchSocket } from "../../fakes/FakeWatchSocket";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";
import connected from "../../fixtures/tvos-xcuitest/tvos-runner-connected.json";

const reportPath = "CrashTv.ips";
const text = readFileSync(
  new URL("../../fixtures/ios-simctl/crash-report-crashtv-tvos26-5.ips", import.meta.url),
  "utf8",
);
const crashedAt = Date.parse("2026-11-11T13:50:28.877Z");
const bundleId = "dev.jasonpearson.automobile.crashtv";
const deviceId = "F7ACFDD0-2EF2-4A3B-B7DA-B3BA02F86BD6";

function fixture() {
  const timer = new FakeTimer();
  timer.setCurrentTime(crashedAt - 100);
  const socket = new FakeWatchSocket();
  const liveness = new FakeTvosAppLiveness();
  const finder = new IosSimulatorCrashReportFinder(
    deviceId,
    {
      readdir: async () => [{ name: reportPath }],
      stat: async () => ({ size: text.length, mtime: new Date(crashedAt), isFile: () => true }),
      readFileBuffer: async () => Buffer.from(text),
    },
    "/reports",
  );
  const appExit = new TvosAppExit({ liveness, finder, timer });
  const client = new WebSocketTvosRunnerClient("ws://fake/ws", {
    timer,
    factory: () => socket,
    foregroundApp: () => bundleId,
    appExit,
  });
  socket.receive(connected);
  return { client, timer, socket, liveness, finder, appExit };
}

const settle = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

test.each(["timeout", "disconnect"])(
  "%s with a dead app reports the captured crash through the real finder/parser",
  async (mode) => {
    const f = fixture();
    const pending = settle(f.client.request({ type: "request_press_button", action: "select" }));
    await drainMicrotasks(2);
    if (mode === "timeout") {
      f.timer.advanceTime(5000);
    } else {
      f.socket.disconnect();
    }
    const error = await pending;
    expect(error).toBeInstanceOf(TvosAppExitError);
    expect(error).toMatchObject({
      bundleId,
      commandType: "request_press_button",
      crashReport: { exceptionType: "EXC_BREAKPOINT (SIGTRAP)", processId: 80815 },
    });
    expect(String(error)).toContain(`App ${bundleId} exited during request_press_button`);
    expect(String(error)).toContain("crash report /reports/CrashTv.ips");
    expect(String(error)).toContain("launchApp");
    expect(f.client.isUsable()).toBe(false);
    expect(f.socket.sent).toHaveLength(1);
    expect(f.liveness.apps).toEqual([bundleId]);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
  },
);

test("timeout with the app alive preserves today's runner message", async () => {
  const f = fixture();
  f.liveness.running = true;
  const pending = settle(f.client.request({ type: "request_press_button", action: "select" }));
  await drainMicrotasks(2);
  f.timer.advanceTime(5000);
  const error = await pending;
  expect(error).toBeInstanceOf(TvosRunnerTimeoutError);
  expect(String(error)).toBe(String(new TvosRunnerTimeoutError("request_press_button", 5000)));
  expect(f.liveness.apps).toEqual([bundleId]);
});

test("an exited app with no fresh crash report is still an app exit", async () => {
  const f = fixture();
  f.timer.setCurrentTime(crashedAt + 10_000);
  const pending = settle(f.client.request({ type: "request_press_button", action: "select" }));
  await drainMicrotasks(2);
  f.timer.advanceTime(5000);
  const error = await pending;
  expect(error).toBeInstanceOf(TvosAppExitError);
  expect(error).toMatchObject({ crashReport: undefined });
  expect(String(error)).not.toContain("SIGTRAP");
});

test("probe failure preserves the runner error instead of claiming an app exit", async () => {
  const f = fixture();
  f.liveness.failure = new Error("simctl unavailable");
  const pending = settle(f.client.request({ type: "request_press_button", action: "select" }));
  await drainMicrotasks(2);
  f.socket.disconnect();
  expect(String(await pending)).toContain("Tvos runner connection failed");
  expect(f.liveness.apps).toEqual([bundleId]);
});

test("a timed-out probe retries once and reports an app exit when the retry finds no process", async () => {
  const f = fixture();
  const simctl = new FakeSimctl();
  simctl.setCommandArgsResultSequence(
    ["spawn", deviceId, "launchctl", "list"],
    [new SimctlCommandTimeoutError("host busy"), { stdout: "" }],
  );
  const appExit = new TvosAppExit({
    liveness: simulatorTvosAppLiveness(deviceId, simctl),
    finder: f.finder,
    timer: f.timer,
  });
  expect(await appExit.diagnose(bundleId, "request_press_button", crashedAt - 100)).toBeInstanceOf(
    TvosAppExitError,
  );
  expect(simctl.getMethodCalls("executeCommandArgs").map((call) => call.timeoutMs)).toEqual([
    4000, 4000,
  ]);
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
});

test("two timed-out probes return undefined and preserve the runner error path", async () => {
  const f = fixture();
  f.liveness.failure = new SimctlCommandTimeoutError("host busy");
  expect(
    await f.appExit.diagnose(bundleId, "request_press_button", crashedAt - 100),
  ).toBeUndefined();
  expect(f.liveness.apps).toEqual([bundleId, bundleId]);
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
});

test.each(["deadline", "caller abort"])("the retry remains bounded by %s", async (mode) => {
  const f = fixture();
  let calls = 0;
  let probeSignal: AbortSignal | undefined;
  f.liveness.isRunning = async (_appId, signal) => {
    calls += 1;
    probeSignal = signal;
    if (calls === 1) {
      await f.timer.sleep(4000);
      throw new SimctlCommandTimeoutError("host busy");
    }
    return new Promise(() => {});
  };
  const controller = new AbortController();
  const pending = settle(
    f.appExit.diagnose(bundleId, "request_press_button", crashedAt - 100, controller.signal),
  );
  f.timer.advanceTime(4000);
  await drainUntil(() => calls === 2, { description: "liveness retry" });
  f.timer.advanceTime(1999);
  expect(probeSignal?.aborted).toBe(false);
  if (mode === "deadline") {
    f.timer.advanceTime(1);
    expect(await pending).toBeUndefined();
  } else {
    controller.abort();
    expect(await pending).toBe(controller.signal.reason);
  }
  expect(probeSignal?.aborted).toBe(true);
  expect(calls).toBe(2);
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
});

test("a slow crash finder is bounded and retains the confirmed app exit", async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;
  f.finder.find = async (query) => {
    signal = query.signal;
    return new Promise(() => {});
  };
  const pending = settle(f.client.request({ type: "request_press_button", action: "select" }));
  await drainMicrotasks(2);
  f.socket.disconnect();
  await drainMicrotasks(20);
  f.timer.advanceTime(6000);
  expect(await pending).toBeInstanceOf(TvosAppExitError);
  expect(signal?.aborted).toBe(true);
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
});

test("explicit close and caller abort do not probe the app", async () => {
  const f = fixture();
  const pending = settle(f.client.hierarchy());
  await drainMicrotasks(2);
  f.client.close();
  expect(String(await pending)).toContain("runner closed");
  expect(f.liveness.apps).toHaveLength(0);
  const other = fixture();
  const controller = new AbortController();
  const aborted = settle(other.client.hierarchy(controller.signal));
  await drainMicrotasks(2);
  controller.abort();
  expect(await aborted).toBe(controller.signal.reason);
  expect(other.liveness.apps).toHaveLength(0);
  expect(other.client.isUsable()).toBe(true);
  other.client.close();
});

test("simulator liveness uses the captured launchctl listing and exact bundle identity", async () => {
  const simctl = new FakeSimctl();
  const args = ["spawn", deviceId, "launchctl", "list"];
  simctl.setCommandArgsResult(
    args,
    readFileSync(
      new URL("../../fixtures/ios-simctl/launchctl-list-crashtv-tvos26-5.txt", import.meta.url),
      "utf8",
    ),
  );
  const probe = simulatorTvosAppLiveness(deviceId, simctl);
  expect(await probe.isRunning(bundleId)).toBe(true);
  expect(simctl.getMethodCalls("executeCommandArgs")[0]?.timeoutMs).toBe(4000);
  expect(await probe.isRunning(`${bundleId}.other`)).toBe(false);
  simctl.setCommandArgsResult(args, `-\t5\tUIKitApplication:${bundleId}[2a7d][rb-legacy]`);
  expect(await probe.isRunning(bundleId)).toBe(false);
  simctl.setCommandArgsError(args, new Error("simctl failed"));
  await expect(probe.isRunning(bundleId)).rejects.toThrow("simctl failed");
});

test("a liveness probe that never settles is bounded without inventing an app exit", async () => {
  const f = fixture();
  f.liveness.isRunning = async () => new Promise(() => {});
  const pending = settle(f.client.hierarchy());
  await drainMicrotasks(2);
  f.socket.disconnect();
  await drainMicrotasks(20);
  f.timer.advanceTime(6000);
  expect(String(await pending)).toContain("Tvos runner connection failed");
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
});

test("caller cancellation during diagnosis aborts the lookup and preserves its reason", async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;
  f.finder.find = async (query) => {
    signal = query.signal;
    return new Promise(() => {});
  };
  const controller = new AbortController();
  const pending = settle(f.client.hierarchy(controller.signal));
  await drainMicrotasks(2);
  f.socket.disconnect();
  await drainMicrotasks(20);
  controller.abort();
  expect(await pending).toBe(controller.signal.reason);
  expect(signal?.aborted).toBe(true);
  expect(f.timer.getPendingTimeoutCount()).toBe(0);
});

test("a runner command rejection leaves the connection usable and never probes liveness", async () => {
  const f = fixture();
  const pending = settle(f.client.request({ type: "request_press_button", action: "select" }));
  await drainMicrotasks(2);
  f.socket.receive({
    type: "error",
    requestId: f.socket.sent[0]!.requestId,
    error: "no focused element",
    errorCode: "invalid_parameter",
  });
  expect(String(await pending)).toContain("no focused element");
  expect(f.client.isUsable()).toBe(true);
  expect(f.liveness.apps).toHaveLength(0);
  f.client.close();
});
