import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient, DaemonUnavailableError } from "../../src/daemon/client";
import { DAEMON_HEARTBEAT_METHOD, DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { logger } from "../../src/utils/logger";

// #11028: a held-session heartbeat whose reconnect retry is skipped by the hold-is-current guard
// (#11018) sent nothing, so it must not stamp a claim or a liveness ack onto the record that
// replaced the one it started with.

class LivenessTimer extends FakeTimer {
  override advanceTimeAsync(ms: number): Promise<void> {
    return super.advanceTimeAsync(ms, () => drainUntilQuiescent(this));
  }
}

interface HeldRecord {
  claimSent: boolean;
  lastUsedAt: number;
}

const HELD = "android-session";
const BOUND = "ios-session";
const INTERVAL_MS = 2_000;

describe("held-session heartbeat skipped by the hold-is-current guard (#11028)", () => {
  let timer: LivenessTimer;
  let proxy: DaemonMcpProxy;
  let spies: Array<ReturnType<typeof spyOn>>;
  let onHeldHeartbeat: () => void;

  const held = () =>
    (proxy as unknown as { otherHeldSessions: Map<string, HeldRecord> }).otherHeldSessions;

  beforeEach(() => {
    timer = new LivenessTimer();
    onHeldHeartbeat = () => {};
    spies = [
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
      spyOn(logger, "debug").mockImplementation(() => {}),
    ];
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    proxy = new DaemonMcpProxy({
      clientFactory: () =>
        new FakeDaemonClient({
          daemonMethodResults: new Map<string, unknown>([["tools/list", { tools: [] }]]),
          toolResultFor: (name) => ({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  runtime: {
                    deviceId: name === "getAndroid" ? "emulator-5554" : "sim-1",
                    session: { sessionUuid: name === "getAndroid" ? HELD : BOUND },
                  },
                }),
              },
            ],
          }),
          onCallDaemonMethod: (method, params) => {
            if (method === DAEMON_HEARTBEAT_METHOD && params.sessionId === HELD) {
              onHeldHeartbeat();
            }
            return undefined;
          },
        }),
      daemonManager: manager,
      autoStartDaemon: false,
      timer,
      heartbeatTimeoutMs: 4_000,
      heartbeatIntervalMs: INTERVAL_MS,
    });
  });

  afterEach(async () => {
    await proxy.close();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  test("a re-held record keeps claimSent=false when the retry never sends", async () => {
    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getApple", {});
    const original = held().get(HELD)!;
    // An unclaimed hold, as after a token resume: this tick would claim ownership.
    original.claimSent = false;

    let replacement: HeldRecord | undefined;
    onHeldHeartbeat = () => {
      if (replacement) {
        return;
      }
      // The hold ends and is taken again while this heartbeat waits on the daemon, then the
      // send fails recoverably so the reconnect retry runs against the new record.
      replacement = { claimSent: false, lastUsedAt: original.lastUsedAt };
      held().set(HELD, replacement);
      throw new DaemonUnavailableError("Daemon connection closed");
    };

    await timer.advanceTimeAsync(INTERVAL_MS + 250);

    expect(replacement).toBeDefined();
    expect(held().get(HELD)).toBe(replacement!);
    expect(replacement!.claimSent).toBe(false);
  });
});
