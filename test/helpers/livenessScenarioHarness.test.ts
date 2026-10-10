import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SOCKET_PATH,
  LOCK_FILE_PATH,
  PID_FILE_PATH,
  SOCKET_PATH,
} from "../../src/daemon/constants";
import { resolveAutoMobileBaseDir } from "../../src/utils/tempDir";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  IN_MEMORY_DATA_DIR,
  IN_MEMORY_SOCKET_PATH,
  ProcessTimer,
  assertNotHostDaemonPath,
} from "./inMemoryDaemonWire";
import { KEEPER_INTERVAL_MS, LivenessScenario } from "./livenessScenarioHarness";
import { warmedTests } from "./warmedTests";

// #11441: the liveness harness starts a real `Daemon` through `Daemon.startOn()`. These pin what
// keeps that daemon off the machine, and that the harness's daemon is a process that can die.

let scenario: LivenessScenario | undefined;
const scenarioTest = warmedTests(async () => {
  await scenario?.stop();
  scenario = undefined;
});

describe("the liveness harness never reaches the host's daemon", () => {
  test.each([
    ["the control socket", SOCKET_PATH],
    ["the default control socket", DEFAULT_SOCKET_PATH],
    ["the PID file", PID_FILE_PATH],
    ["the startup lock", LOCK_FILE_PATH],
    ["the data directory", resolveAutoMobileBaseDir()],
    ["a file in the data directory", path.join(resolveAutoMobileBaseDir(), "auto-mobile.db")],
    ["a file under ~/.auto-mobile", path.join(homedir(), ".auto-mobile", "logs", "daemon.log")],
    ["a private daemon's socket", "/tmp/auto-mobile-daemon-501-private.sock"],
  ])("refuses %s", (_what, candidate) => {
    expect(() => assertNotHostDaemonPath("path", candidate)).toThrow(
      "belongs to the host's AutoMobile daemon",
    );
  });

  test("accepts the in-memory socket path and data directory it uses", () => {
    expect(assertNotHostDaemonPath("socket", IN_MEMORY_SOCKET_PATH)).toBe(IN_MEMORY_SOCKET_PATH);
    expect(assertNotHostDaemonPath("data", IN_MEMORY_DATA_DIR)).toBe(IN_MEMORY_DATA_DIR);
  });

  scenarioTest(
    "its daemon throws on every start step that touches the machine: the process's own start() cannot run",
    async () => {
      scenario = await LivenessScenario.start();

      await expect(scenario.daemon.daemon.start()).rejects.toThrow(
        "Daemon.enterDaemonProcess() would touch the host",
      );
      const daemon = scenario.daemon.daemon;
      expect(() => daemon.stop()).toThrow("Daemon.stop() would touch the host");
    },
  );
});

describe("a harness daemon is a process", () => {
  test("a killed process's timers, intervals and sleeps never fire; the shared clock runs on", async () => {
    const clock = new FakeTimer();
    const dying = new ProcessTimer(clock);
    const living = new ProcessTimer(clock);
    const fired: string[] = [];
    dying.setTimeout(() => fired.push("dying timeout"), 1_000);
    dying.setInterval(() => fired.push("dying interval"), 1_000);
    void dying.sleep(1_000).then(() => fired.push("dying sleep"));
    living.setTimeout(() => fired.push("living timeout"), 1_000);

    dying.kill();
    dying.setTimeout(() => fired.push("armed after death"), 500);
    dying.setInterval(() => fired.push("interval after death"), 500);
    await clock.advanceTimeAsync(3_000);

    expect(fired).toEqual(["living timeout"]);
    expect(dying.now()).toBe(3_000);
  });

  scenarioTest(
    "a restart drops every connection and the next daemon is a new one over the same sessions",
    async () => {
      scenario = await LivenessScenario.start();
      const session = await scenario.acquire();
      const first = scenario.daemon;
      const lost = scenario.daemonConnection("harness-observer");
      await lost.connect();
      let closed = 0;
      lost.onConnectionClosed!(() => closed++);

      await scenario.daemonRestart();

      expect(closed).toBe(1);
      expect(scenario.daemon.daemon).not.toBe(first.daemon);
      expect(scenario.daemon.manager).not.toBe(first.manager);
      // Start's own order: the dead process's row was expired, then rehydrated awaiting its owner.
      expect(scenario.daemon.manager.getSession(session)?.ownership).toBe("awaiting-owner");
      // The proxy reconnects to the new process on its keeper's tick and takes the session back.
      await scenario.idle(2 * KEEPER_INTERVAL_MS);
      expect(scenario.daemon.manager.getSession(session)?.ownership).toBe("owned");
      expect(first.manager.getSession(session)?.ownership).not.toBe("awaiting-owner");
    },
  );
});
