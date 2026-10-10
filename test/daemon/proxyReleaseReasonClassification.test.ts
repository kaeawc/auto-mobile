import { describe, expect, test } from "bun:test";
import type { DaemonClientLike } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { DaemonBoundSessionExpiredError, DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
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
      await proxy.close();
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
      // nothing is reconnected to hear it again (#11520). A recoverable handoff reconnects, because
      // the daemon that released the session is going away or is still recovering it.
      const expected = isRecoverableDaemonReleaseReason(reason)
        ? "answered, forwarded under the released session, connection reset"
        : "refused, never forwarded under it, connection kept";
      const byPath: Record<string, string> = {};
      for (const path of ["notification", ...HEARTBEAT_PATHS] as const) {
        byPath[path] = await sessionlessCallAfter(path, reason);
      }
      expect(byPath).toEqual({
        notification: expected,
        "keeper tick": expected,
        "first heartbeat": expected,
        "establishment heartbeat": expected,
        "liveness recovery": expected,
      });
    },
  );

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
