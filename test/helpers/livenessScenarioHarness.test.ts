import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { defaultAppearanceSyncDependencies } from "../../src/daemon/AppearanceSyncScheduler";
import {
  DEFAULT_SOCKET_PATH,
  LOCK_FILE_PATH,
  PID_FILE_PATH,
  SOCKET_PATH,
} from "../../src/daemon/constants";
import { DefaultDeviceSettingsAccess } from "../../src/features/utility/DeviceSettingDefaults";
import type { BootedDevice } from "../../src/models";
import { resolveAppearanceMode } from "../../src/server/appearanceManager";
import {
  LIST_CHANGED_NOTIFICATION_METHODS,
  ListChangedBroadcaster,
} from "../../src/server/listChangedBroadcast";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { AdbClient } from "../../src/utils/android-cmdline-tools/AdbClient";
import { applyAppearanceToDevice } from "../../src/utils/deviceAppearance";
import { DefaultHostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import { resolveAutoMobileBaseDir } from "../../src/utils/tempDir";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "./fakeTimerStepping";
import {
  IN_MEMORY_DATA_DIR,
  IN_MEMORY_SOCKET_PATH,
  ProcessTimer,
  assertNotHostDaemonPath,
} from "./inMemoryDaemonWire";
import {
  IDLE_WINDOW_MS,
  KEEPER_INTERVAL_MS,
  LivenessScenario,
  OWNER_TOKEN,
  RELEASE_SLACK_MS,
} from "./livenessScenarioHarness";
import { warmedTests } from "./warmedTests";

// #11441: the liveness harness starts a real `Daemon` through `Daemon.startOn()`. These pin what
// keeps that daemon off the machine, and that the harness's daemon is a process that can die.

/** Microtask turns for a pushed frame to cross the in-memory socket to its client. */
const SETTLE_TURNS = 32;

let scenario: LivenessScenario | undefined;
const scenarioTest = warmedTests(async () => {
  await scenario?.stop();
  scenario = undefined;
});

describe("the liveness harness never reaches the host's daemon", () => {
  scenarioTest(
    "passive-work overrides are isolated for the scenario and restored on stop",
    async () => {
      const keys = [
        "AUTOMOBILE_APPEARANCE_SYNC",
        "AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES",
      ] as const;
      const previous = keys.map((key) => process.env[key]);
      const held = "emulator-5554";
      const free = "emulator-5556";
      process.env.AUTOMOBILE_APPEARANCE_SYNC = "0";
      process.env.AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES = free;
      try {
        scenario = await LivenessScenario.start({ devices: [held, free] });
        await scenario.acquire(held);
        expect(scenario.appearanceSyncTargets().map((target) => target.deviceId)).toEqual([held]);
        await scenario.daemonRestart();
        await scenario.idle(2 * KEEPER_INTERVAL_MS);
        expect(scenario.appearanceSyncTargets().map((target) => target.deviceId)).toEqual([held]);
        await scenario.stop();
        scenario = undefined;
        expect(process.env.AUTOMOBILE_APPEARANCE_SYNC).toBe("0");
        expect(process.env.AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES).toBe(free);
      } finally {
        try {
          await scenario?.stop();
          scenario = undefined;
        } finally {
          keys.forEach((key, index) => {
            if (previous[index] === undefined) {
              delete process.env[key];
            } else {
              process.env[key] = previous[index];
            }
          });
        }
      }
    },
  );

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

  // The daemon syncs a device to the host's appearance when a session is created on it, and
  // records the device's display settings before a session changes them. Unstubbed, both ran
  // `defaults`/`gsettings` and `adb -s <device id>` on the machine running the unit tests.
  scenarioTest(
    "acquiring, using and releasing a device runs no host command and no adb command; appearance and device settings answer at the harness",
    async () => {
      const hostCommands = spyOn(
        DefaultHostCommandExecutor.prototype,
        "executeCommand",
      ).mockRejectedValue(new Error("a scenario ran a host command"));
      const adbCommands = spyOn(AdbClient.prototype, "executeCommand").mockRejectedValue(
        new Error("a scenario ran adb"),
      );
      const device = { deviceId: "emulator-5554", name: "emulator-5554", platform: "android" };
      try {
        scenario = await LivenessScenario.start();
        const session = await scenario.acquire();
        await scenario.toolCall(session);
        // The ends the daemon's own sync and settings recorder reach, called as they call them.
        await defaultAppearanceSyncDependencies.apply(device as BootedDevice, "dark");
        expect(await defaultAppearanceSyncDependencies.resolveMode()).toBe("light");
        expect(
          await new DefaultDeviceSettingsAccess().read(device as BootedDevice, ["nightMode"]),
        ).toEqual({});
        expect(await scenario.appearanceSet(session, "dark")).toMatchObject({
          response: { success: true },
        });
        await scenario.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS);

        expect(scenario.appearanceApplies).toContain("emulator-5554:dark");
        expect(hostCommands).not.toHaveBeenCalled();
        expect(adbCommands).not.toHaveBeenCalled();

        await scenario.stop();
        scenario = undefined;
        expect(defaultAppearanceSyncDependencies.apply).toBe(applyAppearanceToDevice);
        expect(defaultAppearanceSyncDependencies.resolveMode).toBe(resolveAppearanceMode);
      } finally {
        hostCommands.mockRestore();
        adbCommands.mockRestore();
      }
    },
  );
});

