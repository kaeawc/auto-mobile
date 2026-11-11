import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  SpawningDesktopHeadUnitLauncher,
  type DhuChildProcess,
  type DhuLaunchOutcome,
} from "../../../src/features/androidAuto/DesktopHeadUnit";
import { FakeTimer } from "../../fakes/FakeTimer";

// The DHU's own log line when the head unit server is down (docs/using/android-auto.md).
const TRANSPORT_EXIT_LINE = "> [E]: Failed to read from transport - disconnect. Exiting...";

/** A console pipe the DHU already closed: every write fails with EPIPE, as Node reports it. */
function closedConsole(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    },
  });
}

class FakeDhuChild extends EventEmitter implements DhuChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  /** Undefined models a spawn that failed before any process existed. */
  pid: number | undefined = 4242;
  killed: NodeJS.Signals | undefined;
  readonly signals: NodeJS.Signals[] = [];
  /** Signals the process survives, as a DHU stuck in teardown does. */
  ignoredSignals = new Set<NodeJS.Signals>();

  constructor(readonly stdin: Writable = new PassThrough()) {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.written.push(chunk.toString()));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = signal;
    this.signals.push(signal);
    if (!this.ignoredSignals.has(signal)) {
      this.emit("exit", null, signal);
    }
    return true;
  }

  print(text: string): void {
    this.stdout.emit("data", text);
  }
}

const TIMING = { connectTimeoutMs: 1_000, settleMs: 500, pingTimeoutLimit: 2, stopTimeoutMs: 200 };

function setup(stdin?: Writable) {
  const timer = new FakeTimer();
  const child = new FakeDhuChild(stdin);
  const spawned: Array<{ command: string; args: string[] }> = [];
  const launcher = new SpawningDesktopHeadUnitLauncher(
    (command, args) => {
      spawned.push({ command, args });
      return child;
    },
    timer,
    TIMING,
  );
  const launch = (): Promise<DhuLaunchOutcome> =>
    launcher.launch({
      binaryPath: "/sdk/extras/google/auto/desktop-head-unit",
      configPath: "config/default_720p.ini",
    });
  return { timer, child, spawned, launch };
}

