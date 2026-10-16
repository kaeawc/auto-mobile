import { afterEach, describe, expect, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  DAEMON_STALLED_CODE,
  RESTART_DAEMON_THEN_RESUME_ACTION,
  type LivenessHandover,
} from "../../src/daemon/proxyLivenessRecovery";
import type { DaemonNotification } from "../../src/daemon/types";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

// The broker landing (#12497) dropped the managed-execution guard from the stall-handover release
// path instead of making it false, so a recoverable daemon release kept the daemon_stalled
// handover of EVERY session. Only a broker-owned session may keep it; a plain session must record
// its terminal loss exactly as before.

const SESSION = "plain-session";

function stalledHandover(sessionUuid: string): LivenessHandover {
  return {
    code: DAEMON_STALLED_CODE,
    sessions: [{ sessionUuid, deviceId: "emulator-5554", lastAcknowledgedHeartbeatAt: 0 }],
    attempts: 3,
    lastAcknowledgedHeartbeatAt: 0,
    action: RESTART_DAEMON_THEN_RESUME_ACTION,
  };
}

function released(sessionId: string, reason: string): DaemonNotification {
  return {
    type: "daemon_notification",
    method: "notifications/session/released",
    sessionId,
    reason,
  };
}

describe("daemon_stalled handover on a recoverable session release", () => {
  const proxies: DaemonMcpProxy[] = [];

  function proxy(): DaemonMcpProxy {
    const created = new DaemonMcpProxy({
      clientFactory: () => new FakeDaemonClient({}),
      daemonManager: new FakeDaemonManager(),
      autoStartDaemon: false,
      timer: new FakeTimer(),
    });
    proxies.push(created);
    return created;
  }

  afterEach(async () => {
    await Promise.all(proxies.splice(0).map((created) => created.close()));
  });

  test("a plain session's stall handover ends as a terminal loss", () => {
    const subject = proxy();
    subject["sessionState"].stallHandovers.set(SESSION, {
      handover: stalledHandover(SESSION),
      delivered: false,
    });

    subject["handleSessionReleasedNotification"](released(SESSION, "daemon-restart"));

    expect(subject["sessionState"].stallHandovers.has(SESSION)).toBe(false);
    expect(subject["pendingSessionLosses"].get(SESSION)?.releaseReasons).toEqual({
      [SESSION]: "daemon-restart",
    });
  });

  test("a broker-owned session keeps its stall handover for the successor daemon", () => {
    const subject = proxy();
    subject["sessionBrokerSessions"].set(SESSION, "request-1");
    subject["sessionState"].stallHandovers.set(SESSION, {
      handover: stalledHandover(SESSION),
      delivered: false,
    });

    subject["handleSessionReleasedNotification"](released(SESSION, "daemon-restart"));

    expect(subject["sessionState"].stallHandovers.has(SESSION)).toBe(true);
    expect(subject["pendingSessionLosses"].has(SESSION)).toBe(false);
  });
});
