import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import { requireTvosRunner } from "../../../src/features/tvos/TvosRunnerRecovery";
import { ActionableError } from "../../../src/models/ActionableError";
import { afterEach, expect, test } from "bun:test";
import { TvosRunnerLifecycle } from "../../../src/features/tvos/TvosRunnerLifecycle";
import {
  TargetAppForegroundRestore,
  type TvosForegroundRestore,
} from "../../../src/features/tvos/TvosForegroundRestore";
import { InMemoryVisionosTargetApps } from "../../../src/features/visionos/VisionosTargetApps";
import { tvosRunners } from "../../../src/features/tvos/TvosRunnerRegistry";
import type {
  SessionReleaseCallback,
  SessionDeviceUnboundCallback,
} from "../../../src/daemon/sessionManager";
import { FakeTvosRunnerLauncher } from "../../fakes/FakeTvosRunnerLauncher";
import { FakeTvosRunnerClient } from "../../fakes/FakeTvosRunnerClient";

class FakeSessions {
  readonly releases: ((sessionId: string) => void)[] = [];
  readonly unbindings: SessionDeviceUnboundCallback[] = [];
  available = true;
  hasSession() {
    return this.available;
  }
  onSessionRelease(callback: SessionReleaseCallback) {
    this.releases.push((sessionId) => {
      const deviceId = "owned-tvos";
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

const owners: TvosRunnerLifecycle[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) {
    owner.stopAll();
  }
});

function fixture(foreground?: TvosForegroundRestore) {
  const client = new FakeTvosRunnerClient();
  const launcher = new FakeTvosRunnerLauncher(client);
  const released: string[] = [];
  const allocated: string[] = [];
  const artifacts = {
    resolve: async () => "/products/AutoMobileTVTest_appletvsimulator.xctestrun",
  };
  const timer = new FakeTimer();
  const owner = new TvosRunnerLifecycle({
    timer,
    foreground,
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
  const request = { deviceId: "owned-tvos", ownerSession: "tvos-session", sessions };
  return { owner, launcher, client, artifacts, allocated, released, sessions, request, timer };
}

test("owns one launch and port per tvos and reuses a registered runner", async () => {
  const f = fixture();
  expect(await f.owner.ensure(f.request)).toBeUndefined();
  expect(await f.owner.ensure(f.request)).toBeUndefined();
  expect(f.launcher.launches).toEqual([
    {
      deviceId: "owned-tvos",
      port: 9010,
      xctestrun: "/products/AutoMobileTVTest_appletvsimulator.xctestrun",
      signal: expect.any(AbortSignal),
    },
  ]);
  expect(tvosRunners.get("owned-tvos")).toBe(f.launcher.client);
  expect(f.allocated).toEqual(["owned-tvos"]);
  f.owner.stop("owned-tvos");
  f.owner.stop("owned-tvos");
  expect(f.released).toEqual(["owned-tvos"]);
  expect(tvosRunners.get("owned-tvos")).toBeUndefined();
});

test("a pre-registered runner is kept without allocation or launch", async () => {
  const f = fixture();
  const unregister = tvosRunners.register("owned-tvos", new FakeTvosRunnerClient());
  try {
    expect(await f.owner.ensure(f.request)).toBeUndefined();
    expect(f.launcher.launches).toEqual([]);
    expect(f.allocated).toEqual([]);
    f.sessions.releases[0]!("tvos-session");
    f.sessions.unbindings[0]!("tvos-session", "owned-tvos");
    f.owner.stopAll();
    expect(tvosRunners.get("owned-tvos")).toBeDefined();
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
    f.sessions.releases[0]!("tvos-session");
    f.sessions.unbindings[0]!("tvos-session", "owned-tvos");
    expect(f.launcher.stops).toBe(0);
    if (reason === "release") {
      f.sessions.releases[0]!("new-session");
    } else {
      f.sessions.unbindings[0]!("new-session", "owned-tvos");
    }
    expect(f.launcher.stops).toBe(1);
    expect(tvosRunners.get("owned-tvos")).toBeUndefined();
  },
);

test("missing artifacts and launch failures return an explanation and release their port", async () => {
  const f = fixture();
  f.artifacts.resolve = async () => {
    throw new Error("No appletvsimulator xctestrun after build");
  };
  expect(await f.owner.ensure(f.request)).toContain("No appletvsimulator xctestrun");
  expect(f.launcher.launches).toEqual([]);
  expect(f.allocated).toEqual([]);
  f.artifacts.resolve = async () => "/products/Tvos.xctestrun";
  f.launcher.launch = async () => {
    throw new Error("runner process exited");
  };
  expect(await f.owner.ensure(f.request)).toContain("runner process exited");
  expect(f.released).toEqual(["owned-tvos"]);
});

test.each(["release", "unbind", "daemon"])("%s cleanup stops exactly once", async (reason) => {
  const f = fixture();
  await f.owner.ensure(f.request);
  if (reason === "release") {
    // The owner callback only consumes the session id; unrelated releases cannot stop it.
    f.owner.stopSession("other-session");
    expect(tvosRunners.get("owned-tvos")).toBeDefined();
    f.owner.stopSession("tvos-session");
  } else if (reason === "unbind") {
    f.sessions.unbindings[0]!("tvos-session", "owned-tvos");
  } else {
    f.owner.stopAll();
  }
  f.owner.stopAll();
  expect(f.released).toEqual(["owned-tvos"]);
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
  f.sessions.releases[0]!("tvos-session");
  f.sessions.unbindings[0]!("tvos-session", "owned-tvos");
  expect(signal?.aborted).toBe(false);
  f.owner.stop("owned-tvos");
  expect(signal?.aborted).toBe(true);
  gate.resolve({
    stop: () => {
      stopped++;
    },
  });
  await pending;
  expect(stopped).toBe(1);
  expect(f.released).toEqual(["owned-tvos"]);
});

test("an unowned runner ignores session events until attachment", async () => {
  const f = fixture();
  const started = await f.owner.start(f.request);
  expect(started.stop).toBeDefined();
  f.sessions.releases[0]!("tvos-session");
  f.sessions.unbindings[0]!("tvos-session", "owned-tvos");
  expect(f.launcher.stops).toBe(0);
  f.owner.attach(f.request);
  f.sessions.releases[0]!("tvos-session");
  expect(f.launcher.stops).toBe(1);
});

test("attachment registers observers when startup had no sessions", async () => {
  const f = fixture();
  await f.owner.start({ deviceId: "owned-tvos" });
  expect(f.sessions.releases).toEqual([]);
  f.owner.attach(f.request);
  f.sessions.unbindings[0]!("tvos-session", "owned-tvos");
  expect(f.launcher.stops).toBe(1);
});

test("a session ending between bind and attach stops the launched runner with an explanation", async () => {
  const f = fixture();
  await f.owner.start(f.request);
  f.sessions.available = false;
  expect(f.owner.attach(f.request)).toBe("the tvos session ended before runner startup");
  expect(f.launcher.stops).toBe(1);
  expect(f.released).toEqual(["owned-tvos"]);
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
  expect(f.released).toEqual(["owned-tvos"]);
});

test("abort during successful foreground activation returns no stop handle", async () => {
  const controller = new AbortController();
  const targetApps = new InMemoryVisionosTargetApps();
  targetApps.launched("owned-tvos", "dev.example.tvapp");
  const activations: string[] = [];
  const f = fixture(
    new TargetAppForegroundRestore({
      targetApps,
      activate: async (deviceId, bundleId) => {
        activations.push(`${deviceId} ${bundleId}`);
        controller.abort();
        return { success: true };
      },
    }),
  );
  const started = await f.owner.start({ ...f.request, signal: controller.signal });
  expect(activations).toEqual(["owned-tvos dev.example.tvapp"]);
  expect(started.runnerUnavailable).toBe("the tvos session ended during runner startup");
  expect(started.stop).toBeUndefined();
  expect(f.launcher.stops).toBe(1);
  expect(f.released).toEqual(["owned-tvos"]);
  expect(f.owner.ownsRunner("owned-tvos")).toBe(false);
  expect(tvosRunners.get("owned-tvos")).toBeUndefined();
});

test("failure cleanup from an old launch cannot stop a replacement runner", async () => {
  const f = fixture();
  const first = await f.owner.start(f.request);
  f.owner.stop("owned-tvos");
  await f.owner.start(f.request);
  first.stop?.();
  expect(f.launcher.stops).toBe(1);
  expect(tvosRunners.get("owned-tvos")).toBeDefined();
});

// Recovery keeps the lifecycle owner while replacing the unusable transport.
test("concurrent require calls restart once, proceed, and preserve the previous owner", async () => {
  const f = fixture();
  await f.owner.ensure(f.request);
  f.client.close();
  const replacement = new FakeTvosRunnerClient();
  const launcher = new FakeTvosRunnerLauncher(replacement);
  const gate = Promise.withResolvers<void>();
  f.launcher.launch = async (options) => {
    await gate.promise;
    return launcher.launch(options);
  };
  const first = requireTvosRunner("owned-tvos", undefined, f.owner);
  const second = requireTvosRunner("owned-tvos", undefined, f.owner);
  gate.resolve();
  const clients = await Promise.all([first, second]);
  expect(clients).toEqual([replacement, replacement]);
  expect(launcher.launches).toHaveLength(1);
  await clients[0]!.request({ type: "request_press_button", action: "select" });
  expect(replacement.commands).toHaveLength(1);
  f.owner.stopSession("other-session");
  expect(replacement.closed).toBe(false);
  f.sessions.releases[0]!("tvos-session");
  expect(replacement.closed).toBe(true);
});

test("restart failure is actionable and names startDevice", async () => {
  const f = fixture();
  await f.owner.ensure(f.request);
  f.client.close();
  f.artifacts.resolve = async () => {
    throw new Error("missing tvOS artifacts");
  };
  const error = await requireTvosRunner("owned-tvos", undefined, f.owner).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ActionableError);
  expect(String(error)).toContain("startDevice");
  expect(String(error)).toContain("missing tvOS artifacts");
});

test.each(["disconnected", "failed"])(
  "an externally registered %s runner passes through require without recovery",
  async (state) => {
    const f = fixture();
    const failure = new Error("runner gone");
    f.client.failure = failure;
    if (state === "disconnected") {
      f.client.close();
    }
    const unregister = tvosRunners.register("owned-tvos", f.client);
    try {
      expect(f.client.isUsable()).toBe(false);
      const client = await requireTvosRunner("owned-tvos", undefined, f.owner);
      expect(client).toBe(f.client);
      await expect(client.request({ type: "request_press_button", action: "home" })).rejects.toBe(
        failure,
      );
      expect(f.launcher.launches).toHaveLength(0);
      expect(f.allocated).toEqual([]);
      expect(f.released).toEqual([]);
      expect(f.launcher.stops).toBe(0);
      expect(tvosRunners.get("owned-tvos")).toBe(f.client);
    } finally {
      unregister();
    }
  },
);

test.each(["timeout", "abort", "release", "unbind"])(
  "%s bounds recovery and retires a late startup handle",
  async (mode) => {
    const f = fixture();
    await f.owner.ensure(f.request);
    f.client.close();
    const gate = Promise.withResolvers<{ stop(): void }>();
    let launchSignal: AbortSignal | undefined;
    let lateStops = 0;
    f.launcher.launch = async (options) => {
      launchSignal = options.signal;
      return gate.promise;
    };
    const controller = new AbortController();
    const pending = requireTvosRunner("owned-tvos", controller.signal, f.owner).catch(
      (error: unknown) => error,
    );
    await drainMicrotasks(20);
    expect(launchSignal).toBeDefined();
    if (mode === "timeout") {
      f.timer.advanceTime(65_000);
    } else if (mode === "abort") {
      controller.abort();
    } else if (mode === "release") {
      f.sessions.releases[0]!("tvos-session");
    } else {
      f.sessions.unbindings[0]!("tvos-session", "owned-tvos");
    }
    const error = await pending;
    if (mode === "abort") {
      expect(error).toBe(controller.signal.reason);
    } else {
      expect(error).toBeInstanceOf(ActionableError);
      expect(String(error)).toContain("startDevice");
    }
    expect(launchSignal?.aborted).toBe(true);
    expect(tvosRunners.get("owned-tvos")).toBeUndefined();
    gate.resolve({
      stop: () => {
        lateStops++;
      },
    });
    await drainMicrotasks(20);
    expect(lateStops).toBe(1);
    expect(f.released).toEqual(["owned-tvos", "owned-tvos"]);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
  },
);

test("one aborted recovery waiter does not cancel another", async () => {
  const f = fixture();
  await f.owner.ensure(f.request);
  f.client.close();
  const replacement = new FakeTvosRunnerClient();
  const launcher = new FakeTvosRunnerLauncher(replacement);
  const gate = Promise.withResolvers<void>();
  let launchSignal: AbortSignal | undefined;
  f.launcher.launch = async (options) => {
    launchSignal = options.signal;
    await gate.promise;
    return launcher.launch(options);
  };
  const controller = new AbortController();
  const first = requireTvosRunner("owned-tvos", controller.signal, f.owner).catch(
    (error: unknown) => error,
  );
  const second = requireTvosRunner("owned-tvos", undefined, f.owner);
  await drainMicrotasks(20);
  controller.abort();
  expect(await first).toBe(controller.signal.reason);
  expect(launchSignal?.aborted).toBe(false);
  gate.resolve();
  expect(await second).toBe(replacement);
  expect(launcher.launches).toHaveLength(1);
});