async function flushStdin(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("SpawningDesktopHeadUnitLauncher", () => {
  test("starts headless with the config and sends focus video once the connection holds", async () => {
    const { timer, child, spawned, launch } = setup();
    const outcome = launch();
    child.print("connected.\n");
    timer.advanceTime(TIMING.settleMs);
    const result = await outcome;
    await flushStdin();
    expect(spawned).toEqual([
      {
        command: "/sdk/extras/google/auto/desktop-head-unit",
        args: ["--headless", "-c", "config/default_720p.ini"],
      },
    ]);
    expect(result.status).toBe("connected");
    expect(child.written).toEqual(["focus video\n"]);
    expect(child.killed).toBeUndefined();
  });

  test("a session forwards console commands and stops the process", async () => {
    const { timer, child, launch } = setup();
    const outcome = launch();
    child.print("conn");
    child.print("ected.\n");
    timer.advanceTime(TIMING.settleMs);
    const result = await outcome;
    if (result.status !== "connected") {
      throw new Error(`expected connected, got ${result.status}`);
    }
    result.session.sendCommand("screenshot /tmp/hu.png");
    await flushStdin();
    expect(child.written).toEqual(["focus video\n", "screenshot /tmp/hu.png\n"]);
    await result.session.stop();
    expect(child.killed).toBe("SIGTERM");
    expect(result.session.isRunning()).toBe(false);
    expect(() => result.session.sendCommand("day")).toThrow("not running");
  });

  test("interleaved stderr output never splices a stdout line", async () => {
    const { timer, child, launch } = setup();
    const outcome = launch();
    child.print("conn");
    child.stderr.emit("data", "diagnostic\n");
    child.print("ected.\n");
    timer.advanceTime(TIMING.settleMs);
    expect(await outcome).toMatchObject({ status: "connected" });
  });

  test("no connected. line before the timeout is a no-connect and kills the DHU", async () => {
    const { timer, child, launch } = setup();
    const outcome = launch();
    timer.advanceTime(TIMING.connectTimeoutMs);
    expect(await outcome).toMatchObject({ status: "no-connect" });
    expect(child.killed).toBe("SIGTERM");
  });

  test("an exit after connecting is a stall that carries the DHU's last line", async () => {
    const { child, launch } = setup();
    const outcome = launch();
    child.print(`connected.\n${TRANSPORT_EXIT_LINE}`);
    child.emit("exit", 1, null);
    const result = await outcome;
    expect(result).toMatchObject({ status: "stalled" });
    expect(result.status === "stalled" && result.detail).toContain("Failed to read from transport");
  });

  test("repeated ping timeouts inside the settle window are a stall", async () => {
    const { child, launch } = setup();
    const outcome = launch();
    child.print("connected.\nPing timeout\nPing timeout\n");
    expect(await outcome).toMatchObject({ status: "stalled" });
    expect(child.killed).toBe("SIGTERM");
  });

  test("an EPIPE on the focus video write is a stalled start, not a connected one", async () => {
    const { timer, child, launch } = setup(closedConsole());
    const outcome = launch();
    child.print("connected.\n");
    timer.advanceTime(TIMING.settleMs);
    const result = await outcome;
    expect(result).toMatchObject({ status: "stalled" });
    expect(result.status === "stalled" && result.detail).toContain("EPIPE");
    expect(child.killed).toBe("SIGTERM");
  });

  test("a later EPIPE marks the session not running instead of escaping", async () => {
    const { timer, child, launch } = setup();
    const outcome = launch();
    child.print("connected.\n");
    timer.advanceTime(TIMING.settleMs);
    const result = await outcome;
    if (result.status !== "connected") {
      throw new Error(`expected connected, got ${result.status}`);
    }
    child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(result.session.isRunning()).toBe(false);
    expect(result.session.isAlive()).toBe(true);
    expect(() => result.session.sendCommand("day")).toThrow("not running");
    child.emit("exit", 0, null);
    expect(result.session.isAlive()).toBe(false);
  });

  test("stop() still kills a live DHU after a later EPIPE marked the session unhealthy", async () => {
    const { timer, child, launch } = setup();
    const outcome = launch();
    child.print("connected.\n");
    timer.advanceTime(TIMING.settleMs);
    const result = await outcome;
    if (result.status !== "connected") {
      throw new Error(`expected connected, got ${result.status}`);
    }
    child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(child.killed).toBeUndefined();
    await result.session.stop();
    expect(child.killed).toBe("SIGTERM");
  });

  test("stop() escalates to SIGKILL and resolves only once a DHU that ignores SIGTERM exits", async () => {
    const { timer, child, launch } = setup();
    const outcome = launch();
    child.print("connected.\n");
    timer.advanceTime(TIMING.settleMs);
    const result = await outcome;
    if (result.status !== "connected") {
      throw new Error(`expected connected, got ${result.status}`);
    }
    child.ignoredSignals.add("SIGTERM");
    let stopped = false;
    const stopping = result.session.stop().then(() => {
      stopped = true;
    });
    await flushStdin();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(stopped).toBe(false);
    timer.advanceTime(TIMING.stopTimeoutMs);
    await stopping;
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("stop() rejects when the DHU never exits, so no replacement is launched beside it", async () => {
    const { timer, child, launch } = setup();
    const outcome = launch();
    child.print("connected.\n");
    timer.advanceTime(TIMING.settleMs);
    const result = await outcome;
    if (result.status !== "connected") {
      throw new Error(`expected connected, got ${result.status}`);
    }
    child.ignoredSignals = new Set(["SIGTERM", "SIGKILL"]);
    const stopping = result.session.stop();
    await flushStdin();
    timer.advanceTime(TIMING.stopTimeoutMs);
    await flushStdin();
    timer.advanceTime(TIMING.stopTimeoutMs);
    await expect(stopping).rejects.toThrow("did not exit");
  });

  test("stop() does not signal a DHU that already exited", async () => {
    const { timer, child, launch } = setup();
    const outcome = launch();
    child.print("connected.\n");
    timer.advanceTime(TIMING.settleMs);
    const result = await outcome;
    if (result.status !== "connected") {
      throw new Error(`expected connected, got ${result.status}`);
    }
    child.emit("exit", 0, null);
    await result.session.stop();
    expect(child.killed).toBeUndefined();
    expect(result.session.isRunning()).toBe(false);
  });

  test("a failed launch settles only once the DHU exited, escalating to SIGKILL", async () => {
    const { timer, child, launch } = setup();
    child.ignoredSignals.add("SIGTERM");
    let settled = false;
    const outcome = launch().then((result) => {
      settled = true;
      return result;
    });
    timer.advanceTime(TIMING.connectTimeoutMs);
    await flushStdin();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);
    timer.advanceTime(TIMING.stopTimeoutMs);
    expect(await outcome).toMatchObject({
      status: "no-connect",
      detail: expect.stringContaining('no "connected."'),
    });
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("a failed launch whose DHU never exits rejects instead of allowing a relaunch", async () => {
    const { timer, child, launch } = setup();
    child.ignoredSignals = new Set(["SIGTERM", "SIGKILL"]);
    const outcome = launch();
    timer.advanceTime(TIMING.connectTimeoutMs);
    await flushStdin();
    timer.advanceTime(TIMING.stopTimeoutMs);
    await flushStdin();
    timer.advanceTime(TIMING.stopTimeoutMs);
    await expect(outcome).rejects.toThrow("did not exit");
  });

  test("a spawn that failed before a process existed is a no-connect without any signal", async () => {
    const { child, launch } = setup();
    child.pid = undefined;
    const outcome = launch();
    child.emit("error", new Error("spawn desktop-head-unit ENOENT"));
    expect(await outcome).toMatchObject({
      status: "no-connect",
      detail: expect.stringContaining("ENOENT"),
    });
    expect(child.signals).toEqual([]);
  });

  test("a child error event before connecting is a no-connect", async () => {
    const { child, launch } = setup();
    const outcome = launch();
    child.emit("error", new Error("spawn desktop-head-unit EACCES"));
    expect(await outcome).toMatchObject({
      status: "no-connect",
      detail: expect.stringContaining("EACCES"),
    });
  });

  test("a child error event after connecting is handled and stops the session", async () => {
    const { timer, child, launch } = setup();
    const outcome = launch();
    child.print("connected.\n");
    timer.advanceTime(TIMING.settleMs);
    const result = await outcome;
    if (result.status !== "connected") {
      throw new Error(`expected connected, got ${result.status}`);
    }
    child.emit("error", new Error("kill ESRCH"));
    child.emit("error", new Error("kill ESRCH again"));
    expect(result.session.isRunning()).toBe(false);
  });
});
