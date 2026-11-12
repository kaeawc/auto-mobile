import { describe, expect, test } from "bun:test";
import { ProcessBlePeripheralSidecar } from "../../../src/features/blePeripheral/ProcessBlePeripheralSidecar";
import type {
  BlePeripheralConfig,
  BleSidecarStatus,
} from "../../../src/features/blePeripheral/blePeripheralSchema";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";

const config: BlePeripheralConfig = {
  name: "Prototype",
  address: "F0:F1:F2:F3:F4:F5",
  presets: ["battery"],
  transport: "android-netsim",
};
const running: BleSidecarStatus = {
  running: true,
  advertising: true,
  connected: [],
  subscribed: [],
  pythonReady: true,
  bumbleReady: true,
};

function setup() {
  const timer = new FakeTimer();
  const child = new FakeChildProcess(timer);
  const launches: { file: string; args: string[] }[] = [];
  const sidecar = new ProcessBlePeripheralSidecar({
    spawner: {
      spawn: (file, args) => {
        launches.push({ file, args });
        return child;
      },
    },
    timer,
    script: () => "/fake/peripheral.py",
  });
  const event = (value: object) => {
    child.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  };
  const start = async () => {
    const started = sidecar.start("/fake/python3", config, new AbortController().signal);
    event({ event: "ready", status: running });
    await started;
  };
  const stop = async () => {
    const stopped = sidecar.stop();
    timer.advanceTime(0);
    await stopped;
  };
  return { timer, child, sidecar, launches, event, start, stop };
}

describe("Bumble JSON-lines client", () => {
  test("starts isolated Python with a JSON config and correlates notify and status acknowledgements", async () => {
    const f = setup();
    await f.start();
    expect(f.launches).toEqual([
      { file: "/fake/python3", args: ["-I", "-u", "/fake/peripheral.py"] },
    ]);
    expect(JSON.parse(f.child.getStdinData().toString().split("\n")[0])).toEqual({
      ...config,
      action: "start",
    });
    const notified = f.sidecar.notify({ characteristic: "battery", level: 40 });
    f.event({ event: "notified", id: 1, status: running });
    await notified;
    const status = f.sidecar.status();
    f.event({
      event: "status",
      id: 2,
      status: { ...running, advertising: false, connected: ["central"], subscribed: ["2A19"] },
    });
    expect(await status).toMatchObject({
      advertising: false,
      connected: ["central"],
      subscribed: ["2A19"],
    });
    await f.stop();
    expect(f.child.killed).toBe(true);
    expect(f.child.signalCode).toBe("SIGKILL");
    expect((await f.sidecar.status()).running).toBe(false);
    expect(f.timer.getSleepCallCount()).toBe(0);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a command error is actionable without losing a running peripheral", async () => {
    const f = setup();
    await f.start();
    const notified = f.sidecar.notify({ characteristic: "missing" });
    const rejected = notified.catch((error: unknown) => error);
    f.event({ event: "error", id: 1, message: "unknown characteristic" });
    expect(await rejected).toMatchObject({
      message: expect.stringContaining("unknown characteristic"),
    });
    await f.stop();
  });

  test("crash rejects pending notifications and clears connection state", async () => {
    const f = setup();
    await f.start();
    const notified = f.sidecar.notify({ characteristic: "battery", level: 5 });
    const rejected = notified.catch((error: unknown) => error);
    f.child.simulateExit(1);
    f.timer.advanceTime(0);
    expect(await rejected).toMatchObject({
      message: expect.stringMatching(/exited|stdout closed/),
    });
    expect(await f.sidecar.status()).toMatchObject({
      running: false,
      connected: [],
      subscribed: [],
    });
    await f.stop();
  });

  test("startup and command deadlines use FakeTimer without sleeps", async () => {
    const f = setup();
    const starting = f.sidecar.start("/fake/python3", config, new AbortController().signal);
    const rejected = starting.catch((error: unknown) => error);
    f.timer.advanceTime(15_000);
    expect(await rejected).toMatchObject({ message: expect.stringContaining("timed out") });
    await f.stop();
    expect(f.timer.getSleepCallCount()).toBe(0);
  });

  test("invalid JSON rejects a pending request", async () => {
    const f = setup();
    await f.start();
    const status = f.sidecar.status();
    const rejected = status.catch((error: unknown) => error);
    f.child.stdout.emit("data", Buffer.from("not JSON\n"));
    expect(await rejected).toMatchObject({
      message: expect.stringContaining("Invalid BLE sidecar JSON"),
    });
    await f.stop();
  });

  test("release cancellation interrupts startup before ready", async () => {
    const f = setup();
    const controller = new AbortController();
    const starting = f.sidecar.start("/fake/python3", config, controller.signal);
    const rejected = starting.catch((error: unknown) => error);
    controller.abort(new Error("session released"));
    expect(await rejected).toMatchObject({ message: expect.stringContaining("released") });
    await f.stop();
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("notification timeout rejects through FakeTimer and late ready events cannot revive a stopped child", async () => {
    const f = setup();
    await f.start();
    const notified = f.sidecar.notify({ characteristic: "battery", level: 50 });
    const result = notified.catch((error: unknown) => error);
    f.timer.advanceTime(10_000);
    expect(await result).toMatchObject({ message: expect.stringContaining("timed out") });
    await f.stop();
    f.event({ event: "ready", status: running });
    expect((await f.sidecar.status()).running).toBe(false);
    expect(f.timer.getSleepCallCount()).toBe(0);
  });

  test("spawn failure without a PID is actionable and needs no process teardown", async () => {
    const f = setup();
    f.child.pid = undefined;
    const starting = f.sidecar.start("/fake/python3", config, new AbortController().signal);
    const result = starting.catch((error: unknown) => error);
    f.child.emit("error", new Error("ENOENT"));
    expect(await result).toMatchObject({ message: expect.stringContaining("ENOENT") });
    await f.stop();
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
  });
});
