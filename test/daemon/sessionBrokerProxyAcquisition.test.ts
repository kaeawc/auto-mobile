import { describe, expect, test } from "bun:test";
import { DAEMON_RECONNECT_OUTAGE_BUDGET_MS } from "../../src/daemon/constants";
import { DaemonUnavailableError } from "../../src/daemon/DaemonUnavailableError";
import { DaemonVersionMismatchError } from "../../src/daemon/proxy/DaemonVersionMismatchError";
import { SESSION_BROKER_RETRY_AFTER_MS } from "../../src/daemon/sessionBroker/timing";
import {
  acquireSessionThroughDaemon,
  DAEMON_PREPARE_SESSION_METHOD,
  DAEMON_RELEASE_BROKER_SESSION_METHOD,
  DAEMON_SESSION_REQUEST_STATUS_METHOD,
  type SessionBrokerProxyAcquisitionPorts,
} from "../../src/daemon/sessionBrokerProxyAcquisition";
import type { SessionConfig } from "../../src/devices/sessionConfig";
import type { SessionBrokerResult } from "../../src/devices/sessionBrokerResult";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

const config: SessionConfig = {
  contractVersion: 1,
  requestId: "request-1",
  device: {
    schemaVersion: 1,
    platform: "android",
    hardware: { kind: "archetype", archetype: "phone" },
    os: { kind: "major", major: 35 },
  },
  preparationTimeoutMs: 20_000,
};
const ready: SessionBrokerResult = {
  contractVersion: 1,
  requestId: config.requestId,
  outcome: "ready",
  sessionUuid: "session-1",
  profile: {
    platform: "android",
    metadataState: "current",
    profileId: "pixel_8",
    systemImagePackage: "system-images;android-35;google_apis;x86_64",
    osVersion: "15",
    versionPrecision: "major",
    apiLevel: 35,
    abi: "x86_64",
    flavor: "google_apis",
  },
  cleanupPending: false,
};

function rig(
  answer: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>,
  autoAdvance = true,
) {
  const timer = new FakeTimer();
  if (autoAdvance) {
    timer.enableAutoAdvance();
  }
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const callOptions: Array<{
    method: string;
    timeoutMs: number;
    signal?: AbortSignal;
    cancelOnTimeout?: boolean;
  }> = [];
  const held: Array<{ requestId: string; sessionUuid: string }> = [];
  const ports: SessionBrokerProxyAcquisitionPorts = {
    ensureConnected: async () => {},
    callDaemonMethod: async (method, params, options) => {
      calls.push({ method, params });
      callOptions.push({ method, ...options });
      return await answer(method, params);
    },
    holdSession: async (requestId, sessionUuid) => {
      held.push({ requestId, sessionUuid });
    },
    releaseSession: async (sessionUuid) =>
      answer(DAEMON_RELEASE_BROKER_SESSION_METHOD, { sessionId: sessionUuid }),
    livenessOwnerToken: "owner-1",
    timer,
  };
  return { ports, calls, callOptions, held, timer };
}