describe("the harness's control socket is opened by the socket server's own start", () => {
  // `UnixSocketServer.startDetached()` is `start()` minus the socket file: the accept state and
  // every broadcast fan-out are the server's wiring, not a copy of it in the harness (#11441).
  scenarioTest(
    "a subscribed client is pushed the daemon's list-changed and session-released frames, and a killed daemon pushes nothing",
    async () => {
      scenario = await LivenessScenario.start();
      const session = await scenario.acquire();
      const subscriber = scenario.daemonConnection("harness-subscriber");
      await subscriber.connect();
      await subscriber.subscribeToNotifications!();
      const pushed: Array<{ method: string; sessionId?: string; reason?: string }> = [];
      subscriber.onNotification!(({ method, sessionId, reason }) => {
        pushed.push({ method, sessionId, reason });
      });

      ListChangedBroadcaster.emit("tools");
      await drainMicrotasks(SETTLE_TURNS);
      expect(pushed).toEqual([{ method: LIST_CHANGED_NOTIFICATION_METHODS.tools }]);

      await scenario.closeTransport();
      await scenario.idleUntilReleased(session, IDLE_WINDOW_MS + RELEASE_SLACK_MS);
      await drainMicrotasks(SETTLE_TURNS);
      expect(pushed.slice(1)).toEqual([
        {
          method: SESSION_RELEASED_NOTIFICATION_METHOD,
          sessionId: session,
          reason: scenario.releaseOf(session)?.reason,
        },
      ]);

      // A dead process's server is off the process-wide broadcasters: nothing is written for it.
      const dead = scenario.daemon.socket.server as unknown as {
        broadcastListChanged(kind: string): void;
      };
      await scenario.daemonRestart();
      const deadFanOut = spyOn(dead, "broadcastListChanged");
      ListChangedBroadcaster.emit("tools");
      expect(deadFanOut).not.toHaveBeenCalled();
      deadFanOut.mockRestore();
    },
  );
});

describe("the harness's daemon runs every host step of the start sequence", () => {
  // The steps that touch the machine do nothing here, so a start that skipped one would fail no
  // scenario: this pins that `Daemon.start()` still asks its host for each, and in which order.
  // The services (aux sockets, the PID file's full identity) and the maintenance monitors come
  // only after the control socket is bound, for a restarted daemon as for the first.
  scenarioTest(
    "each daemon process asks its host for every step once, the services and monitors after the socket bind",
    async () => {
      scenario = await LivenessScenario.start();
      await scenario.daemonRestart();
      const steps = [
        "enterProcess",
        "publishForwardLeaseOwner",
        "writeEarlyOwnerRecord",
        "openTerminalReleaseJournal",
        "startHttpIngress",
        "sweepStaleAppearanceConfigs",
        "bindControlSocket",
        "startServicesAfterSocketBind",
        "startMaintenanceMonitors",
      ];
      expect(scenario.hostStartSteps).toEqual([steps, steps]);
    },
  );
});

describe("a harness daemon is a process", () => {
  test("a restarted daemon reports a distinct deterministic instance through its heartbeat wire", async () => {
    scenario = await LivenessScenario.start();
    const sessionId = await scenario.acquire();
    const params = {
      sessionId,
      livenessOwnerToken: OWNER_TOKEN,
      claimLivenessOwnership: true,
      reportDaemonInstance: true,
    };
    const first = await scenario.daemonMethod("daemon/heartbeat", params);
    await scenario.daemonRestart();
    const next = await scenario.daemonMethod("daemon/heartbeat", params);

    expect(first).toMatchObject({
      success: true,
      result: { daemonInstance: "scenario-daemon-1:instance" },
    });
    expect(next).toMatchObject({
      success: true,
      result: { daemonInstance: "scenario-daemon-2:instance" },
    });
  });

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
