import { EventEmitter } from "node:events";
import { afterEach, expect, spyOn, test } from "bun:test";
import * as healthProbe from "../../src/db/DatabaseHealthProbe";
import type { ProbeWorker, ProbeWorkerMessage } from "../../src/db/DatabaseHealthProbe";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

class FakeWorker extends EventEmitter implements ProbeWorker {
  requests: Array<{ id: number }> = [];
  terminateCalls = 0;
  answerImmediately = true;
  private ready = false;
  termination: Promise<number> = Promise.resolve(0);

  postMessage(request: { id: number }): void {
    this.requests.push(request);
    if (this.ready && this.answerImmediately) {
      this.message({ id: request.id, ok: true });
    }
  }

  message(message: ProbeWorkerMessage): void {
    if ("type" in message && message.type === "ready") {
      this.ready = true;
    }
    this.emit("message", message);
  }

  terminate(): Promise<number> {
    this.terminateCalls++;
    return this.termination;
  }
}

const probes: healthProbe.DefaultDatabaseHealthProbe[] = [];
afterEach(async () => {
  await Promise.all(probes.splice(0).map((probe) => probe.dispose()));
});

function setup(initTimeoutMs?: number) {
  const timer = new FakeTimer();
  const workers: FakeWorker[] = [];
  const probe = new healthProbe.DefaultDatabaseHealthProbe({
    timer,
    initTimeoutMs,
    getMigrationsError: () => null,
    getDatabasePath: () => "/fake/health-probe.db",
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  probes.push(probe);
  return { timer, workers, probe };
}

function observe(promise: Promise<void>) {
  const observation = { settled: false, result: Promise.resolve<unknown>(undefined) };
  observation.result = promise.then(
    () => {
      observation.settled = true;
      return undefined;
    },
    (error: unknown) => {
      observation.settled = true;
      return error;
    },
  );
  return observation;
}

test("1500ms cold start succeeds and three warm daemon ticks reuse one worker", async () => {
  const { timer, workers, probe } = setup();
  const first = observe(probe.check());
  expect(workers[0]!.requests).toHaveLength(0);
  await timer.advanceTimersByTimeAsync(1500);
  expect(first.settled).toBe(false);
  workers[0]!.message({ type: "ready" });
  expect(await first.result).toBeUndefined();
  for (let tick = 0; tick < 3; tick++) {
    timer.advanceTime(30000);
    await probe.check();
  }
  expect(workers).toHaveLength(1);
  expect(workers[0]!.requests).toHaveLength(4);
  expect(workers[0]!.terminateCalls).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("clean exit after a successful check starts a fresh worker without a timeout", async () => {
  const { timer, workers, probe } = setup();
  const first = observe(probe.check());
  workers[0]!.message({ type: "ready" });
  expect(await first.result).toBeUndefined();
  workers[0]!.answerImmediately = false;
  workers[0]!.emit("exit", 0);

  const next = observe(probe.check());
  expect(workers).toHaveLength(2);
  expect(workers[1]!.requests).toHaveLength(0);
  workers[1]!.message({ type: "ready" });
  expect(await next.result).toBeUndefined();
  expect(workers[0]!.requests).toHaveLength(1);
  expect(timer.now()).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("clean exit while a request is pending rejects without a timeout", async () => {
  const { timer, workers, probe } = setup();
  const check = observe(probe.check());
  workers[0]!.answerImmediately = false;
  workers[0]!.message({ type: "ready" });
  await drainUntilQuiescent(timer);
  expect(workers[0]!.requests).toHaveLength(1);
  expect(check.settled).toBe(false);

  workers[0]!.emit("exit", 0);
  await drainUntilQuiescent(timer);
  expect(check.settled).toBe(true);
  const error = await check.result;
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(healthProbe.DatabaseHealthProbeTimeoutError);
  expect(error).toMatchObject({ message: "Database health probe worker exited with code 0" });
  expect(timer.now()).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("never-ready worker uses the default 10000ms init budget and is replaced", async () => {
  const { timer, workers, probe } = setup();
  const first = observe(probe.check());
  await timer.advanceTimersByTimeAsync(9999);
  await drainUntilQuiescent(timer);
  expect(first.settled).toBe(false);
  timer.advanceTime(1);
  const error = await first.result;
  expect(error).toBeInstanceOf(healthProbe.DatabaseHealthProbeInitTimeoutError);
  expect(error).toBeInstanceOf(healthProbe.DatabaseHealthProbeTimeoutError);
  expect(error).toMatchObject({
    phase: "init",
    timeoutMs: 10000,
    message: "Database health probe worker did not become ready within 10000ms",
  });
  expect(workers[0]!.terminateCalls).toBe(1);
  const next = observe(probe.check());
  expect(workers).toHaveLength(2);
  expect(workers[1]!.requests).toHaveLength(0);
  workers[1]!.message({ type: "ready" });
  expect(await next.result).toBeUndefined();
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("query timeout records 1500ms of worker readiness before the SQL deadline", async () => {
  const { timer, workers, probe } = setup();
  const check = observe(probe.check());
  workers[0]!.answerImmediately = false;
  timer.advanceTime(1500);
  workers[0]!.message({ type: "ready" });
  await drainUntilQuiescent(timer);
  expect(workers[0]!.requests).toHaveLength(1);
  timer.advanceTime(1000);
  expect(await check.result).toMatchObject({
    phase: "query",
    timeoutMs: 1000,
    startupMs: 1500,
  });
  expect(workers[0]!.terminateCalls).toBe(1);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("worker error after ready but before posting rejects without waiting for a timeout", async () => {
  const { timer, workers, probe } = setup();
  const check = observe(probe.check());
  workers[0]!.message({ type: "ready" });
  workers[0]!.emit("error", new Error("worker died before receiving SELECT"));
  const error = await check.result;
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(healthProbe.DatabaseHealthProbeTimeoutError);
  expect(error).toMatchObject({ message: "Database health probe worker is no longer available" });
  expect(workers[0]!.requests).toHaveLength(0);
  expect(timer.now()).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
  const next = observe(probe.check());
  expect(workers).toHaveLength(2);
  workers[1]!.message({ type: "ready" });
  expect(await next.result).toBeUndefined();
});

test("configured init timeout logs the elapsed budget and readiness duration", async () => {
  const { timer, workers, probe } = setup(2000);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  try {
    const first = observe(probe.check());
    timer.advanceTime(2000);
    expect(await first.result).toMatchObject({ phase: "init", timeoutMs: 2000 });
    expect(warn.mock.calls.flat().join(" ")).toContain("2000ms");
    const next = observe(probe.check());
    timer.advanceTime(1500);
    workers[1]!.message({ type: "ready" });
    expect(await next.result).toBeUndefined();
    expect(debug.mock.calls.flat().join(" ")).toContain("1500ms");
  } finally {
    warn.mockRestore();
    debug.mockRestore();
  }
});

test.each([0, 1500])("slow query gets exactly 1000ms after %ims startup", async (startupMs) => {
  const { timer, workers, probe } = setup();
  const check = observe(probe.check());
  workers[0]!.answerImmediately = false;
  await timer.advanceTimersByTimeAsync(startupMs);
  await drainUntilQuiescent(timer);
  expect(check.settled).toBe(false);
  workers[0]!.message({ type: "ready" });
  await drainUntilQuiescent(timer);
  expect(workers[0]!.requests).toHaveLength(1);
  timer.advanceTime(999);
  await drainUntilQuiescent(timer);
  expect(check.settled).toBe(false);
  timer.advanceTime(1);
  const error = await check.result;
  expect(error).toBeInstanceOf(healthProbe.DatabaseHealthProbeTimeoutError);
  expect(error).toMatchObject({ phase: "query", timeoutMs: 1000 });
  expect(timer.now()).toBe(startupMs + 1000);
  expect(workers[0]!.terminateCalls).toBe(1);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test.each(["error", "exit"] as const)(
  "worker %s before ready rejects immediately and is replaced",
  async (event) => {
    const { timer, workers, probe } = setup();
    const check = observe(probe.check());
    const failure = new Error("worker failed to open sqlite");
    if (event === "error") {
      workers[0]!.emit("error", failure);
    } else {
      workers[0]!.emit("exit", 1);
    }
    await drainUntilQuiescent(timer);
    expect(check.settled).toBe(true);
    const error = await check.result;
    if (event === "error") {
      expect(error).toBe(failure);
    } else {
      expect(error).toMatchObject({ message: "Database health probe worker exited with code 1" });
    }
    expect(timer.now()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    const next = observe(probe.check());
    expect(workers).toHaveLength(2);
    expect(workers[1]!.requests).toHaveLength(0);
    workers[1]!.message({ type: "ready" });
    expect(await next.result).toBeUndefined();
  },
);

test("SQLite error response after ready preserves the message and stack", async () => {
  const { timer, workers, probe } = setup();
  const check = observe(probe.check());
  workers[0]!.answerImmediately = false;
  workers[0]!.message({ type: "ready" });
  await drainUntilQuiescent(timer);
  workers[0]!.message({
    id: workers[0]!.requests[0]!.id,
    ok: false,
    message: "database disk image is malformed",
    stack: "sqlite stack",
  });
  const error = await check.result;
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(healthProbe.DatabaseHealthProbeTimeoutError);
  expect(error).toMatchObject({
    message: "database disk image is malformed",
    stack: "sqlite stack",
  });
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("dispose rejects initialization waiters and awaits termination", async () => {
  const { timer, workers, probe } = setup();
  const check = observe(probe.check());
  let finishTermination!: (code: number) => void;
  workers[0]!.termination = new Promise((resolve) => {
    finishTermination = resolve;
  });
  const disposal = observe(probe.dispose());
  await drainUntilQuiescent(timer);
  expect(check.settled).toBe(true);
  expect(await check.result).toMatchObject({ message: "Database health probe disposed" });
  expect(workers[0]!.terminateCalls).toBe(1);
  expect(disposal.settled).toBe(false);
  expect(timer.getPendingTimeoutCount()).toBe(0);
  finishTermination(0);
  expect(await disposal.result).toBeUndefined();
});

test("overlapping checks share initialization and both settle when it times out", async () => {
  const { timer, workers, probe } = setup(2000);
  const first = observe(probe.check());
  timer.advanceTime(500);
  const second = observe(probe.check());
  await drainUntilQuiescent(timer);
  expect(first.settled).toBe(false);
  expect(second.settled).toBe(false);
  expect(workers).toHaveLength(1);
  timer.advanceTime(1500);
  expect(await first.result).toBeInstanceOf(healthProbe.DatabaseHealthProbeInitTimeoutError);
  expect(await second.result).toBeInstanceOf(healthProbe.DatabaseHealthProbeInitTimeoutError);
  expect(workers[0]!.terminateCalls).toBe(1);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("abandoned worker termination rejection is logged and safely observed", async () => {
  const { timer, workers, probe } = setup(2000);
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  try {
    const check = observe(probe.check());
    const failure = new Error("worker already gone");
    workers[0]!.termination = Promise.reject(failure);
    timer.advanceTime(2000);
    expect(await check.result).toBeInstanceOf(healthProbe.DatabaseHealthProbeInitTimeoutError);
    await drainUntilQuiescent(timer);
    expect(debug.mock.calls.flat()).toContain(failure);
  } finally {
    debug.mockRestore();
  }
});
