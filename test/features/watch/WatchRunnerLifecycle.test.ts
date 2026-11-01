import { afterEach, expect, test } from "bun:test";
import { WatchRunnerLifecycle } from "../../../src/features/watch/WatchRunnerLifecycle";
import { watchRunners } from "../../../src/features/watch/WatchRunnerRegistry";
import type {
  SessionReleaseCallback,
  SessionDeviceUnboundCallback,
} from "../../../src/daemon/sessionManager";
import { FakeWatchRunnerLauncher } from "../../fakes/FakeWatchRunnerLauncher";
import { FakeWatchRunnerClient } from "../../fakes/FakeWatchRunnerClient";

class FakeSessions {
  readonly releases: ((sessionId: string) => void)[] = [];
  readonly unbindings: SessionDeviceUnboundCallback[] = [];
  available = true;
  hasSession() {
    return this.available;
  }
  onSessionRelease(callback: SessionReleaseCallback) {
    this.releases.push((sessionId) => {
      const deviceId = "owned-watch";
      const releaseReason = "explicit-release";
      callback(sessionId, deviceId, releaseReason, {
        snapshot: {
          sessionId,
          deviceId,
          releaseReason,
          releasedAtMs: 1,
          terminal: true,
          heartbeat: {
            lastHeartbeatMs: 0,
            hasReceivedHeartbeat: true,
            timeoutMs: 20_000,
            ageMs: 1,
          },
        },
      });
    });
  }
  onSessionDeviceUnbound(callback: SessionDeviceUnboundCallback) {
    this.unbindings.push(callback);
  }
}

const owners: WatchRunnerLifecycle[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.stopAll();
  }
});

function fixture() {
  const client = new FakeWatchRunnerClient();
  const launcher = new FakeWatchRunnerLauncher(client);
  const released: string[] = [];
  const allocated: string[] = [];
  const artifacts = { resolve: async () => "/products/CtrlProxyWatch_watchsimulator.xctestrun" };
  const owner = new WatchRunnerLifecycle({
    launcher,
    artifacts,
    ports: {
      allocate: (id) => {
        allocated.push(id);
        return 9010;
      },
      release: (id) => {
        released.push(id);
      },
    },
  });
  owners.push(owner);
  const sessions = new FakeSessions();
  const request = { deviceId: "owned-watch", ownerSession: "watch-session", sessions };
  return { owner, launcher, client, artifacts, allocated, released, sessions, request };
}

test("owns one launch and port per watch and reuses a registered runner", async () => {
  const f = fixture();
  expect(await f.owner.ensure(f.request)).toBeUndefined();
  expect(await f.owner.ensure(f.request)).toBeUndefined();
  expect(f.launcher.launches).toEqual([
    {
      deviceId: "owned-watch",
      port: 9010,
      xctestrun: "/products/CtrlProxyWatch_watchsimulator.xctestrun",
      signal: expect.any(AbortSignal),
    },
  ]);
  expect(watchRunners.get("owned-watch")).toBe(f.launcher.client);
  expect(f.allocated).toEqual(["owned-watch"]);
  f.owner.stop("owned-watch");
  f.owner.stop("owned-watch");
  expect(f.released).toEqual(["owned-watch"]);
  expect(watchRunners.get("owned-watch")).toBeUndefined();
});

test("a pre-registered runner is kept without allocation or launch", async () => {
  const f = fixture();
  const unregister = watchRunners.register("owned-watch", new FakeWatchRunnerClient());
  try {
    expect(await f.owner.ensure(f.request)).toBeUndefined();
    expect(f.launcher.launches).toEqual([]);
    expect(f.allocated).toEqual([]);
    f.sessions.releases[0]!("watch-session");
    f.sessions.unbindings[0]!("watch-session", "owned-watch");
    f.owner.stopAll();
    expect(watchRunners.get("owned-watch")).toBeDefined();
  } finally {
    unregister();
  }
});

test.each(["release", "unbind"])(
  "reuse transfers ownership to the new session on %s",
  async (reason) => {
    const f = fixture();
    await f.owner.start(f.request);
    f.owner.attach(f.request);
    expect(await f.owner.start(f.request)).toEqual({});
    f.owner.attach({ ...f.request, ownerSession: "new-session" });
    expect(f.launcher.launches).toHaveLength(1);
    expect(f.sessions.releases).toHaveLength(1);
    expect(f.sessions.unbindings).toHaveLength(1);
    f.sessions.releases[0]!("watch-session");
    f.sessions.unbindings[0]!("watch-session", "owned-watch");
    expect(f.launcher.stops).toBe(0);
    if (reason === "release") {
      f.sessions.releases[0]!("new-session");
    } else {
      f.sessions.unbindings[0]!("new-session", "owned-watch");
    }
    expect(f.launcher.stops).toBe(1);
    expect(watchRunners.get("owned-watch")).toBeUndefined();
  },
);

