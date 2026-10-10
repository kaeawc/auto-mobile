import { describe, expect, test } from "bun:test";
import type { DaemonClientLike } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import {
  DaemonBoundSessionExpiredError,
  DaemonMcpProxy,
  RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
} from "../../src/daemon/daemonMcpProxy";
import {
  isRecoverableDaemonReleaseReason,
  SESSION_RELEASE_REASON_FAMILY_TRAITS,
  SESSION_RELEASE_REASON_TRAITS,
} from "../../src/daemon/releaseReasons";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// The proxy learns that the daemon released a session in five ways: the session-released
// notification, and a heartbeat answered not-found with the release reason on a keeper tick, on
// the binding's first heartbeat, on the heartbeat that re-establishes ownership over a new
// connection, or during liveness recovery. All of them classify the reason in one place (DaemonMcpProxy.releaseKeepsBinding): the binding survives only a recoverable handoff.
// Everything else, terminal, reusable by name (`plan-auto-release`) or unknown to this build,
// fences it, so the released UUID is never attached to a sessionless call, which the daemon
// would answer by creating the session again.

const INTERVAL_MS = 1_000;
const LEASE_MS = 4_000;
const SESSION = "classified-session";

/** Every reason a daemon may record, each family with an id, plus one this build does not know. */
const EVERY_REASON: readonly string[] = [
  ...Object.keys(SESSION_RELEASE_REASON_TRAITS),
  ...Object.keys(SESSION_RELEASE_REASON_FAMILY_TRAITS).map((prefix) => `${prefix}emulator-5554`),
  "reason-from-a-newer-daemon",
];

type Path =
  | "notification"
  | "keeper tick"
  | "first heartbeat"
  | "establishment heartbeat"
  | "liveness recovery";
const HEARTBEAT_PATHS: readonly Path[] = [
  "keeper tick",
  "first heartbeat",
  "establishment heartbeat",
  "liveness recovery",
];

interface Harness {
  timer: FakeTimer;
  proxy: DaemonMcpProxy;
  /** The daemon answers the session's heartbeats not-found with this reason ("" for none) from now on. */
  release(reason: string): void;
  notify(reason: string): void;
  restartDaemon(): Promise<void>;
  /** The daemon is replaced at once: the old connection closes and the next one is answered. */
  replaceDaemon(): void;
  /** Connections the proxy closed itself while the daemon was still answering on them. */
  connectionResets(): number;
  forwardedCalls(): Array<{ toolName: string; sessionUuid: unknown }>;
  heartbeats(): number;
  close(): Promise<void>;
}

