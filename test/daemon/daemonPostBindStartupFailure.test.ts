import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from "../../src/processLifecycle";
import { logger } from "../../src/utils/logger";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

// #11156: a startup step that throws after the control socket bind (aux sockets,
// writePidFile, monitors) used to reach main().catch → process.exit directly,
// skipping forward-lease release, child cleanup and the daemon-shutdown broadcast
// for sessions rehydrated before the bind. start() must await a bounded stop()
// before rethrowing.

interface DaemonStartPhases {
  startThroughSocketBind(): Promise<void>;
  startAfterSocketBind(): Promise<void>;
}

class PostBindFailure extends Error {}

describe("Daemon post-bind startup failure (#11156)", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  function startableDaemon(timer: FakeTimer, failure: { prebind?: Error; postbind?: Error }) {
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      new FakeDeviceSessionRepository(),
    );
    const phases = daemon as unknown as DaemonStartPhases;
    const events: string[] = [];
    const spies = [
      spyOn(logger, "error").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(phases, "startThroughSocketBind").mockImplementation(async () => {
        events.push("bind");
        if (failure.prebind) {
          throw failure.prebind;
        }
      }),
      spyOn(phases, "startAfterSocketBind").mockImplementation(async () => {
        events.push("post-bind");
        if (failure.postbind) {
          throw failure.postbind;
        }
      }),
    ];
    for (const spy of spies) {
      restores.push(() => spy.mockRestore());
    }
    return { daemon, events };
  }

  test("awaits stop() before rethrowing a post-bind failure", async () => {
    const failure = new PostBindFailure("aux socket refused");
    const { daemon, events } = startableDaemon(new FakeTimer(), { postbind: failure });
    const stop = spyOn(daemon, "stop").mockImplementation(async () => {
      events.push("stop");
    });
    restores.push(() => stop.mockRestore());

    await expect(daemon.start()).rejects.toBe(failure);

    expect(events).toEqual(["bind", "post-bind", "stop"]);
  });

  test("bounds a wedged stop() and still rethrows the startup failure", async () => {
    const timer = new FakeTimer();
    const failure = new PostBindFailure("writePidFile failed");
    const { daemon } = startableDaemon(timer, { postbind: failure });
    const stopStarted = Promise.withResolvers<void>();
    const stop = spyOn(daemon, "stop").mockImplementation(() => {
      stopStarted.resolve();
      return new Promise<void>(() => {});
    });
    restores.push(() => stop.mockRestore());

    const outcome = daemon.start().then(
      () => undefined,
      (error: unknown) => error,
    );
    await stopStarted.promise;
    for (let turn = 0; turn < 20 && timer.getPendingTimeoutCount() === 0; turn++) {
      await Promise.resolve();
    }
    timer.advanceTime(PROCESS_SHUTDOWN_TIMEOUT_MS);

    expect(await outcome).toBe(failure);
  });

  test("a pre-bind failure does not run the post-bind stop", async () => {
    const failure = new Error("HTTP bind refused");
    const { daemon, events } = startableDaemon(new FakeTimer(), { prebind: failure });
    const stop = spyOn(daemon, "stop").mockResolvedValue(undefined);
    restores.push(() => stop.mockRestore());

    await expect(daemon.start()).rejects.toBe(failure);

    expect(events).toEqual(["bind"]);
    expect(stop).not.toHaveBeenCalled();
  });
});
