import { beforeAll, describe, expect, test } from "bun:test";
import type { DaemonClientLike } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import {
  DaemonBoundSessionExpiredError,
  DaemonMcpProxy,
  decideNotFoundAnswer,
  type NotFoundAnswerFacts,
  type NotFoundAnswerOutcome,
  RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
  UNREHYDRATED_HANDOFF,
} from "../../src/daemon/daemonMcpProxy";
import {
  isRecoverableDaemonReleaseReason,
  SESSION_RELEASE_REASON_FAMILY_TRAITS,
  SESSION_RELEASE_REASON_TRAITS,
} from "../../src/daemon/releaseReasons";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import { ROUTED_SESSION_META_KEY } from "../../src/server/routedSessionMeta";
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
/** What the acquisitions after the first mint, in order. */
const LATER_SESSIONS = ["second-session", "third-session"] as const;
const [SECOND, THIRD] = LATER_SESSIONS;
const WINDOW_TICKS = RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS / INTERVAL_MS;

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
  /**
   * The daemon answers the session's heartbeats not-found with this reason ("" for none) from now
   * on, or acknowledges them again (`undefined`).
   */
  release(reason: string | undefined, sessionUuid?: string): void;
  notify(reason: string): void;
  restartDaemon(): Promise<void>;
  /** The daemon is replaced at once: the old connection closes and the next one is answered. */
  replaceDaemon(): void;
  /**
   * The daemon is replaced the next time the proxy closes its connection itself, and its
   * successor answers each of `sessions` not-found with no reason: it has rehydrated nothing.
   */
  succeedDaemonOnReset(sessions: readonly string[]): void;
  /**
   * The daemon goes silent: it answers nothing more on the connection it has. The next
   * connection reaches its replacement.
   */
  stallAndReplaceDaemon(): void;
  /** The daemon answers no heartbeat for `pauseMs`, then every one it was asked, in order. */
  pauseDaemon(pauseMs: number): void;
  /** From now on a call that reaches a released session restores nothing, as a read does. */
  callsRestoreNothing(): void;
  /** Connections the proxy closed itself while the daemon was still answering on them. */
  connectionResets(): number;
  forwardedCalls(): Array<{ toolName: string; sessionUuid: unknown }>;
  heartbeats(sessionUuid?: string): number;
  close(): Promise<void>;
}