function harness(options: { livenessOwnerToken?: string; roundTripMs?: number } = {}): Harness {
  const timer = new FakeTimer();
  let releasedAs: string | undefined;
  let reachable = true;
  let heartbeats = 0;
  let connectionResets = 0;
  let proxyClosing = false;
  const closedByDaemon = new Set<FakeDaemonClient>();
  const forwarded: Array<{ toolName: string; sessionUuid: unknown }> = [];
  /** What the daemon answers a heartbeat for a session it released (sessionNotFoundResult). */
  const answerDaemonMethod = (method: string, params: Record<string, unknown>): void => {
    if (method !== "daemon/heartbeat" || params.sessionId !== SESSION) {
      return;
    }
    heartbeats += 1;
    if (releasedAs !== undefined) {
      throw Object.assign(new Error(`Session not found: ${SESSION}`), {
        code: DAEMON_SESSION_NOT_FOUND_CODE,
        // A session the daemon holds no release record for is a plain not-found.
        ...(releasedAs === "" ? {} : { releaseReason: releasedAs }),
      });
    }
  };
  const newClient = (): FakeDaemonClient => {
    const created = new FakeDaemonClient({
      toolResultFor: (name) =>
        name === "getAndroid"
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ runtime: { session: { sessionUuid: SESSION } } }),
                },
              ],
            }
          : undefined,
      onCallTool: (toolName, params) => {
        forwarded.push({ toolName, sessionUuid: params.sessionUuid });
        const handsBack = releasedAs === "" || isRecoverableDaemonReleaseReason(releasedAs ?? "-");
        if (params.sessionUuid === SESSION && handsBack) {
          // The daemon hands a session it can recover back to the call that reaches it, and
          // answers its heartbeats again.
          releasedAs = undefined;
        }
      },
      // Answered in the caller's turn unless a round trip is asked for: the table below pins the
      // order of a heartbeat's answer and the call it races as it is without one.
      onCallDaemonMethod: (method, params) =>
        options.roundTripMs === undefined
          ? answerDaemonMethod(method, params)
          : timer.sleep(options.roundTripMs).then(() => answerDaemonMethod(method, params)),
    });
    const close = created.close.bind(created);
    created.close = async () => {
      if (!proxyClosing && !closedByDaemon.has(created)) {
        connectionResets += 1;
      }
      await close();
    };
    return created;
  };
  let client = newClient();
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  const proxy = new DaemonMcpProxy({
    clientFactory: (): DaemonClientLike => client,
    daemonAvailabilityProbe: async () => reachable,
    daemonManager,
    autoStartDaemon: false,
    timer,
    idGenerator: new FakeIdGenerator(),
    heartbeatTimeoutMs: LEASE_MS,
    heartbeatIntervalMs: INTERVAL_MS,
    ...(options.livenessOwnerToken ? { livenessOwnerToken: options.livenessOwnerToken } : {}),
  });
  return {
    timer,
    proxy,
    release: (reason) => {
      releasedAs = reason;
    },
    notify: (reason) =>
      client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, SESSION, reason),
    restartDaemon: async () => {
      const previous = client;
      client = newClient();
      closedByDaemon.add(previous);
      // Nothing listens for longer than one heartbeat request, which starts liveness recovery.
      reachable = false;
      previous.emitConnectionClosed();
      await timer.advanceTimeAsync(LEASE_MS);
      reachable = true;
      await timer.advanceTimeAsync(2 * INTERVAL_MS);
    },
    replaceDaemon: () => {
      const previous = client;
      client = newClient();
      closedByDaemon.add(previous);
      previous.emitConnectionClosed();
    },
    connectionResets: () => connectionResets,
    close: async () => {
      proxyClosing = true;
      // A heartbeat still on its round trip is answered as time passes.
      await timer.resolvePromise(proxy.close(), 1);
    },
    forwardedCalls: () => forwarded.filter((call) => call.toolName !== "getAndroid"),
    heartbeats: () => heartbeats,
  };
}

/** Let the proxy learn of the release on `path`. */
async function learnRelease(world: Harness, path: Path, reason: string): Promise<void> {
  if (path === "first heartbeat") {
    world.release(reason);
    // The acquisition's own outcome is not what is classified here.
    await world.proxy.callTool("getAndroid", {}).catch(() => undefined);
    return;
  }
  await world.proxy.callTool("getAndroid", {});
  await world.timer.advanceTimeAsync(INTERVAL_MS);
  if (path === "notification") {
    world.notify(reason);
  } else if (path === "keeper tick") {
    world.release(reason);
    await world.timer.advanceTimeAsync(2 * INTERVAL_MS);
  } else if (path === "establishment heartbeat") {
    // The proxy learns nothing yet: the call that follows reconnects, and the heartbeat that
    // re-establishes ownership on the new connection is the one answered not-found (#11520).
    world.release(reason);
    world.replaceDaemon();
  } else {
    world.release(reason);
    await world.restartDaemon();
  }
}

/** What a sessionless call does after the release: the binding's UUID rides along, or it is refused. */
async function sessionlessCallAfter(path: Path, reason: string): Promise<string> {
  const world = harness();
  try {
    await learnRelease(world, path, reason);
    // A recoverable handoff: the daemon hands the session back to the call that reaches it.
    world.release(reason);
    const outcome = await world.timer.resolvePromise(world.proxy.callTool("observe", {})).then(
      () => "answered",
      () => "refused",
    );
    const named = world.forwardedCalls().some((call) => call.sessionUuid === SESSION);
    const forwarding = named ? "forwarded under the released session" : "never forwarded under it";
    const connection = world.connectionResets() === 0 ? "kept" : "reset";
    return `${outcome}, ${forwarding}, connection ${connection}`;
  } finally {
    await world.close();
  }
}

