import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  SpawningDesktopHeadUnitLauncher,
  type DhuChildProcess,
  type DhuLaunchOutcome,
} from "../../../src/features/androidAuto/DesktopHeadUnit";
import { FakeTimer } from "../../fakes/FakeTimer";

// The DHU's own log line when the head unit server is down (docs/using/android-auto.md).
const TRANSPORT_EXIT_LINE = "> [E]: Failed to read from transport - disconnect. Exiting...";

class FakeDhuChild extends EventEmitter implements DhuChildProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  killed: NodeJS.Signals | undefined;

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.written.push(chunk.toString()));
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = signal;
    this.emit("exit", null, signal);
    return true;
  }

  print(text: string): void {
    this.stdout.emit("data", text);
  }
}

const TIMING = { connectTimeoutMs: 1_000, settleMs: 500, pingTimeoutLimit: 2 };

function setup() {
  const timer = new FakeTimer();
  const child = new FakeDhuChild();
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
    result.session.stop();
    expect(child.killed).toBe("SIGTERM");
    expect(result.session.isRunning()).toBe(false);
    expect(() => result.session.sendCommand("day")).toThrow("not running");
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
});