function harness(options: { livenessOwnerToken?: string; roundTripMs?: number } = {}): Harness {
  const timer = new FakeTimer();
  const releasedAs = new Map<string, string>();
  const heartbeats = new Map<string, number>();
  const minted: string[] = [];
  let reachable = true;
  let connectionResets = 0;
  let callsRestore = true;
  let successorKnowsNone: readonly string[] | undefined;
  const succeeded = new Map<FakeDaemonClient, Map<string, string>>();
  let proxyClosing = false;
  const closedByDaemon = new Set<FakeDaemonClient>();
  const silent = new Set<FakeDaemonClient>();
  let pausedUntil = 0;
  const forwarded: Array<{ toolName: string; sessionUuid: unknown }> = [];
  /** What the daemon answers a heartbeat for a session it released (sessionNotFoundResult). */
  const answerDaemonMethod = (
    method: string,
    params: Record<string, unknown>,
    answering: FakeDaemonClient,
  ): void => {
    const sessionUuid = params.sessionId;
    if (method !== "daemon/heartbeat" || typeof sessionUuid !== "string") {
      return;
    }
    heartbeats.set(sessionUuid, (heartbeats.get(sessionUuid) ?? 0) + 1);
    // A daemon that was succeeded answers what it still had in flight from what it knew.
    const reason = (succeeded.get(answering) ?? releasedAs).get(sessionUuid);
    if (reason !== undefined) {
      throw Object.assign(new Error(`Session not found: ${sessionUuid}`), {
        code: DAEMON_SESSION_NOT_FOUND_CODE,
        // A session the daemon holds no release record for is a plain not-found.
        ...(reason === "" ? {} : { releaseReason: reason }),
      });
    }
  };
  const mintSession = (): string => {
    const sessionUuid = minted.length === 0 ? SESSION : LATER_SESSIONS[minted.length - 1]!;
    minted.push(sessionUuid);
    return sessionUuid;
  };
  const newClient = (): FakeDaemonClient => {
    const created = new FakeDaemonClient({
      toolResultFor: (name, params) =>
        name === "getAndroid"
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ runtime: { session: { sessionUuid: mintSession() } } }),
                },
              ],
            }
          : name === "tapOn"
            ? // A control call: the daemon echoes the session it admitted the call under and used.
              {
                content: [{ type: "text", text: "tapped" }],
                _meta: { [ROUTED_SESSION_META_KEY]: params.sessionUuid },
              }
            : undefined,
      onCallTool: (toolName, params) => {
        forwarded.push({ toolName, sessionUuid: params.sessionUuid });
        const named = typeof params.sessionUuid === "string" ? params.sessionUuid : "";
        const reason = releasedAs.get(named);
        if (callsRestore && (reason === "" || isRecoverableDaemonReleaseReason(reason ?? "-"))) {
          // The daemon hands a session it can recover back to the call that reaches it, and
          // answers its heartbeats again.
          releasedAs.delete(named);
        }
      },
      // Answered in the caller's turn unless a round trip is asked for: the table below pins the
      // order of a heartbeat's answer and the call it races as it is without one.
      onCallDaemonMethod: (method, params) =>
        silent.has(created)
          ? new Promise<never>(() => undefined)
          : method === "daemon/heartbeat" && timer.now() < pausedUntil
            ? timer
                .sleep(pausedUntil - timer.now())
                .then(() => answerDaemonMethod(method, params, created))
            : options.roundTripMs === undefined
              ? answerDaemonMethod(method, params, created)
              : timer
                  .sleep(options.roundTripMs)
                  .then(() => answerDaemonMethod(method, params, created)),
    });
    const close = created.close.bind(created);
    created.close = async () => {
      if (!proxyClosing && !closedByDaemon.has(created)) {
        connectionResets += 1;
        if (successorKnowsNone !== undefined && client === created) {
          succeeded.set(created, new Map(releasedAs));
          client = newClient();
          successorKnowsNone.forEach((sessionUuid) => releasedAs.set(sessionUuid, ""));
          successorKnowsNone = undefined;
        }
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
    release: (reason, sessionUuid = SESSION) => {
      if (reason === undefined) {
        releasedAs.delete(sessionUuid);
      } else {
        releasedAs.set(sessionUuid, reason);
      }
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
    succeedDaemonOnReset: (sessions) => {
      successorKnowsNone = sessions;
    },
    pauseDaemon: (pauseMs) => {
      pausedUntil = timer.now() + pauseMs;
    },
    stallAndReplaceDaemon: () => {
      silent.add(client);
      closedByDaemon.add(client);
      client = newClient();
    },
    callsRestoreNothing: () => {
      callsRestore = false;
    },
    connectionResets: () => connectionResets,
    close: async () => {
      proxyClosing = true;
      // A heartbeat still on its round trip is answered as time passes.
      await timer.resolvePromise(proxy.close(), 1);
    },
    forwardedCalls: () => forwarded.filter((call) => call.toolName !== "getAndroid"),
    heartbeats: (sessionUuid = SESSION) => heartbeats.get(sessionUuid) ?? 0,
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
  // The first history through the proxy pays for loading and compiling it; that is not any one
  // test's time. Every path once, outside the timed tests.
  beforeAll(async () => {
    for (const path of ["notification", ...HEARTBEAT_PATHS] as const) {
      await sessionlessCallAfter(path, "daemon-restart");
      await sessionlessCallAfter(path, "device-killed");
    }
  });

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

interface Held {
  world: Harness;
  /** Heartbeats each session got on each of the next `ticks` keeper ticks. */
  perTick(ticks: number): Promise<Record<string, number[]>>;
}

/** A proxy holding `sessions` (the last one is its latest binding), heartbeated once. */
async function holding(sessions: readonly string[]): Promise<Held> {
  const world = harness({ livenessOwnerToken: "stable-owner-token", roundTripMs: 5 });
  for (let acquired = 0; acquired < sessions.length; acquired += 1) {
    await world.timer.resolvePromise(world.proxy.callTool("getAndroid", {}), 1);
  }
  await world.timer.advanceTimeAsync(INTERVAL_MS + 10);
  return {
    world,
    perTick: async (ticks) => {
      const sent: Record<string, number[]> = Object.fromEntries(sessions.map((id) => [id, []]));
      for (let tick = 0; tick < ticks; tick += 1) {
        const before = sessions.map((id) => world.heartbeats(id));
        await world.timer.advanceTimeAsync(INTERVAL_MS);
        sessions.forEach((id, index) => sent[id]!.push(world.heartbeats(id) - before[index]!));
      }
      return sent;
    },
  };
}

// #11557: the proxy holds every session it acquired, not only the latest. A daemon that restarted
// answers the first heartbeat of each of them on the new connection the same way, so each is
// decided the same way: a session the daemon has not rehydrated yet is heartbeated through the
// window, whichever acquisition minted it, and one that ended is dropped alone.
describe("every held session is re-established on a new connection as the latest is", () => {
  test("a restarted daemon that knows none of them yet is heartbeated for each, once a tick for the window", async () => {
    const { world, perTick } = await holding([SESSION, SECOND]);
    try {
      world.release("", SESSION);
      world.release("", SECOND);
      world.replaceDaemon();

      const sent = await perTick(WINDOW_TICKS + 4);

      expect(world.connectionResets()).toBe(0);
      // The held session is asked on exactly the ticks the latest binding is.
      expect(sent[SESSION]).toEqual(sent[SECOND]!);
      expect(Math.max(...sent[SESSION]!)).toBe(1);
      const asked = sent[SESSION]!.filter((count) => count === 1).length;
      expect(asked).toBeGreaterThanOrEqual(WINDOW_TICKS);
      expect(asked).toBeLessThanOrEqual(WINDOW_TICKS + 2);
      expect(sent[SESSION]!.slice(-2)).toEqual([0, 0]);
      // Nothing left to wait for: the keeper stops.
      expect(world.timer.getPendingIntervalCount()).toBe(0);
    } finally {
      await world.close();
    }
  });

  test("a held session the daemon rehydrates inside the window is held from then on", async () => {
    const { world, perTick } = await holding([SESSION, SECOND]);
    try {
      world.release("", SESSION);
      world.release("", SECOND);
      world.replaceDaemon();
      await perTick(5);
      // The daemon rehydrated both and found their owner's heartbeats waiting.
      world.release(undefined, SESSION);
      world.release(undefined, SECOND);

      const sent = await perTick(WINDOW_TICKS + 4);

      expect(sent[SESSION]).toEqual(sent[SESSION]!.map(() => 1));
      expect(sent[SECOND]).toEqual(sent[SECOND]!.map(() => 1));
      expect(world.connectionResets()).toBe(0);
    } finally {
      await world.close();
    }
  });

  test("mixed answers: one ended, one not rehydrated yet, one live; each is decided alone", async () => {
    const { world, perTick } = await holding([SESSION, SECOND, THIRD]);
    try {
      world.release("device-killed", SESSION);
      world.release("", SECOND);
      world.replaceDaemon();

      const sent = await perTick(6);

      // The ended one is asked once and dropped; the connection its siblings use is kept.
      expect(sent[SESSION]).toEqual([1, 0, 0, 0, 0, 0]);
      expect(sent[SECOND]).toEqual([1, 1, 1, 1, 1, 1]);
      expect(sent[THIRD]).toEqual([1, 1, 1, 1, 1, 1]);
      expect(world.connectionResets()).toBe(0);
    } finally {
      await world.close();
    }
  });

  test("a held session that ends for good inside the window is dropped then, and only it", async () => {
    const { world, perTick } = await holding([SESSION, SECOND, THIRD]);
    try {
      for (const sessionUuid of [SESSION, SECOND, THIRD]) {
        world.release("", sessionUuid);
      }
      world.replaceDaemon();
      await perTick(4);
      // The daemon rehydrated it and released it for good: no owner returned in time.
      world.release("rehydration-owner-timeout", SESSION);

      const sent = await perTick(4);

      expect(sent[SESSION]).toEqual([1, 0, 0, 0]);
      expect(sent[SECOND]).toEqual([1, 1, 1, 1]);
      expect(sent[THIRD]).toEqual([1, 1, 1, 1]);
      expect(world.connectionResets()).toBe(0);
    } finally {
      await world.close();
    }
  });

  test("the latest binding ending for good on the new connection leaves the held ones waited for", async () => {
    const { world, perTick } = await holding([SESSION, SECOND]);
    try {
      world.release("", SESSION);
      world.release("device-killed", SECOND);
      world.replaceDaemon();

      const sent = await perTick(4);

      expect(sent[SESSION]).toEqual([1, 1, 1, 1]);
      expect(sent[SECOND]).toEqual([1, 0, 0, 0]);
      expect(world.connectionResets()).toBe(0);
      // Terminal for that session only: its call is refused here, never forwarded.
      await expect(world.proxy.callTool("observe", {})).rejects.toThrow("device-killed");
      expect(world.forwardedCalls()).toEqual([]);
    } finally {
      await world.close();
    }
  });

  test("a held session answered not-found with no reason on a connection that had answered is still dropped at once", async () => {
    const { world, perTick } = await holding([SESSION, SECOND]);
    try {
      world.release("", SESSION);

      const sent = await perTick(4);

      expect(sent[SESSION]).toEqual([1, 0, 0, 0]);
      expect(sent[SECOND]).toEqual([1, 1, 1, 1]);
      expect(world.connectionResets()).toBe(0);
    } finally {
      await world.close();
    }
  });

  // The latest binding's not-found on a connection that had answered is asked once more on a
  // fresh one. That connection is the proxy's own doing, to the daemon it was already talking to:
  // it re-establishes nothing, so the held session is not waited for either.
  test("the connection made to ask the latest binding's not-found again opens no window for a held session", async () => {
    const { world, perTick } = await holding([SESSION, SECOND]);
    try {
      world.release("", SESSION);
      world.release("", SECOND);

      const sent = await perTick(5);

      expect(world.connectionResets()).toBe(1);
      const total = (counts: number[]) => counts.reduce((sum, count) => sum + count, 0);
      // The latest binding: asked, and asked again on the fresh connection.
      expect(total(sent[SECOND]!)).toBe(2);
      expect(sent[SECOND]!.slice(-3)).toEqual([0, 0, 0]);
      // The held session: its one answer, and at most the heartbeat the reset cut short.
      expect(total(sent[SESSION]!)).toBeLessThanOrEqual(2);
      expect(sent[SESSION]!.slice(-3)).toEqual([0, 0, 0]);
      expect(world.timer.getPendingIntervalCount()).toBe(0);
    } finally {
      await world.close();
    }
  });

  test("closing inside the window leaves no timer behind", async () => {
    const { world, perTick } = await holding([SESSION, SECOND]);
    world.release("", SESSION);
    world.release("", SECOND);
    world.replaceDaemon();
    await perTick(3);

    await world.close();

    expect(world.timer.getPendingIntervalCount()).toBe(0);
    const before = [world.heartbeats(SESSION), world.heartbeats(SECOND)];
    await world.timer.advanceTimeAsync(RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS);
    expect([world.heartbeats(SESSION), world.heartbeats(SECOND)]).toEqual(before);
  });
});

// #11570: every not-found heartbeat answer is decided in one place (decideNotFoundAnswer) from
// the session's own state, whichever heartbeat heard it. The state machine is written out in
// proxyHeartbeatStateMachine.property.test.ts; these are its rows that had been decided
// differently by the path the answer arrived on.
describe("a not-found answer is decided alike on every path, for every session (#11570)", () => {
  const ones = (ticks: number): number[] => Array.from({ length: ticks }, () => 1);

  // The daemon was unreachable for longer than a heartbeat request, so liveness recovery asks
  // the daemon that replaced it. That answer is each session's first on the new connection.
  test("liveness recovery reaching a restarted daemon waits for every session it has not rehydrated", async () => {
    const { world, perTick } = await holding([SESSION, SECOND, THIRD]);
    try {
      for (const sessionUuid of [SESSION, SECOND, THIRD]) {
        world.release("", sessionUuid);
      }
      await world.restartDaemon();

      const waited = await perTick(4);
      // The daemon rehydrated two of them and found their owner's heartbeats waiting.
      world.release(undefined, SESSION);
      world.release(undefined, SECOND);
      const sent = await perTick(WINDOW_TICKS + 4);

      expect(waited).toEqual({ [SESSION]: ones(4), [SECOND]: ones(4), [THIRD]: ones(4) });
      expect(sent[SESSION]).toEqual(ones(WINDOW_TICKS + 4));
      expect(sent[SECOND]).toEqual(ones(WINDOW_TICKS + 4));
      // The latest binding was never rehydrated: its window ends, and nothing is fenced.
      expect(sent[THIRD]!.slice(-2)).toEqual([0, 0]);
      expect(world.connectionResets()).toBe(0);
      await world.timer.resolvePromise(world.proxy.callTool("observe", {}), 1);
      expect(world.forwardedCalls()).toEqual([{ toolName: "observe", sessionUuid: THIRD }]);
    } finally {
      await world.close();
    }
  });

  // The daemon goes silent with the connection open, so no heartbeat is answered and liveness
  // recovery replaces the connection itself. Its own heartbeat is then each session's first
  // answer on the connection to the replacement daemon, which has rehydrated none of them.
  test("liveness recovery that replaces a silent connection waits for every session on the new one", async () => {
    const { world, perTick } = await holding([SESSION, SECOND, THIRD]);
    try {
      for (const sessionUuid of [SESSION, SECOND, THIRD]) {
        world.release("", sessionUuid);
      }
      world.stallAndReplaceDaemon();
      // The heartbeats time out, and recovery's second attempt replaces the connection.
      await world.timer.advanceTimeAsync(2 * LEASE_MS);

      const sent = await perTick(4);

      expect(sent).toEqual({ [SESSION]: ones(4), [SECOND]: ones(4), [THIRD]: ones(4) });
      expect(world.connectionResets()).toBe(0);
    } finally {
      await world.close();
    }
  });

  // A read is answered without the session, and restores none. It said nothing about the
  // session, so the window it is in stays as it is: not dropped (the next answer would be asked
  // again on a fresh connection) and not started over.
  test("a call that restores nothing neither drops the session's window nor extends it", async () => {
    /** The ticks on which the session was asked, with or without a read two ticks in. */
    const askedTicks = async (read: boolean): Promise<{ asked: boolean[]; resets: number }> => {
      const { world, perTick } = await holding([SESSION]);
      try {
        world.release("");
        world.replaceDaemon();
        world.callsRestoreNothing();
        await perTick(2);
        if (read) {
          await world.timer.resolvePromise(world.proxy.callTool("observe", {}), 1);
        }
        const sent = await perTick(WINDOW_TICKS + 2);
        return {
          asked: sent[SESSION]!.map((count) => count > 0),
          resets: world.connectionResets(),
        };
      } finally {
        await world.close();
      }
    };

    const undisturbed = await askedTicks(false);
    const withRead = await askedTicks(true);

    expect(withRead).toEqual(undisturbed);
    expect(withRead.resets).toBe(0);
    expect(withRead.asked.slice(0, WINDOW_TICKS - 3)).not.toContain(false);
    expect(withRead.asked.slice(-2)).toEqual([false, false]);
  });

  // Past its window a session is asked once after each call that reaches it, on the connection
  // it has: its window is not opened again, and the connection is not reset to ask again.
  test("past the window a call that restores nothing gets one more heartbeat and no reconnect", async () => {
    const { world, perTick } = await holding([SESSION]);
    try {
      world.release("");
      world.replaceDaemon();
      world.callsRestoreNothing();
      await perTick(WINDOW_TICKS + 3);

      await world.timer.resolvePromise(world.proxy.callTool("observe", {}), 1);
      const sent = await perTick(4);

      expect(sent[SESSION]!.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(1);
      expect(sent[SESSION]!.slice(-2)).toEqual([0, 0]);
      expect(world.connectionResets()).toBe(0);
    } finally {
      await world.close();
    }
  });

  // A window belongs to a handoff. One the session was not told of before is a new handoff: the
  // daemon is handing the session back, so its owner waits again, also after an earlier
  // handoff's window ran out, once the call that reached the session re-armed its heartbeat.
  test("a handoff the session was not told of before opens a new window after an expired one", async () => {
    const { world, perTick } = await holding([SESSION]);
    try {
      world.release("");
      world.replaceDaemon();
      world.callsRestoreNothing();
      await perTick(WINDOW_TICKS + 3);
      world.release("device-restart:emulator-5554");

      await world.timer.resolvePromise(world.proxy.callTool("observe", {}), 1);
      const sent = await perTick(5);

      expect(sent[SESSION]!.slice(-4)).toEqual(ones(4));
    } finally {
      await world.close();
    }
  });

  // I6: the same handoff never gets a second window, however often a call that restores nothing
  // re-arms the heartbeat: each such call is answered by one more heartbeat and no more.
  test.each(["", "device-restart:emulator-5554"])(
    "reads never earn the same handoff (%p) another window",
    async (reason) => {
      const { world, perTick } = await holding([SESSION]);
      try {
        world.callsRestoreNothing();
        world.release(reason);
        world.replaceDaemon();
        await perTick(WINDOW_TICKS + 3);
        const before = world.heartbeats();

        for (let read = 0; read < 4; read += 1) {
          await world.timer.resolvePromise(world.proxy.callTool("observe", {}), 1);
          await perTick(3);
        }

        expect(world.heartbeats() - before).toBeLessThanOrEqual(4);
        expect(world.connectionResets()).toBe(0);
      } finally {
        await world.close();
      }
    },
  );

  // I6 again, by the other road: the daemon pauses for longer than a heartbeat request is given,
  // so the keeper gives up on the heartbeat whose answer finds the window expired, and liveness
  // recovery asks again, on the same connection or (a longer pause) on one it replaced. That
  // connection reaches the same daemon and the same handoff: the session is stopped as it would
  // have been, never waited for all over again, also when the daemon pauses at every expiry.
  // Recorded once: who is paused, under which handoff, for how long, and from which tick around
  // the one whose answer finds the window expired. One test replays each case.
  const PAUSE_CASES = (
    [
      ["the latest binding", [SESSION], "device-restart:emulator-5554"],
      ["a held session", [SESSION, SECOND], "device-restart:emulator-5554"],
      ["the latest binding", [SESSION], ""],
      ["a held session", [SESSION, SECOND], ""],
    ] as const
  ).flatMap(([which, sessions, reason]) =>
    [3_250, 5_000, 7_000].flatMap((pauseMs) =>
      [-4, -3, -2, -1, 0, 1].map(
        (offset) => [which, reason, pauseMs, WINDOW_TICKS + offset, sessions] as const,
      ),
    ),
  );

  test("the pause sweep replays every recorded case", () => {
    expect(PAUSE_CASES).toHaveLength(4 * 3 * 6);
  });

  test.each(PAUSE_CASES)(
    "a window that expires while the daemon is paused is not opened again: %s, %p, paused %d ms at tick %d",
    async (_which, reason, pauseMs, pausedAt, sessions) => {
      const { world, perTick } = await holding(sessions);
      try {
        world.callsRestoreNothing();
        world.release(reason, SESSION);
        if (reason === "") {
          world.release("", SECOND);
          world.replaceDaemon();
        }
        const before = world.heartbeats(SESSION);
        await perTick(pausedAt);
        world.pauseDaemon(pauseMs);
        await perTick(WINDOW_TICKS);
        // And again where a second window would run out, were there one.
        world.pauseDaemon(pauseMs);
        await perTick(WINDOW_TICKS);

        expect(world.heartbeats(SESSION) - before).toBeLessThanOrEqual(WINDOW_TICKS + 12);
      } finally {
        await world.close();
      }
    },
  );

  // The daemon answers the latest binding's heartbeat with a recoverable handoff: it is going
  // away. The proxy asks once more on a fresh connection, which reaches the successor. That
  // daemon has rehydrated nothing, so every session held gets its first answer there.
  test("asking a handoff answer again on the successor daemon waits for every held session", async () => {
    const { world, perTick } = await holding([SESSION, SECOND, THIRD]);
    try {
      world.release("daemon-restart", THIRD);
      world.succeedDaemonOnReset([SESSION, SECOND, THIRD]);

      const sent = await perTick(6);

      expect(world.connectionResets()).toBe(1);
      for (const sessionUuid of [SESSION, SECOND, THIRD]) {
        expect(sent[sessionUuid]!.slice(-4)).toEqual(ones(4));
      }
    } finally {
      await world.close();
    }
  });

  // The fence is the latest binding's alone. It lands while the call that reconnects is still
  // establishing the connection; that call names another session, which the daemon still holds.
  test("a call naming a live held session is not refused for the latest binding fenced while it reconnects", async () => {
    const { world } = await holding([SESSION, SECOND]);
    try {
      world.release("device-killed", SECOND);
      world.replaceDaemon();

      const outcome = await world.timer
        .resolvePromise(world.proxy.callTool("tapOn", { sessionUuid: SESSION, text: "Go" }), 1)
        .then(
          () => "answered",
          (error: unknown) => error,
        );

      expect(outcome).toBe("answered");
      expect(world.forwardedCalls()).toEqual([{ toolName: "tapOn", sessionUuid: SESSION }]);
      // The session that ended is no longer heartbeated; the one the call named still is.
      const before = [world.heartbeats(SESSION), world.heartbeats(SECOND)];
      await world.timer.advanceTimeAsync(3 * INTERVAL_MS);
      expect(world.heartbeats(SESSION)).toBe(before[0]! + 3);
      expect(world.heartbeats(SECOND)).toBe(before[1]!);
    } finally {
      await world.close();
    }
  });

  // A held session the daemon answered not-found for with no reason is dropped, not fenced: the
  // daemon may hand it back to a call. Once a call was admitted under it and used it, the proxy
  // owns a live session again and must heartbeat it, or the daemon releases it for silence.
  test("a held session dropped for a not-found answer is heartbeated again once a call uses it", async () => {
    const { world, perTick } = await holding([SESSION, SECOND]);
    try {
      world.release("", SESSION);
      const dropped = await perTick(3);

      await world.timer.resolvePromise(
        world.proxy.callTool("tapOn", { sessionUuid: SESSION, text: "Go" }),
        1,
      );
      const sent = await perTick(4);

      expect(dropped[SESSION]).toEqual([1, 0, 0]);
      expect(sent[SESSION]).toEqual(ones(4));
      expect(sent[SECOND]).toEqual(ones(4));
      // Naming it did not move the binding: sessionless calls stay on the latest one.
      await world.timer.resolvePromise(world.proxy.callTool("observe", {}), 1);
      expect(world.forwardedCalls().at(-1)).toEqual({ toolName: "observe", sessionUuid: SECOND });
    } finally {
      await world.close();
    }
  });

  // Reads never hold a session: only the daemon's echo of admitted use restores one.
  test("a read naming a dropped held session does not hold it again", async () => {
    const { world, perTick } = await holding([SESSION, SECOND]);
    try {
      world.release("", SESSION);
      await perTick(3);

      await world.timer.resolvePromise(
        world.proxy.callTool("observe", { sessionUuid: SESSION }),
        1,
      );
      const sent = await perTick(4);

      expect(sent[SESSION]).toEqual([0, 0, 0, 0]);
      expect(sent[SECOND]).toEqual(ones(4));
    } finally {
      await world.close();
    }
  });

  // A session released for good while it was dropped is never held again, whatever a call says.
  test("a dropped held session the daemon then released for good is never heartbeated again", async () => {
    const { world, perTick } = await holding([SESSION, SECOND]);
    try {
      world.release("", SESSION);
      await perTick(3);
      world.notify("device-killed");

      await world.timer
        .resolvePromise(world.proxy.callTool("tapOn", { sessionUuid: SESSION, text: "Go" }), 1)
        .catch(() => undefined);
      const sent = await perTick(4);

      expect(sent[SESSION]).toEqual([0, 0, 0, 0]);
      expect(sent[SECOND]).toEqual(ones(4));
    } finally {
      await world.close();
    }
  });

  test("closing forgets every window and stopped session", async () => {
    const { world, perTick } = await holding([SESSION, SECOND, THIRD]);
    world.release("", SESSION);
    await perTick(2);
    world.release("", SECOND);
    world.release("", THIRD);
    world.replaceDaemon();
    await perTick(3);

    await world.close();

    expect(world.timer.getPendingIntervalCount()).toBe(0);
    expect(world.timer.getPendingTimeoutCount()).toBe(0);
    const before = [SESSION, SECOND, THIRD].map((id) => world.heartbeats(id));
    await world.timer.advanceTimeAsync(RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS);
    expect([SESSION, SECOND, THIRD].map((id) => world.heartbeats(id))).toEqual(before);
  });
});

describe("decideNotFoundAnswer", () => {
  const W = RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS;
  const NOW = 100_000;
  const RECOVERABLE = ["daemon-restart", "daemon-shutdown", "device-restart:emulator-5554"];
  const handoffOf = (releaseReason: string): string => `release:${releaseReason}`;
  const facts = (overrides: Partial<NotFoundAnswerFacts>): NotFoundAnswerFacts => ({
    releaseReason: undefined,
    owned: true,
    establishes: false,
    windowSince: undefined,
    handoffs: new Set(),
    now: NOW,
    mayAskAgain: false,
    ...overrides,
  });
  const STOPPED: NotFoundAnswerOutcome = { kind: "stopped" };
  /** Every state a session that has had a window for `handoffs` can be in. */
  const statesWith = (handoffs: readonly string[]): Array<Partial<NotFoundAnswerFacts>> =>
    [NOW, NOW - 1, NOW - W + 1, NOW - W, NOW - 10 * W].flatMap((windowSince) =>
      [false, true].flatMap((establishes) =>
        [false, true].map((mayAskAgain) => ({
          windowSince,
          handoffs: new Set(handoffs),
          establishes,
          mayAskAgain,
        })),
      ),
    );

  // I2: a reason that is not a recoverable handoff of an owned session ends it, whatever else
  // is true of the session, and under that reason.
  test.each(EVERY_REASON.filter((reason) => !isRecoverableDaemonReleaseReason(reason)))(
    "%s ends the session in every state",
    (releaseReason) => {
      const states = [facts({}), ...statesWith([UNREHYDRATED_HANDOFF]).map(facts)];
      for (const state of states) {
        expect(decideNotFoundAnswer({ ...state, releaseReason })).toEqual({
          kind: "ended",
          reason: releaseReason,
        });
      }
    },
  );

  test("a recoverable reason ends a session this proxy does not own", () => {
    expect(decideNotFoundAnswer(facts({ releaseReason: "daemon-restart", owned: false }))).toEqual({
      kind: "ended",
      reason: "daemon-restart",
    });
  });

  // I6: a handoff gets one window. Once the session has had it, no answer of that handoff opens
  // or extends one, whichever connection it arrives on and whoever asks: inside the window it is
  // awaited as it stands, past it the session is stopped, and the connection is left alone.
  test.each([
    ...RECOVERABLE.map((reason) => [reason, handoffOf(reason)]),
    ["", UNREHYDRATED_HANDOFF],
  ])("a handoff the session had its window for (%p) never opens another", (reason, handoff) => {
    const releaseReason = reason === "" ? undefined : reason;
    for (const state of statesWith([handoff!])) {
      const open = NOW - state.windowSince! < W;
      expect(decideNotFoundAnswer(facts({ ...state, releaseReason }))).toEqual(
        open ? { kind: "awaited", windowSince: state.windowSince! } : STOPPED,
      );
    }
  });

  // A handoff the session was not told of before opens its one window now, also when an earlier
  // handoff's window is still open or long over.
  test.each(RECOVERABLE)("a new handoff (%s) opens one window", (releaseReason) => {
    const opened = { kind: "awaited", windowSince: NOW, handoff: handoffOf(releaseReason) };
    for (const state of statesWith([UNREHYDRATED_HANDOFF, "release:another-handoff"])) {
      const open = NOW - state.windowSince! < W;
      // Outside any window the latest binding first asks a connection that had answered again.
      const asksAgain = !open && !state.establishes && state.mayAskAgain;
      expect(decideNotFoundAnswer(facts({ ...state, releaseReason }))).toEqual(
        asksAgain ? { kind: "ask-again", handoff: true } : opened,
      );
    }
    expect(decideNotFoundAnswer(facts({ releaseReason }))).toEqual(opened);
    expect(decideNotFoundAnswer(facts({ releaseReason, mayAskAgain: true }))).toEqual({
      kind: "ask-again",
      handoff: true,
    });
  });

  test("no reason opens the unrehydrated window only as the first answer on a connection just made", () => {
    const opened = { kind: "awaited", windowSince: NOW, handoff: UNREHYDRATED_HANDOFF };
    for (const mayAskAgain of [false, true]) {
      for (const windowSince of [undefined, NOW - W]) {
        const handoffs = new Set(windowSince === undefined ? [] : ["release:daemon-restart"]);
        expect(
          decideNotFoundAnswer(facts({ establishes: true, windowSince, handoffs, mayAskAgain })),
        ).toEqual(opened);
      }
      // A session this proxy does not own is never waited for.
      expect(decideNotFoundAnswer(facts({ establishes: true, owned: false }))).toEqual(STOPPED);
    }
  });

  test("no reason on a connection that had answered: asked again once if it never had a window, then stopped", () => {
    expect(decideNotFoundAnswer(facts({ mayAskAgain: true }))).toEqual({
      kind: "ask-again",
      handoff: false,
    });
    expect(decideNotFoundAnswer(facts({}))).toEqual(STOPPED);
    // I1: inside another handoff's window it is awaited, and nothing is asked again.
    const handoffs = new Set(["release:daemon-restart"]);
    for (const mayAskAgain of [false, true]) {
      expect(decideNotFoundAnswer(facts({ windowSince: NOW - 1, handoffs, mayAskAgain }))).toEqual({
        kind: "awaited",
        windowSince: NOW - 1,
      });
      expect(decideNotFoundAnswer(facts({ windowSince: NOW - W, handoffs, mayAskAgain }))).toEqual(
        STOPPED,
      );
    }
  });
});
