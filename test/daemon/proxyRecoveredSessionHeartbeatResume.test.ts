import { describe, expect, test } from "bun:test";
import type { DaemonClientLike } from "../../src/daemon/client/client";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import {
  DaemonMcpProxy,
  RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
} from "../../src/daemon/daemonMcpProxy";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/daemon/sessionReleaseBroadcast";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// #19232: the emulator behind the proxy's session is lost. The daemon reserves the session for a
// device restart and answers its heartbeats not-found under `device-restart:<id>`, so the proxy
// heartbeats it through the recoverable window and then stops. A `getAndroid` that cold-boots the
// AVD inside the daemon's restart recovery window hands the SAME session back as ready. The
// proxy must heartbeat it again from then on, or the daemon reaps the recovered session for
// silence (`heartbeat-timeout`) seconds after reporting it ready.

const INTERVAL_MS = 1_000;
const LEASE_MS = 4_000;
const SESSION = "recovered-session";
const DEVICE = "emulator-5556";
const LOST_REASON = `device-restart:${DEVICE}`;
const WINDOW_TICKS = RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS / INTERVAL_MS;

interface World {
  timer: FakeTimer;
  proxy: DaemonMcpProxy;
  /** The emulator goes away: the daemon announces the handoff and answers heartbeats not-found. */
  loseDevice(): void;
  /** The daemon ends the session for good: heartbeats answer not-found under `reason`. */
  endSession(reason: string): void;
  /** Heartbeats the daemon received for the session during the next `ticks` keeper ticks. */
  heartbeatsOver(ticks: number): Promise<number>;
  close(): Promise<void>;
}

function world(): World {
  const timer = new FakeTimer();
  let releasedAs: string | undefined;
  let heartbeats = 0;
  const client = new FakeDaemonClient({
    toolResultFor: (name) =>
      name === "getAndroid"
        ? {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  runtime: { session: { sessionUuid: SESSION }, device: { deviceId: DEVICE } },
                }),
              },
            ],
          }
        : undefined,
    onCallTool: (name) => {
      if (name === "getAndroid" && releasedAs === LOST_REASON) {
        // The acquisition recovers the reserved session: the daemon knows it again.
        releasedAs = undefined;
      }
    },
    onCallDaemonMethod: (method, params) => {
      if (method !== "daemon/heartbeat" || params.sessionId !== SESSION) {
        return undefined;
      }
      heartbeats += 1;
      if (releasedAs !== undefined) {
        throw Object.assign(new Error(`Session not found: ${SESSION}`), {
          code: DAEMON_SESSION_NOT_FOUND_CODE,
          releaseReason: releasedAs,
        });
      }
      return undefined;
    },
  });
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  const proxy = new DaemonMcpProxy({
    clientFactory: (): DaemonClientLike => client,
    daemonAvailabilityProbe: async () => true,
    daemonManager,
    autoStartDaemon: false,
    timer,
    idGenerator: new FakeIdGenerator(),
    heartbeatTimeoutMs: LEASE_MS,
    heartbeatIntervalMs: INTERVAL_MS,
  });
  return {
    timer,
    proxy,
    loseDevice: () => {
      releasedAs = LOST_REASON;
      client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, SESSION, LOST_REASON);
    },
    endSession: (reason) => {
      releasedAs = reason;
    },
    heartbeatsOver: async (ticks) => {
      const before = heartbeats;
      for (let tick = 0; tick < ticks; tick += 1) {
        await timer.advanceTimeAsync(INTERVAL_MS);
      }
      return heartbeats - before;
    },
    close: () => timer.resolvePromise(proxy.close(), 1),
  };
}

async function acquire(w: World): Promise<string | undefined> {
  const result = await w.timer.resolvePromise(w.proxy.callTool("getAndroid", {}), 1);
  return JSON.parse(result.content[0].text).runtime.session.sessionUuid;
}

describe("a lost session recovered by getAndroid is heartbeated again (#19232)", () => {
  test("past the recoverable window, the recovered session's heartbeats resume", async () => {
    const w = world();
    try {
      expect(await acquire(w)).toBe(SESSION);
      expect(await w.heartbeatsOver(3)).toBe(3);

      w.loseDevice();
      // Through the window and past it: the proxy stops asking.
      await w.heartbeatsOver(WINDOW_TICKS + 3);
      expect(await w.heartbeatsOver(5)).toBe(0);

      expect(await acquire(w)).toBe(SESSION);
      // Every tick heartbeats the recovered session, well inside the daemon's lease.
      expect(await w.heartbeatsOver(LEASE_MS / INTERVAL_MS + 4)).toBe(LEASE_MS / INTERVAL_MS + 4);
      expect(w.proxy.getTerminalSessionRelease()).toBeUndefined();
    } finally {
      await w.close();
    }
  });

  test("inside the recoverable window, the recovered session keeps being heartbeated", async () => {
    const w = world();
    try {
      await acquire(w);
      w.loseDevice();
      await w.heartbeatsOver(3);

      expect(await acquire(w)).toBe(SESSION);
      expect(await w.heartbeatsOver(WINDOW_TICKS + 3)).toBe(WINDOW_TICKS + 3);
    } finally {
      await w.close();
    }
  });

  // The pin: re-arming heartbeats does not keep alive a session the daemon has ended. A recovered
  // session later reaped for silence is fenced and no longer heartbeated.
  test("a recovered session the daemon then ends for good is fenced and no longer heartbeated", async () => {
    const w = world();
    try {
      await acquire(w);
      w.loseDevice();
      await w.heartbeatsOver(WINDOW_TICKS + 3);
      await acquire(w);
      await w.heartbeatsOver(2);

      w.endSession("heartbeat-timeout");
      await w.heartbeatsOver(2);

      expect(await w.heartbeatsOver(5)).toBe(0);
      expect(w.proxy.getTerminalSessionRelease()?.reason).toBe("heartbeat-timeout");
    } finally {
      await w.close();
    }
  });

  // The pin: a recovered session whose owner goes away is heartbeated by nothing, so the
  // daemon's heartbeat monitor still reaps it.
  test("a recovered session whose proxy closes is no longer heartbeated", async () => {
    const w = world();
    await acquire(w);
    w.loseDevice();
    await w.heartbeatsOver(WINDOW_TICKS + 3);
    await acquire(w);
    expect(await w.heartbeatsOver(2)).toBe(2);

    await w.close();

    expect(await w.heartbeatsOver(LEASE_MS / INTERVAL_MS + 4)).toBe(0);
  });
});