describe("session broker proxy acquisition", () => {
  test("T4: lost prepare reply reconnects for status and returns stopping receipt without resending", async () => {
    const receipt: SessionBrokerResult = {
      ...ready,
      outcome: "failed",
      sessionUuid: null,
      profile: null,
      cleanupPending: true,
      failure: {
        code: "session_broker_stopping",
        message: "Session preparation was interrupted because the session broker is stopping.",
        retryable: true,
        retryAfterMs: SESSION_BROKER_RETRY_AFTER_MS,
        retryRequires: "new_request_id",
      },
    };
    let connections = 0;
    const connectionsAtPoll: number[] = [];
    const { ports, calls, held } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      if (method === DAEMON_PREPARE_SESSION_METHOD) {
        throw new Error("prepare reply lost");
      }
      connectionsAtPoll.push(connections);
      if (connectionsAtPoll.length === 1) {
        throw new Error("client gone");
      }
      return receipt;
    });
    ports.ensureConnected = async () => {
      connections++;
    };

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(receipt);
    expect(connectionsAtPoll).toEqual([2, 3]);
    expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(1);
    expect(held).toEqual([]);
  });

  test("T5: status reconnect retries through daemon restart and holds the successor's ready session", async () => {
    let connections = 0;
    const { ports, calls, held, timer } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      if (method === DAEMON_PREPARE_SESSION_METHOD) {
        throw new Error("prepare reply lost");
      }
      expect(connections).toBe(4);
      return ready;
    });
    ports.ensureConnected = async () => {
      connections++;
      if (connections === 2 || connections === 3) {
        throw new Error("daemon restarting");
      }
    };

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(ready);
    expect(connections).toBe(4);
    expect(timer.now()).toBe(500);
    expect(
      calls.filter(({ method }) => method === DAEMON_SESSION_REQUEST_STATUS_METHOD),
    ).toHaveLength(1);
    expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(1);
    expect(held).toEqual([{ requestId: config.requestId, sessionUuid: ready.sessionUuid! }]);
  });

  test.each([false, true])(
    "preserves transient failure retryability through lost reply=%s",
    async (lostReply) => {
      const receipt: SessionBrokerResult = {
        ...ready,
        outcome: "failed",
        sessionUuid: null,
        profile: null,
        failure: { code: "timeout", message: "runner-setup timed out", retryable: true },
      };
      const { ports, held } = rig((method) => {
        if (method === "daemon/capabilities") {
          return { capabilities: ["session-broker/v1"] };
        }
        if (lostReply && method === DAEMON_PREPARE_SESSION_METHOD) {
          throw new Error("reply lost");
        }
        return receipt;
      });
      expect(await acquireSessionThroughDaemon(config, ports)).toEqual(receipt);
      expect(held).toEqual([]);
    },
  );

  test("forwards the owner PID but omits its proxy-only start identity without mutating config", async () => {
    const ownerConfig = {
      ...config,
      executionOwnerPid: 4242,
      executionOwnerStartIdentity: "T1",
    };
    const { ports, calls } = rig((method) =>
      method === "daemon/capabilities" ? { capabilities: ["session-broker/v1"] } : ready,
    );
    expect(await acquireSessionThroughDaemon(ownerConfig, ports)).toEqual(ready);
    const prepare = calls.find(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)!;
    expect(prepare.params.config).not.toHaveProperty("executionOwnerStartIdentity");
    expect(prepare.params.config).toEqual({ ...config, executionOwnerPid: 4242 });
    expect(ownerConfig).toEqual({
      ...config,
      executionOwnerPid: 4242,
      executionOwnerStartIdentity: "T1",
    });
  });

  test("prepares once with no allocation controls and holds the exact ready UUID", async () => {
    const { ports, calls, held } = rig((method) =>
      method === "daemon/capabilities" ? { capabilities: ["session-broker/v1"] } : ready,
    );

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(ready);
    const prepare = calls.find(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)!;
    expect(prepare.params).toEqual({
      config,
      livenessOwnerToken: "owner-1",
    });
    expect(prepare.params).not.toHaveProperty("scope");
    expect(prepare.params).not.toHaveProperty("slot");
    expect(held).toEqual([{ requestId: "request-1", sessionUuid: "session-1" }]);
  });

  test("the prepare call never cancels the daemon's work when only its reply wait expires (#13800)", async () => {
    const { ports, callOptions } = rig((method) =>
      method === "daemon/capabilities" ? { capabilities: ["session-broker/v1"] } : ready,
    );

    await acquireSessionThroughDaemon(config, ports);

    const prepare = callOptions.find(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD);
    expect(prepare?.cancelOnTimeout).toBe(false);
  });

  test("a lost prepare reply polls only the same durable request", async () => {
    let prepareCalls = 0;
    const { ports, calls } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      if (method === DAEMON_PREPARE_SESSION_METHOD) {
        prepareCalls++;
        throw new Error("reply lost");
      }
      return ready;
    });

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(ready);
    expect(prepareCalls).toBe(1);
    expect(calls.filter(({ method }) => method === DAEMON_SESSION_REQUEST_STATUS_METHOD)).toEqual([
      {
        method: DAEMON_SESSION_REQUEST_STATUS_METHOD,
        params: { requestId: "request-1", livenessOwnerToken: "owner-1" },
      },
    ]);
  });

  test.each([0, 5_000])(
    "a stopping refusal retries identical prepare params after delay %s",
    async (retryAfterMs) => {
      const delayMs = Math.max(1, retryAfterMs);
      let prepares = 0;
      const { ports, calls, callOptions, timer } = rig((method) => {
        if (method === "daemon/capabilities") {
          return { capabilities: ["session-broker/v1"] };
        }
        if (method === DAEMON_PREPARE_SESSION_METHOD && ++prepares === 1) {
          throw Object.assign(new Error("broker stopping"), {
            code: "session_broker_stopping",
            retryable: true,
            retryAfterMs,
          });
        }
        return ready;
      });
      const controller = new AbortController();
      const ownerConfig = { ...config, executionOwnerStartIdentity: "proxy-only" };

      expect(await acquireSessionThroughDaemon(ownerConfig, ports, controller.signal)).toEqual(
        ready,
      );
      const prepareCalls = calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD);
      expect(prepareCalls).toHaveLength(2);
      expect(prepareCalls[0]?.params).toEqual({ config, livenessOwnerToken: "owner-1" });
      expect(prepareCalls[1]?.params).toEqual(prepareCalls[0]?.params);
      expect(callOptions.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toEqual([
        {
          method: DAEMON_PREPARE_SESSION_METHOD,
          timeoutMs: 15_000,
          cancelOnTimeout: false,
          signal: controller.signal,
        },
        {
          method: DAEMON_PREPARE_SESSION_METHOD,
          timeoutMs: 15_000 - delayMs,
          cancelOnTimeout: false,
          signal: controller.signal,
        },
      ]);
      expect(calls.filter(({ method }) => method === DAEMON_SESSION_REQUEST_STATUS_METHOD)).toEqual(
        [],
      );
      expect(timer.now()).toBe(delayMs);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("a stopping refusal reconnects after the retry wait before resending prepare", async () => {
    const connections: number[] = [];
    let prepares = 0;
    const { ports, calls, timer } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      if (method === DAEMON_PREPARE_SESSION_METHOD && ++prepares === 1) {
        throw Object.assign(new Error("broker stopping"), {
          code: "session_broker_stopping",
          retryAfterMs: 5_000,
        });
      }
      if (connections.length < 2) {
        throw new Error("not connected");
      }
      return ready;
    });
    ports.ensureConnected = async () => {
      connections.push(timer.now());
    };

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(ready);
    expect(connections).toEqual([0, 5_000]);
    expect(prepares).toBe(2);
    expect(calls.filter(({ method }) => method === DAEMON_SESSION_REQUEST_STATUS_METHOD)).toEqual(
      [],
    );
  });

  test("a stopping retry reconnect failure returns daemon_unavailable without status recovery", async () => {
    let connections = 0;
    const { ports, calls } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      throw Object.assign(new Error("broker stopping"), {
        code: "session_broker_stopping",
        retryAfterMs: 5_000,
      });
    });
    ports.ensureConnected = async () => {
      if (++connections === 2) {
        throw new Error("socket unavailable");
      }
    };

    expect(await acquireSessionThroughDaemon(config, ports)).toMatchObject({
      outcome: "failed",
      cleanupPending: false,
      failure: {
        code: "daemon_unavailable",
        message:
          "Session preparation could not reconnect to the daemon after a stopping refusal: socket unavailable",
        retryable: true,
      },
    });
    expect(connections).toBe(2);
    expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(1);
    expect(calls.filter(({ method }) => method === DAEMON_SESSION_REQUEST_STATUS_METHOD)).toEqual(
      [],
    );
  });

  test.each(["deadline", "abort"])(
    "a stopping retry reconnect stops on %s without status recovery",
    async (termination) => {
      let connections = 0;
      const { ports, calls, timer } = rig((method) => {
        if (method === "daemon/capabilities") {
          return { capabilities: ["session-broker/v1"] };
        }
        throw Object.assign(new Error("broker stopping"), {
          code: "session_broker_stopping",
          retryAfterMs: 5_000,
        });
      }, false);
      ports.ensureConnected = async () => {
        if (++connections === 2) {
          await new Promise<void>(() => {});
        }
      };
      const controller = new AbortController();
      const acquisition = track(acquireSessionThroughDaemon(config, ports, controller.signal));
      await drainMicrotasks(64);
      timer.advanceTime(5_000);
      await drainMicrotasks(64);
      expect(connections).toBe(2);
      expect(timer.getPendingTimeouts()).toEqual([10_000]);

      if (termination === "abort") {
        controller.abort(new Error("proxy shutdown"));
      } else {
        timer.advanceTime(9_999);
        await drainMicrotasks(64);
        expect(acquisition.result).toBeUndefined();
        timer.advanceTime(1);
      }
      await drainMicrotasks(64);

      expect(acquisition.result).toMatchObject({
        outcome: termination === "abort" ? "pending" : "failed",
        cleanupPending: termination === "abort",
        failure: {
          code: termination === "abort" ? "session_status_unresolved" : "session_broker_stopping",
          retryable: true,
        },
      });
      expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(
        1,
      );
      expect(calls.filter(({ method }) => method === DAEMON_SESSION_REQUEST_STATUS_METHOD)).toEqual(
        [],
      );
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(timer.getPendingSleepCount()).toBe(0);
    },
  );

  test("a stopping retry recomputes the prepare budget after reconnecting", async () => {
    let connections = 0;
    let prepares = 0;
    const { ports, callOptions, timer } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      if (++prepares === 1) {
        throw Object.assign(new Error("broker stopping"), {
          code: "session_broker_stopping",
          retryAfterMs: 5_000,
        });
      }
      return ready;
    });
    ports.ensureConnected = async () => {
      if (++connections === 2) {
        await new Promise<void>((resolve) => timer.setTimeout(resolve, 2_000));
      }
    };

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(ready);
    expect(timer.now()).toBe(7_000);
    expect(
      callOptions
        .filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)
        .map(({ timeoutMs }) => timeoutMs),
    ).toEqual([15_000, 8_000]);
  });

  test.each([5_000, 50_000])(
    "stopping refusals with delay %s terminate within the deadline without polling or holding",
    async (retryAfterMs) => {
      const { ports, calls, held, timer } = rig((method) => {
        if (method === "daemon/capabilities") {
          return { capabilities: ["session-broker/v1"] };
        }
        throw Object.assign(new Error("broker stopping"), {
          code: "session_broker_stopping",
          retryable: true,
          retryAfterMs,
        });
      });

      expect(await acquireSessionThroughDaemon(config, ports)).toMatchObject({
        outcome: "failed",
        sessionUuid: null,
        profile: null,
        cleanupPending: false,
        failure: { code: "session_broker_stopping", retryable: true },
      });
      expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(
        retryAfterMs === 5_000 ? 3 : 1,
      );
      expect(calls.filter(({ method }) => method === DAEMON_SESSION_REQUEST_STATUS_METHOD)).toEqual(
        [],
      );
      expect(timer.now()).toBe(retryAfterMs === 5_000 ? 15_000 : config.preparationTimeoutMs!);
      expect(timer.getPendingSleepCount()).toBe(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(held).toEqual([]);
    },
  );

  test("a stopping refusal received with no prepare budget left returns without waiting", async () => {
    const { ports, calls, held, timer } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      timer.advanceTime(15_000);
      throw Object.assign(new Error("broker stopping"), {
        code: "session_broker_stopping",
        retryable: true,
        retryAfterMs: 5_000,
      });
    });

    expect(await acquireSessionThroughDaemon(config, ports)).toMatchObject({
      outcome: "failed",
      cleanupPending: false,
      failure: { code: "session_broker_stopping", retryable: true },
    });
    expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(1);
    expect(calls.filter(({ method }) => method === DAEMON_SESSION_REQUEST_STATUS_METHOD)).toEqual(
      [],
    );
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.now()).toBe(15_000);
    expect(held).toEqual([]);
  });

  test.each([undefined, "5000", NaN, Infinity, -1])(
    "a stopping refusal with retryAfterMs=%s uses the default delay",
    async (retryAfterMs) => {
      let prepares = 0;
      const { ports, calls, timer } = rig((method) => {
        if (method === "daemon/capabilities") {
          return { capabilities: ["session-broker/v1"] };
        }
        if (method === DAEMON_PREPARE_SESSION_METHOD && ++prepares === 1) {
          throw Object.assign(new Error("broker stopping"), {
            code: "session_broker_stopping",
            retryable: true,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          });
        }
        return ready;
      });

      expect(await acquireSessionThroughDaemon(config, ports)).toEqual(ready);
      expect(prepares).toBe(2);
      expect(timer.now()).toBe(SESSION_BROKER_RETRY_AFTER_MS);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(calls.filter(({ method }) => method === DAEMON_SESSION_REQUEST_STATUS_METHOD)).toEqual(
        [],
      );
    },
  );

  test("abort during a stopping retry wait returns unresolved cancellation without another prepare", async () => {
    const { ports, calls, held, timer } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      throw Object.assign(new Error("broker stopping"), {
        code: "session_broker_stopping",
        retryable: true,
        retryAfterMs: 5_000,
      });
    }, false);
    const controller = new AbortController();
    const acquisition = track(acquireSessionThroughDaemon(config, ports, controller.signal));
    await drainMicrotasks(32);
    expect(timer.getPendingTimeouts()).toEqual([5_000]);

    controller.abort();
    await drainMicrotasks(32);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingSleepCount()).toBe(0);

    expect(acquisition.result).toMatchObject({
      outcome: "pending",
      sessionUuid: null,
      cleanupPending: true,
      failure: {
        code: "session_status_unresolved",
        message: expect.stringContaining("cancelled"),
        retryable: true,
      },
    });
    timer.advanceTime(5_000);
    await drainMicrotasks(32);
    expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(1);
    expect(calls.filter(({ method }) => method === DAEMON_SESSION_REQUEST_STATUS_METHOD)).toEqual(
      [],
    );
    expect(held).toEqual([]);
  });

  test("pending preparation converges through status without another prepare", async () => {
    const pending = { ...ready, outcome: "pending", sessionUuid: null, profile: null } as const;
    let statuses = 0;
    const { ports, calls } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      if (method === DAEMON_PREPARE_SESSION_METHOD) {
        return pending;
      }
      return ++statuses === 1 ? pending : ready;
    });

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(ready);
    expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(1);
    expect(statuses).toBe(2);
  });

  test("permanently pending work stops at the one deadline with the same identity", async () => {
    const pending = { ...ready, outcome: "pending", sessionUuid: null, profile: null } as const;
    const { ports, calls } = rig((method) =>
      method === "daemon/capabilities" ? { capabilities: ["session-broker/v1"] } : pending,
    );

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(pending);
    expect(ports.timer.now()).toBe(config.preparationTimeoutMs!);
    expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(1);
    expect(
      calls
        .filter(({ method }) => method === DAEMON_SESSION_REQUEST_STATUS_METHOD)
        .every(
          ({ params }) =>
            params.requestId === config.requestId &&
            params.livenessOwnerToken === ports.livenessOwnerToken,
        ),
    ).toBe(true);
  });

  test("shutdown cancellation stops same-request polling without minting a replacement", async () => {
    const pending = { ...ready, outcome: "pending", sessionUuid: null, profile: null } as const;
    const { ports, calls, held, timer } = rig(
      (method) =>
        method === "daemon/capabilities" ? { capabilities: ["session-broker/v1"] } : pending,
      false,
    );
    const controller = new AbortController();

    const acquisition = acquireSessionThroughDaemon(config, ports, controller.signal);
    await drainMicrotasks(16);
    expect(timer.getPendingSleepCount()).toBe(1);

    controller.abort();
    timer.advanceTime(250);
    await drainMicrotasks(16);

    expect(await acquisition).toEqual(pending);
    expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(1);
    expect(held).toEqual([]);
  });

  test("a failed hold uses broker release and retains incomplete cleanup", async () => {
    const { ports } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      if (method === DAEMON_RELEASE_BROKER_SESSION_METHOD) {
        return { sessionUuid: "session-1", outcome: "cleanup_pending" };
      }
      return ready;
    });
    ports.holdSession = async () => {
      throw new Error("heartbeat refused");
    };

    expect(await acquireSessionThroughDaemon(config, ports)).toMatchObject({
      outcome: "failed",
      sessionUuid: null,
      cleanupPending: true,
      failure: { code: "session_hold_failed" },
    });
  });

  test("an unknown broker release cannot certify failed-hold cleanup", async () => {
    const { ports } = rig((method) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      if (method === DAEMON_RELEASE_BROKER_SESSION_METHOD) {
        return { sessionUuid: "session-1", outcome: "unknown_session" };
      }
      return ready;
    });
    ports.holdSession = async () => {
      throw new Error("heartbeat refused");
    };

    expect(await acquireSessionThroughDaemon(config, ports)).toMatchObject({
      outcome: "failed",
      cleanupPending: true,
    });
  });

  function stalledHoldRig() {
    const releases: string[] = [];
    const { ports, held, timer } = rig((method, params) => {
      if (method === "daemon/capabilities") {
        return { capabilities: ["session-broker/v1"] };
      }
      if (method === DAEMON_RELEASE_BROKER_SESSION_METHOD) {
        releases.push(String(params.sessionId));
        return { sessionUuid: params.sessionId, outcome: "released" };
      }
      return ready;
    }, false);
    const hold = Promise.withResolvers<void>();
    ports.holdSession = async (requestId, sessionUuid) => {
      held.push({ requestId, sessionUuid });
      await hold.promise;
    };
    return { ports, held, timer, hold, releases };
  }

  function track(acquisition: Promise<SessionBrokerResult>) {
    const state: { result?: SessionBrokerResult } = {};
    void acquisition.then((result) => {
      state.result = result;
    });
    return state;
  }

  test.each(["late success", "late failure"] as const)(
    "a stalled ownership hold settles at the preparation deadline and cleans up its %s (#12770)",
    async (late) => {
      const { ports, held, timer, hold, releases } = stalledHoldRig();
      const acquisition = track(acquireSessionThroughDaemon(config, ports));
      await drainMicrotasks(32);
      expect(held).toEqual([{ requestId: "request-1", sessionUuid: "session-1" }]);

      timer.advanceTime(config.preparationTimeoutMs! + 1);
      await drainMicrotasks(32);

      expect(acquisition.result).toMatchObject({
        outcome: "failed",
        sessionUuid: null,
        cleanupPending: false,
        failure: { code: "timeout", retryable: true },
      });
      expect(releases).toEqual(["session-1"]);

      if (late === "late success") {
        hold.resolve();
      } else {
        hold.reject(new Error("heartbeat refused late"));
      }
      await drainMicrotasks(32);
      expect(acquisition.result?.outcome).toBe("failed");
      // A late success must not restore the cancelled grant; a late failure holds nothing.
      expect(releases).toEqual(
        late === "late success" ? ["session-1", "session-1"] : ["session-1"],
      );
    },
  );

  test("cancellation settles a stalled ownership hold and releases its grant (#12770)", async () => {
    const { ports, timer, hold, releases } = stalledHoldRig();
    const controller = new AbortController();
    const acquisition = track(acquireSessionThroughDaemon(config, ports, controller.signal));
    await drainMicrotasks(32);

    controller.abort();
    await drainMicrotasks(32);

    expect(acquisition.result).toMatchObject({
      outcome: "failed",
      sessionUuid: null,
      failure: { code: "cancelled" },
    });
    expect(releases).toEqual(["session-1"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);

    hold.resolve();
    await drainMicrotasks(32);
    expect(acquisition.result?.outcome).toBe("failed");
    expect(releases).toEqual(["session-1", "session-1"]);
  });

  test("an unconfirmed release after a stalled hold keeps cleanup pending (#12770)", async () => {
    const { ports, timer, hold } = stalledHoldRig();
    ports.releaseSession = async () => {
      throw new Error("daemon gone");
    };
    const acquisition = track(acquireSessionThroughDaemon(config, ports));
    await drainMicrotasks(32);

    timer.advanceTime(config.preparationTimeoutMs! + 1);
    await drainMicrotasks(32);

    expect(acquisition.result).toMatchObject({
      outcome: "failed",
      cleanupPending: true,
      failure: { code: "timeout" },
    });
    hold.resolve();
    await drainMicrotasks(32);
  });

  test("a release that never settles cannot hold acquisition past its deadline (#12985)", async () => {
    const { ports, timer, hold } = stalledHoldRig();
    ports.releaseSession = () => new Promise<never>(() => {});
    const acquisition = track(acquireSessionThroughDaemon(config, ports));
    await drainMicrotasks(32);

    timer.advanceTime(config.preparationTimeoutMs! + 1);
    await drainMicrotasks(32);
    timer.advanceTime(1);
    await drainMicrotasks(32);

    expect(acquisition.result).toMatchObject({
      outcome: "failed",
      cleanupPending: true,
      failure: { code: "timeout" },
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    hold.resolve();
    await drainMicrotasks(32);
  });

  test("a hold that resolves after cancellation in the same turn is fenced (#12770)", async () => {
    const { ports, hold, releases } = stalledHoldRig();
    const controller = new AbortController();
    const acquisition = track(acquireSessionThroughDaemon(config, ports, controller.signal));
    await drainMicrotasks(32);

    hold.resolve();
    controller.abort();
    await drainMicrotasks(32);

    expect(acquisition.result).toMatchObject({ outcome: "failed", failure: { code: "cancelled" } });
    expect(releases).toContain("session-1");
  });

  describe("daemon outage while connecting (#15019)", () => {
    const longConfig: SessionConfig = { ...config, preparationTimeoutMs: 8 * 60_000 };
    const capabilitiesOr =
      (otherwise: () => unknown) =>
      (method: string): unknown =>
        method === "daemon/capabilities" ? { capabilities: ["session-broker/v1"] } : otherwise();

    test("a daemon that refuses connections while restarting is retried until it is back", async () => {
      const connectedAt: number[] = [];
      const { ports, calls, timer } = rig(capabilitiesOr(() => ready));
      ports.ensureConnected = async () => {
        connectedAt.push(timer.now());
        if (connectedAt.length <= 3) {
          throw new DaemonUnavailableError("Daemon socket not found");
        }
      };

      expect(await acquireSessionThroughDaemon(longConfig, ports)).toEqual(ready);
      expect(connectedAt).toEqual([0, 1_000, 2_000, 3_000]);
      expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(
        1,
      );
    });

    test("a daemon that stays unreachable ends in a typed retryable failure at the outage budget", async () => {
      let attempts = 0;
      const { ports, calls, timer } = rig(capabilitiesOr(() => ready));
      ports.ensureConnected = async () => {
        attempts++;
        throw new DaemonUnavailableError("Daemon socket not found");
      };

      expect(await acquireSessionThroughDaemon(longConfig, ports)).toMatchObject({
        outcome: "failed",
        failure: { code: "daemon_unavailable", retryable: true },
      });
      expect(timer.now()).toBe(DAEMON_RECONNECT_OUTAGE_BUDGET_MS);
      expect(attempts).toBeGreaterThan(10);
      expect(calls).toEqual([]);
    });

    test("a connect that never settles cannot hold initialize past the outage budget", async () => {
      const { ports, calls, timer } = rig(capabilitiesOr(() => ready));
      ports.ensureConnected = () => new Promise<void>(() => {});

      expect(await acquireSessionThroughDaemon(longConfig, ports)).toMatchObject({
        outcome: "failed",
        failure: { code: "daemon_unavailable", retryable: true },
      });
      expect(timer.now()).toBe(DAEMON_RECONNECT_OUTAGE_BUDGET_MS);
      expect(calls).toEqual([]);
    });

    test("a reconnect after a stopping refusal that never settles ends at the outage budget", async () => {
      let connections = 0;
      const { ports, calls, timer } = rig(
        capabilitiesOr(() => {
          throw Object.assign(new Error("broker stopping"), {
            code: "session_broker_stopping",
            retryAfterMs: 5_000,
          });
        }),
      );
      ports.ensureConnected = async () => {
        if (++connections >= 2) {
          await new Promise<void>(() => {});
        }
      };

      expect(await acquireSessionThroughDaemon(longConfig, ports)).toMatchObject({
        outcome: "failed",
        cleanupPending: false,
        failure: { code: "daemon_unavailable", retryable: true },
      });
      expect(timer.now()).toBe(5_000 + DAEMON_RECONNECT_OUTAGE_BUDGET_MS);
      expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(
        1,
      );
    });

    test("status recovery gives up on an unreachable daemon with the same request identity", async () => {
      let connections = 0;
      const { ports, calls, timer } = rig(
        capabilitiesOr(() => {
          throw new Error("prepare reply lost");
        }),
      );
      ports.ensureConnected = async () => {
        if (++connections > 1) {
          throw new DaemonUnavailableError("Daemon socket not found");
        }
      };

      const result = await acquireSessionThroughDaemon(longConfig, ports);

      expect(result).toMatchObject({
        outcome: "pending",
        requestId: longConfig.requestId,
        cleanupPending: true,
        failure: { code: "session_status_unresolved", retryable: true },
      });
      expect(timer.now()).toBeLessThan(DAEMON_RECONNECT_OUTAGE_BUDGET_MS + 2_000);
      expect(calls.filter(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toHaveLength(
        1,
      );
    });

    test("a policy refusal while connecting is not retried", async () => {
      let attempts = 0;
      const { ports } = rig(capabilitiesOr(() => ready));
      ports.ensureConnected = async () => {
        attempts++;
        throw new DaemonVersionMismatchError({
          clientVersion: "0.0.2",
          daemonVersion: "0.0.1",
          reason: "staleClient",
          detail: "restart refused",
        });
      };

      expect(await acquireSessionThroughDaemon(longConfig, ports)).toMatchObject({
        failure: { code: "daemon_unavailable", retryable: true },
      });
      expect(attempts).toBe(1);
    });
  });

  test("missing capability fails before prepare", async () => {
    const { ports, calls } = rig(() => ({ capabilities: [] }));
    expect(await acquireSessionThroughDaemon(config, ports)).toMatchObject({
      outcome: "failed",
      cleanupPending: false,
      failure: { code: "contract_unsupported", retryable: false },
    });
    expect(calls.some(({ method }) => method === DAEMON_PREPARE_SESSION_METHOD)).toBe(false);
  });

  test("preserves an authoritative terminal receipt with its original UUID and profile", async () => {
    const released = { ...ready, outcome: "released" } as const;
    const { ports, held } = rig((method) =>
      method === "daemon/capabilities" ? { capabilities: ["session-broker/v1"] } : released,
    );

    expect(await acquireSessionThroughDaemon(config, ports)).toEqual(released);
    expect(held).toEqual([]);
  });
});