test("missing artifacts and launch failures return an explanation and release their port", async () => {
  const f = fixture();
  f.artifacts.resolve = async () => {
    throw new Error("No watchsimulator xctestrun after build");
  };
  expect(await f.owner.ensure(f.request)).toContain("No watchsimulator xctestrun");
  expect(f.launcher.launches).toEqual([]);
  expect(f.allocated).toEqual([]);
  f.artifacts.resolve = async () => "/products/Watch.xctestrun";
  f.launcher.launch = async () => {
    throw new Error("runner process exited");
  };
  expect(await f.owner.ensure(f.request)).toContain("runner process exited");
  expect(f.released).toEqual(["owned-watch"]);
});

test.each(["release", "unbind", "daemon"])("%s cleanup stops exactly once", async (reason) => {
  const f = fixture();
  await f.owner.ensure(f.request);
  if (reason === "release") {
    // The owner callback only consumes the session id; unrelated releases cannot stop it.
    f.owner.stopSession("other-session");
    expect(watchRunners.get("owned-watch")).toBeDefined();
    f.owner.stopSession("watch-session");
  } else if (reason === "unbind") {
    f.sessions.unbindings[0]!("watch-session", "owned-watch");
  } else {
    f.owner.stopAll();
  }
  f.owner.stopAll();
  expect(f.released).toEqual(["owned-watch"]);
  expect(f.client.closed).toBe(true);
});

test("an explicit stop during unowned launch aborts startup and retires a late handle", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<{ stop(): void }>();
  let signal: AbortSignal | undefined;
  let stopped = 0;
  f.launcher.launch = async (options) => {
    signal = options.signal;
    return await gate.promise;
  };
  const pending = f.owner.start(f.request);
  for (let turn = 0; turn < 30 && !signal; turn++) {
    await Promise.resolve();
  }
  expect(signal).toBeDefined();
  f.sessions.releases[0]!("watch-session");
  f.sessions.unbindings[0]!("watch-session", "owned-watch");
  expect(signal?.aborted).toBe(false);
  f.owner.stop("owned-watch");
  expect(signal?.aborted).toBe(true);
  gate.resolve({
    stop: () => {
      stopped++;
    },
  });
  await pending;
  expect(stopped).toBe(1);
  expect(f.released).toEqual(["owned-watch"]);
});

test("an unowned runner ignores session events until attachment", async () => {
  const f = fixture();
  const started = await f.owner.start(f.request);
  expect(started.stop).toBeDefined();
  f.sessions.releases[0]!("watch-session");
  f.sessions.unbindings[0]!("watch-session", "owned-watch");
  expect(f.launcher.stops).toBe(0);
  f.owner.attach(f.request);
  f.sessions.releases[0]!("watch-session");
  expect(f.launcher.stops).toBe(1);
});

test("attachment registers observers when startup had no sessions", async () => {
  const f = fixture();
  await f.owner.start({ deviceId: "owned-watch" });
  expect(f.sessions.releases).toEqual([]);
  f.owner.attach(f.request);
  f.sessions.unbindings[0]!("watch-session", "owned-watch");
  expect(f.launcher.stops).toBe(1);
});

test("a session ending between bind and attach stops the launched runner with an explanation", async () => {
  const f = fixture();
  await f.owner.start(f.request);
  f.sessions.available = false;
  expect(f.owner.attach(f.request)).toBe("the watch session ended before runner startup");
  expect(f.launcher.stops).toBe(1);
  expect(f.released).toEqual(["owned-watch"]);
});

test("abort during launch stops a late handle and frees its port", async () => {
  const f = fixture();
  const controller = new AbortController();
  const launch = f.launcher.launch.bind(f.launcher);
  f.launcher.launch = async (options) => {
    const handle = await launch(options);
    controller.abort();
    expect(options.signal?.aborted).toBe(true);
    return handle;
  };
  expect(await f.owner.start({ ...f.request, signal: controller.signal })).toMatchObject({
    runnerUnavailable: expect.any(String),
  });
  expect(f.launcher.stops).toBe(1);
  expect(f.released).toEqual(["owned-watch"]);
});

test("failure cleanup from an old launch cannot stop a replacement runner", async () => {
  const f = fixture();
  const first = await f.owner.start(f.request);
  f.owner.stop("owned-watch");
  await f.owner.start(f.request);
  first.stop?.();
  expect(f.launcher.stops).toBe(1);
  expect(watchRunners.get("owned-watch")).toBeDefined();
});
