import { drainUntil } from "../../helpers/fakeTimerStepping";
import { afterEach, expect, test } from "bun:test";
import {
  VisionosRunnerLifecycle,
  requireVisionosRunner,
} from "../../../src/features/visionos/VisionosRunnerLifecycle";
import { visionosRunners } from "../../../src/features/visionos/VisionosRunnerRegistry";
import type {
  SessionReleaseCallback,
  SessionDeviceUnboundCallback,
} from "../../../src/daemon/sessionManager";
import { FakeVisionosRunnerLauncher } from "../../fakes/FakeVisionosRunnerLauncher";
import { FakeVisionosRunnerClient } from "../../fakes/FakeVisionosRunnerClient";

class FakeSessions {
  readonly releases: ((sessionId: string) => void)[] = [];
  readonly unbindings: SessionDeviceUnboundCallback[] = [];
  available = true;
  hasSession() {
    return this.available;
  }
  onSessionRelease(callback: SessionReleaseCallback) {
    this.releases.push((sessionId) => {
      const deviceId = "owned-visionos";
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

const owners: VisionosRunnerLifecycle[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.stopAll();
  }
});

function fixture() {
  const client = new FakeVisionosRunnerClient();
  const launcher = new FakeVisionosRunnerLauncher(client);
  const released: string[] = [];
  const allocated: string[] = [];
  const artifacts = {
    resolve: async () => "/products/AutoMobileVisionTest_xrsimulator.xctestrun",
  };
  const owner = new VisionosRunnerLifecycle({
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
  const request = { deviceId: "owned-visionos", ownerSession: "visionos-session", sessions };
  return { owner, launcher, client, artifacts, allocated, released, sessions, request };
}

test("owns one launch and port per visionos and reuses a registered runner", async () => {
  const f = fixture();
  expect(await f.owner.ensure(f.request)).toBeUndefined();
  expect(await f.owner.ensure(f.request)).toBeUndefined();
  expect(f.launcher.launches).toEqual([
    {
      deviceId: "owned-visionos",
      port: 9010,
      xctestrun: "/products/AutoMobileVisionTest_xrsimulator.xctestrun",
      signal: expect.any(AbortSignal),
    },
  ]);
  expect(visionosRunners.get("owned-visionos")).toBe(f.launcher.client);
  expect(f.allocated).toEqual(["owned-visionos"]);
  f.owner.stop("owned-visionos");
  f.owner.stop("owned-visionos");
  expect(f.released).toEqual(["owned-visionos"]);
  expect(visionosRunners.get("owned-visionos")).toBeUndefined();
});

test("a pre-registered runner is kept without allocation or launch", async () => {
  const f = fixture();
  const unregister = visionosRunners.register("owned-visionos", new FakeVisionosRunnerClient());
  try {
    expect(await f.owner.ensure(f.request)).toBeUndefined();
    expect(f.launcher.launches).toEqual([]);
    expect(f.allocated).toEqual([]);
    f.sessions.releases[0]!("visionos-session");
    f.sessions.unbindings[0]!("visionos-session", "owned-visionos");
    f.owner.stopAll();
    expect(visionosRunners.get("owned-visionos")).toBeDefined();
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
    f.sessions.releases[0]!("visionos-session");
    f.sessions.unbindings[0]!("visionos-session", "owned-visionos");
    expect(f.launcher.stops).toBe(0);
    if (reason === "release") {
      f.sessions.releases[0]!("new-session");
    } else {
      f.sessions.unbindings[0]!("new-session", "owned-visionos");
    }
    expect(f.launcher.stops).toBe(1);
    expect(visionosRunners.get("owned-visionos")).toBeUndefined();
  },
);

test("missing artifacts and launch failures return an explanation and release their port", async () => {
  const f = fixture();
  f.artifacts.resolve = async () => {
    throw new Error("No xrsimulator xctestrun after build");
  };
  expect(await f.owner.ensure(f.request)).toContain("No xrsimulator xctestrun");
  expect(f.launcher.launches).toEqual([]);
  expect(f.allocated).toEqual([]);
  f.artifacts.resolve = async () => "/products/Visionos.xctestrun";
  f.launcher.launch = async () => {
    throw new Error("runner process exited");
  };
  expect(await f.owner.ensure(f.request)).toContain("runner process exited");
  expect(f.released).toEqual(["owned-visionos"]);
});

test.each(["release", "unbind", "daemon"])("%s cleanup stops exactly once", async (reason) => {
  const f = fixture();
  await f.owner.ensure(f.request);
  if (reason === "release") {
    // The owner callback only consumes the session id; unrelated releases cannot stop it.
    f.owner.stopSession("other-session");
    expect(visionosRunners.get("owned-visionos")).toBeDefined();
    f.owner.stopSession("visionos-session");
  } else if (reason === "unbind") {
    f.sessions.unbindings[0]!("visionos-session", "owned-visionos");
  } else {
    f.owner.stopAll();
  }
  f.owner.stopAll();
  expect(f.released).toEqual(["owned-visionos"]);
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
  f.sessions.releases[0]!("visionos-session");
  f.sessions.unbindings[0]!("visionos-session", "owned-visionos");
  expect(signal?.aborted).toBe(false);
  f.owner.stop("owned-visionos");
  expect(signal?.aborted).toBe(true);
  gate.resolve({
    stop: () => {
      stopped++;
    },
  });
  await pending;
  expect(stopped).toBe(1);
  expect(f.released).toEqual(["owned-visionos"]);
});

test("an unowned runner ignores session events until attachment", async () => {
  const f = fixture();
  const started = await f.owner.start(f.request);
  expect(started.stop).toBeDefined();
  f.sessions.releases[0]!("visionos-session");
  f.sessions.unbindings[0]!("visionos-session", "owned-visionos");
  expect(f.launcher.stops).toBe(0);
  f.owner.attach(f.request);
  f.sessions.releases[0]!("visionos-session");
  expect(f.launcher.stops).toBe(1);
});

test("attachment registers observers when startup had no sessions", async () => {
  const f = fixture();
  await f.owner.start({ deviceId: "owned-visionos" });
  expect(f.sessions.releases).toEqual([]);
  f.owner.attach(f.request);
  f.sessions.unbindings[0]!("visionos-session", "owned-visionos");
  expect(f.launcher.stops).toBe(1);
});

test("a session ending between bind and attach stops the launched runner with an explanation", async () => {
  const f = fixture();
  await f.owner.start(f.request);
  f.sessions.available = false;
  expect(f.owner.attach(f.request)).toBe("the visionos session ended before runner startup");
  expect(f.launcher.stops).toBe(1);
  expect(f.released).toEqual(["owned-visionos"]);
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
  await expect(f.owner.start({ ...f.request, signal: controller.signal })).rejects.toThrow();
  await drainUntil(() => f.launcher.stops === 1, { description: "aborted launch cleanup" });
  expect(f.launcher.stops).toBe(1);
  expect(f.released).toEqual(["owned-visionos"]);
});

test("failure cleanup from an old launch cannot stop a replacement runner", async () => {
  const f = fixture();
  const first = await f.owner.start(f.request);
  f.owner.stop("owned-visionos");
  await f.owner.start(f.request);
  first.stop?.();
  expect(f.launcher.stops).toBe(1);
  expect(visionosRunners.get("owned-visionos")).toBeDefined();
});

test("concurrent first commands share one artifact build, launch and port", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<string>();
  let builds = 0;
  f.artifacts.resolve = async () => {
    builds++;
    return gate.promise;
  };
  const first = f.owner.start(f.request);
  const second = f.owner.start(f.request);
  await drainUntil(() => builds === 1, { description: "artifact resolution" });
  gate.resolve("/products/Vision.xctestrun");
  await Promise.all([first, second]);
  expect(builds).toBe(1);
  expect(f.launcher.launches).toHaveLength(1);
  expect(f.allocated).toEqual(["owned-visionos"]);
});

test("the first window command prepares a runner and subsequent commands reuse it", async () => {
  const f = fixture();
  expect(await requireVisionosRunner("owned-visionos", undefined, f.owner)).toBe(f.client);
  expect(await requireVisionosRunner("owned-visionos", undefined, f.owner)).toBe(f.client);
  expect(f.launcher.launches).toHaveLength(1);
});

test("a first command reports artifact failure without launching or allocating a port", async () => {
  const f = fixture();
  f.artifacts.resolve = async () => {
    throw new Error("missing visionOS runner");
  };
  await expect(requireVisionosRunner("owned-visionos", undefined, f.owner)).rejects.toThrow(
    "missing visionOS runner",
  );
  expect(f.launcher.launches).toEqual([]);
  expect(f.allocated).toEqual([]);
});