describe("release reasons are classified alike on every path", () => {
  test.each(EVERY_REASON)(
    "%s: a not-found heartbeat fences exactly when the notification does",
    async (reason) => {
      // An answer that ends the session is about that session, on a connection that works:
      // nothing is reconnected to hear it again (#11520). A recoverable handoff keeps the binding
      // on every path. It reconnects where the answer came from a daemon the proxy had been
      // talking to, which is going away or restarting the device: the notification, and a keeper
      // tick on an established connection. It keeps the connection where the answer came straight
      // from a connection that was just made, because that daemon is the one to wait for and
      // resetting its connection cuts the call that established it (#11529).
      const recoverable = isRecoverableDaemonReleaseReason(reason);
      const handedBack = "answered, forwarded under the released session, connection";
      const ended = "refused, never forwarded under it, connection kept";
      const byPath: Record<string, string> = {};
      for (const path of ["notification", ...HEARTBEAT_PATHS] as const) {
        byPath[path] = await sessionlessCallAfter(path, reason);
      }
      expect(byPath).toEqual({
        notification: recoverable ? `${handedBack} reset` : ended,
        "keeper tick": recoverable ? `${handedBack} reset` : ended,
        "first heartbeat": recoverable ? `${handedBack} kept` : ended,
        "establishment heartbeat": recoverable ? `${handedBack} kept` : ended,
        "liveness recovery": recoverable ? `${handedBack} kept` : ended,
      });
    },
  );

  // The row for an answer with no reason: a daemon that holds no release record, which is also
  // what a restarted daemon answers until it has rehydrated the session. Only a heartbeat can say
  // so. On an established connection it is retried once on a fresh one; on the connection that was
  // just established there is nothing fresher to ask (#11529).
  test("no reason: the binding is kept on every heartbeat path, and the new connection with it", async () => {
    const kept = "answered, forwarded under the released session, connection";
    expect({
      "keeper tick": await sessionlessCallAfter("keeper tick", ""),
      "establishment heartbeat": await sessionlessCallAfter("establishment heartbeat", ""),
    }).toEqual({
      "keeper tick": `${kept} reset`,
      "establishment heartbeat": `${kept} kept`,
    });
  });

  // The missed-notification backstop for a plan release: `plan-auto-release` is not terminal (the
  // daemon re-issues the UUID to a client that names it in its next plan), yet the proxy must not
  // keep the old binding alive, or the daemon recreates the session for a sessionless call.
  test("a not-found heartbeat naming plan-auto-release ends the binding without a notification", async () => {
    const world = harness();
    try {
      await world.proxy.callTool("getAndroid", {});
      await world.timer.advanceTimeAsync(INTERVAL_MS);
      world.release("plan-auto-release");
      await world.timer.advanceTimeAsync(2 * INTERVAL_MS);

      await expect(world.proxy.callTool("observe", {})).rejects.toThrow("plan-auto-release");
      // Naming the released UUID again is refused the same way while the fence stands.
      await expect(world.proxy.callTool("observe", { sessionUuid: SESSION })).rejects.toThrow(
        "plan-auto-release",
      );
      expect(world.forwardedCalls()).toEqual([]);

      const before = world.heartbeats();
      await world.timer.advanceTimeAsync(3 * INTERVAL_MS);
      expect(world.heartbeats()).toBe(before);
      expect(world.timer.getPendingIntervalCount()).toBe(0);
    } finally {
      await world.close();
    }
  });

  // #11520: a stdio proxy with a stable owner token, whose daemon restarted and ended the bound
  // session for good. The call that reconnects sends the ownership heartbeat and then asks which
  // sessions the token owns; the heartbeat's not-found answer arrives while that is in flight.
  // Resetting the socket for it failed the connection attempt itself, and the call with it
  // ("Daemon socket closed during connection establishment").
  test("the first call after a restart that ended the session gets the terminal refusal, not a connection error", async () => {
    const reason = "identity-recovery-owned-by-other-daemon";
    const world = harness({ livenessOwnerToken: "stable-owner-token", roundTripMs: 5 });
    try {
      await world.timer.resolvePromise(world.proxy.callTool("getAndroid", {}), 1);
      await world.timer.advanceTimeAsync(INTERVAL_MS + 10);
      world.release(reason);
      world.replaceDaemon();

      const refusal = await world.timer.resolvePromise(world.proxy.callTool("observe", {}), 1).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(DaemonBoundSessionExpiredError);
      expect(refusal).toMatchObject({ sessionUuid: SESSION, reason });
      expect(world.connectionResets()).toBe(0);
      expect(world.forwardedCalls()).toEqual([]);
      // Fenced: the keeper has nothing left to heartbeat.
      const before = world.heartbeats();
      await world.timer.advanceTimeAsync(3 * INTERVAL_MS);
      expect(world.heartbeats()).toBe(before);
    } finally {
      await world.close();
    }
  });

  // #11529: the same restart, but the daemon has not rehydrated the session yet (no reason) or
  // released it for a recoverable handoff. The answer came from the connection being established,
  // so nothing is stale: the connection stays and the call itself reaches the daemon.
  test.each(["", "daemon-restart", "daemon-shutdown", "device-restart:emulator-5554"])(
    "the first call after a restart answered not-found (%p) reaches the daemon, not a connection error",
    async (reason) => {
      const world = harness({ livenessOwnerToken: "stable-owner-token", roundTripMs: 5 });
      try {
        await world.timer.resolvePromise(world.proxy.callTool("getAndroid", {}), 1);
        await world.timer.advanceTimeAsync(INTERVAL_MS + 10);
        world.release(reason);
        world.replaceDaemon();

        const outcome = await world.timer
          .resolvePromise(world.proxy.callTool("observe", {}), 1)
          .then(
            () => "answered",
            (error: unknown) => error,
          );

        expect(outcome).toBe("answered");
        expect(world.connectionResets()).toBe(0);
        expect(world.forwardedCalls()).toEqual([{ toolName: "observe", sessionUuid: SESSION }]);
      } finally {
        await world.close();
      }
    },
  );

  // No call arrives: the owner keeps heartbeating the session the restarted daemon has not
  // rehydrated, once a tick on the one connection, for the recovery window and no longer.
  test("a restarted daemon that does not know the session yet is heartbeated once a tick for the window", async () => {
    const world = harness({ livenessOwnerToken: "stable-owner-token", roundTripMs: 5 });
    try {
      await world.timer.resolvePromise(world.proxy.callTool("getAndroid", {}), 1);
      await world.timer.advanceTimeAsync(INTERVAL_MS + 10);
      world.release("");
      world.replaceDaemon();

      const perTick: number[] = [];
      const ticks = RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS / INTERVAL_MS + 4;
      for (let tick = 0; tick < ticks; tick += 1) {
        const before = world.heartbeats();
        await world.timer.advanceTimeAsync(INTERVAL_MS);
        perTick.push(world.heartbeats() - before);
      }

      expect(world.connectionResets()).toBe(0);
      expect(Math.max(...perTick)).toBe(1);
      // Every tick whose answer arrived inside the window, and the one whose answer closed it.
      const asked = perTick.filter((sent) => sent === 1).length;
      const windowTicks = RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS / INTERVAL_MS;
      expect(asked).toBeGreaterThanOrEqual(windowTicks);
      expect(asked).toBeLessThanOrEqual(windowTicks + 2);
      expect(perTick.slice(-2)).toEqual([0, 0]);
      // Still bound: the call that comes later reaches the daemon under the session.
      await world.timer.resolvePromise(world.proxy.callTool("observe", {}), 1);
      expect(world.forwardedCalls()).toEqual([{ toolName: "observe", sessionUuid: SESSION }]);
    } finally {
      await world.close();
    }
  });

  // A not-found answer that names no release says nothing final (a replacement daemon that has
  // not materialised the session yet answers the same way), so it keeps its reconnect-and-retry.
  test("a not-found heartbeat with no release reason still reconnects once and fences nothing", async () => {
    const world = harness();
    try {
      await world.proxy.callTool("getAndroid", {});
      await world.timer.advanceTimeAsync(INTERVAL_MS);
      world.release("");
      await world.timer.advanceTimeAsync(2 * INTERVAL_MS);

      expect(world.connectionResets()).toBe(1);
      await world.timer.resolvePromise(world.proxy.callTool("observe", {}));
      expect(world.forwardedCalls()).toEqual([{ toolName: "observe", sessionUuid: SESSION }]);
    } finally {
      await world.close();
    }
  });
});
