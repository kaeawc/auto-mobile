import { describe, expect, test } from "bun:test";
import type { DaemonClientLike } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
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

// The proxy learns that the daemon released a session in four ways: the session-released
// notification, and a heartbeat answered not-found with the release reason on a keeper tick, on
// the binding's first heartbeat, or during liveness recovery. All four classify the reason in one
// place (DaemonMcpProxy.releaseKeepsBinding): the binding survives only a recoverable handoff.
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

type Path = "notification" | "keeper tick" | "first heartbeat" | "liveness recovery";
const HEARTBEAT_PATHS: readonly Path[] = ["keeper tick", "first heartbeat", "liveness recovery"];

interface Harness {
  timer: FakeTimer;
  proxy: DaemonMcpProxy;
  /** The daemon answers the session's heartbeats not-found with this reason from now on. */
  release(reason: string): void;
  notify(reason: string): void;
  restartDaemon(): Promise<void>;
  forwardedCalls(): Array<{ toolName: string; sessionUuid: unknown }>;
  heartbeats(): number;
}

function harness(): Harness {
  const timer = new FakeTimer();
  let releasedAs: string | undefined;
  let reachable = true;
  let heartbeats = 0;
  const forwarded: Array<{ toolName: string; sessionUuid: unknown }> = [];
  const newClient = (): FakeDaemonClient =>
    new FakeDaemonClient({
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
      onCallDaemonMethod: (method, params) => {
        if (method !== "daemon/heartbeat" || params.sessionId !== SESSION) {
          return;
        }
        heartbeats += 1;
        if (releasedAs !== undefined) {
          throw Object.assign(new Error(`Session not found: ${SESSION}`), {
            code: DAEMON_SESSION_NOT_FOUND_CODE,
            releaseReason: releasedAs,
          });
        }
      },
    });
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
      // Nothing listens for longer than one heartbeat request, which starts liveness recovery.
      reachable = false;
      previous.emitConnectionClosed();
      await timer.advanceTimeAsync(LEASE_MS);
      reachable = true;
      await timer.advanceTimeAsync(2 * INTERVAL_MS);
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
    return `${outcome}, ${named ? "forwarded under the released session" : "never forwarded under it"}`;
  } finally {
    await world.proxy.close();
  }
}

describe("release reasons are classified alike on every path", () => {
  test.each(EVERY_REASON)(
    "%s: a not-found heartbeat fences exactly when the notification does",
    async (reason) => {
      const expected = isRecoverableDaemonReleaseReason(reason)
        ? "answered, forwarded under the released session"
        : "refused, never forwarded under it";
      const byPath: Record<string, string> = {};
      for (const path of ["notification", ...HEARTBEAT_PATHS] as const) {
        byPath[path] = await sessionlessCallAfter(path, reason);
      }
      expect(byPath).toEqual({
        notification: expected,
        "keeper tick": expected,
        "first heartbeat": expected,
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
      await world.proxy.close();
    }
  });
});
