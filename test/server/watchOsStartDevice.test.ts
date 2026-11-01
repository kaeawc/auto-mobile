import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { toolJson } from "../helpers/toolResponse";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { startWatchDevice } from "../../src/server/deviceToolsWatchOs";
import { bindBootedDeviceSession } from "../../src/server/deviceToolsStartDevice";
import { startDeviceOutputSchema } from "../../src/server/toolOutputSchemas";
import { clearDirectSessionDevices } from "../../src/utils/directSessionDeviceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError, type BootedDevice } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { WatchSimulatorInventory } from "../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import {
  WatchSimulatorLifecycle,
  type WatchBootAdmission,
} from "../../src/utils/ios-cmdline-tools/WatchSimulatorLifecycle";
import type { AppleDevice } from "../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWatchLifecycleSimctl, IPHONE_UDID, watchDevice } from "../fakes/FakeWatchSimctl";
import { WatchRunnerLifecycle } from "../../src/features/watch/WatchRunnerLifecycle";
import { watchRunners } from "../../src/features/watch/WatchRunnerRegistry";
import { FakeWatchRunnerLauncher } from "../fakes/FakeWatchRunnerLauncher";

isolateToolRegistry();

// startDevice on an Apple Watch simulator boots (or adopts) it and binds a pooled session at
// readiness "booted", after best-effort preparing its watch automation runner.

/** This daemon's watch claim store, with every claim publish held until the test lets it land. */
class GatedWatchClaims implements ForeignDeviceOwnership {
  readonly held = new Set<string>();
  readonly pending: Array<() => void> = [];

  async refresh(): Promise<void> {}
  foreignOwnerPid(): number | undefined {
    return undefined;
  }
  async claim(deviceId: string): Promise<boolean> {
    await new Promise<void>((land) => this.pending.push(land));
    this.held.add(deviceId);
    return true;
  }
  release(deviceId: string): void {
    this.held.delete(deviceId);
  }
}

const WATCH_UDID = watchDevice().udid;
const WATCH_NAME = watchDevice().name;
const boundSessionSchema = z.object({
  runtime: z.object({ session: z.object({ sessionUuid: z.string() }) }),
});

describe("startDevice on an Apple Watch simulator", () => {
  const env: Record<string, string | undefined> = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
  let restoreEnv: (() => void) | undefined;
  let sessionManager: SessionManager | undefined;
  let watchRunner: WatchRunnerLifecycle | undefined;

  const cleanup = () => {
    watchRunner?.stopAll();
    env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "0";
    restoreEnv?.();
    restoreEnv = undefined;
    resetDeviceToolsDependencies();
    clearDirectSessionDevices();
    DaemonState.getInstance().reset();
    sessionManager?.stopCleanupTimer();
    sessionManager = undefined;
  };
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(cleanup);

  async function arrange(
    devices: AppleDevice[] = [watchDevice()],
    {
      listingFollowsBoot = true,
      ownership,
      admission,
    }: {
      listingFollowsBoot?: boolean;
      ownership?: ForeignDeviceOwnership;
      admission?: WatchBootAdmission;
    } = {},
  ) {
    restoreEnv = ToolRegistry.setPipelineOverridesForTesting({ env });
    const simctl = new FakeWatchLifecycleSimctl(devices);
    const inventory = new WatchSimulatorInventory(simctl, "arm64");
    const deviceUtils = new FakeDeviceUtils();
    const publishBootedWatches = () =>
      deviceUtils.setBootedDevices(
        "watchos",
        devices
          .filter((device) => device.state === "Booted")
          .map((device): BootedDevice => ({
            name: device.name,
            platform: "watchos",
            deviceId: device.udid,
          })),
      );
    publishBootedWatches();
    simctl.onStateChange = listingFollowsBoot ? publishBootedWatches : undefined;
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        env,
        timer,
        deviceManager: deviceUtils,
        ...(ownership ? { watchForeignDeviceOwnership: ownership } : {}),
      }),
    );
    // A watch booted before the call is already a pooled, idle row.
    await pool.initializeWithDevices(await deviceUtils.getBootedDevices("watchos"));
    DaemonState.getInstance().initialize(sessionManager, pool);
    const runnerCalls: string[] = [];
    const watchLauncher = new FakeWatchRunnerLauncher();
    const allocated: string[] = [];
    const artifacts = { resolve: async () => "/products/CtrlProxyWatch_watchsimulator.xctestrun" };
    watchRunner = new WatchRunnerLifecycle({
      artifacts,
      launcher: watchLauncher,
      ports: {
        allocate: (id) => {
          allocated.push(id);
          return 9011;
        },
        release: () => {},
      },
    });
    setDeviceToolsDependencies({
      env,
      timer,
      deviceManagerFactory: () => deviceUtils,
      idGenerator: new CountingIdGenerator("session"),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async (request) => {
        runnerCalls.push(request.device.deviceId);
        throw new Error("a watch start must never prepare an automation runner");
      },
      watchSimulatorLifecycleFactory: () =>
        new WatchSimulatorLifecycle(simctl, inventory, admission),
      watchRunnerLifecycleFactory: () => watchRunner!,
    });
    registerDeviceTools();
    return {
      simctl,
      pool,
      sessions: sessionManager,
      runnerCalls,
      deviceUtils,
      watchLauncher,
      artifacts,
      allocated,
    };
  }

  const start = (args: Record<string, unknown>) =>
    ToolRegistry.getTool("startDevice")!.handler({ __mcpSessionId: "client-a", ...args });

  test.each(["0", "1"])(
    "autolock %s: boots and launches its runner before binding the watch once",
    async (autolock) => {
      env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = autolock;
      const { simctl, pool, sessions, runnerCalls, watchLauncher, allocated } = await arrange();
      const launch = watchLauncher.launch.bind(watchLauncher);
      watchLauncher.launch = async (options) => {
        expect(
          Object.values(simctl.listing.devices)
            .flat()
            .find((device) => device.udid === WATCH_UDID)?.state,
        ).toBe("Booted");
        expect(pool.getDevice(WATCH_UDID)?.sessionId ?? null).toBeNull();
        expect(sessions.getAllSessions()).toEqual([]);
        return await launch(options);
      };

      const result = toolJson(await start({ platform: "watchos", deviceId: WATCH_UDID }));

      expect(simctl.commands).toEqual([`boot ${WATCH_UDID} 360000`]);
      expect(runnerCalls).toEqual([]);
      expect(watchLauncher.launches).toEqual([
        expect.objectContaining({
          deviceId: WATCH_UDID,
          port: 9011,
          xctestrun: "/products/CtrlProxyWatch_watchsimulator.xctestrun",
        }),
      ]);
      expect(allocated).toEqual([WATCH_UDID]);
      expect(watchRunners.get(WATCH_UDID)).toBe(watchLauncher.client);
      const sessionId = boundSessionSchema.parse(result).runtime.session.sessionUuid;
      expect(pool.getDevice(WATCH_UDID)).toMatchObject({ platform: "watchos", sessionId });
      expect(sessions.getSession(sessionId)).toMatchObject({
        platform: "watchos",
        assignedDevice: WATCH_UDID,
      });
      expect(sessions.getSession(sessionId)?.cacheData.deviceReadiness).toBe("booted");
      expect(result).toMatchObject({
        runtime: { lifecycle: { state: "booted" } },
        message: `watchos '${WATCH_NAME}' is booted (started by this call)`,
        platform: "watchos",
        acquisition: "cold-boot",
        readiness: { level: "booted", checks: ["bootCompleted", "sessionBound"] },
      });
      expect(startDeviceOutputSchema.safeParse(result).success).toBe(true);
    },
  );

  test("launch happens before bind and release after attach stops the runner", async () => {
    const f = await arrange();
    const response = await startWatchDevice(
      { platform: "watchos", deviceId: WATCH_UDID, __mcpSessionId: "client-a" },
      async (...args) => {
        f.watchLauncher.calls.push("bind");
        return await bindBootedDeviceSession(...args);
      },
    );
    expect(f.watchLauncher.calls).toEqual(["launch", "bind"]);
    const sessionId = boundSessionSchema.parse(toolJson(response)).runtime.session.sessionUuid;
    await f.sessions.releaseSession(sessionId, "explicit-release");
    expect(f.watchLauncher.calls).toEqual(["launch", "bind", "stop"]);
  });

  test("a bind failure stops the runner launched by this call", async () => {
    const f = await arrange();
    await expect(
      startWatchDevice({ platform: "watchos", deviceId: WATCH_UDID }, async () => {
        f.watchLauncher.calls.push("bind");
        throw new ActionableError("bind refused");
      }),
    ).rejects.toThrow("bind refused");
    expect(f.watchLauncher.calls).toEqual(["launch", "bind", "stop"]);
    expect(watchRunners.get(WATCH_UDID)).toBeUndefined();
    expect(f.sessions.getAllSessions()).toEqual([]);
  });

  test("a failed bind preserves a runner reused from an earlier session", async () => {
    const f = await arrange();
    const first = toolJson(await start({ platform: "watchos", deviceId: WATCH_UDID }));
    await expect(
      startWatchDevice({ platform: "watchos", deviceId: WATCH_UDID }, async () => {
        throw new ActionableError("bind refused");
      }),
    ).rejects.toThrow("bind refused");
    expect(f.watchLauncher.launches).toHaveLength(1);
    expect(f.watchLauncher.stops).toBe(0);
    const sessionId = boundSessionSchema.parse(first).runtime.session.sessionUuid;
    await f.sessions.releaseSession(sessionId, "explicit-release");
    expect(f.watchLauncher.stops).toBe(1);
  });

  test("a repeat start attaches the reused runner to its new session", async () => {
    const f = await arrange();
    for (const sessionId of ["old-watch-session", "new-watch-session"]) {
      await startWatchDevice({ platform: "watchos", deviceId: WATCH_UDID }, async () => {
        await f.sessions.createSession(sessionId, WATCH_UDID, "watchos");
        return sessionId;
      });
    }
    expect(f.watchLauncher.launches).toHaveLength(1);
    await f.sessions.releaseSession("old-watch-session", "explicit-release");
    expect(f.watchLauncher.stops).toBe(0);
    await f.sessions.releaseSession("new-watch-session", "explicit-release");
    expect(f.watchLauncher.stops).toBe(1);
  });

  test("a session ending before attach returns booted readiness with an explanation", async () => {
    const f = await arrange();
    const result = toolJson(
      await startWatchDevice({ platform: "watchos", deviceId: WATCH_UDID }, async () => {
        await f.sessions.createSession("ended-session", WATCH_UDID, "watchos");
        await f.sessions.releaseSession("ended-session", "explicit-release");
        return "ended-session";
      }),
    );
    expect(result).toMatchObject({ isReady: true, readiness: { level: "booted" } });
    expect(result.message).toContain("the watch session ended before runner startup");
    expect(f.watchLauncher.stops).toBe(1);
  });

  test.each(["missing xctestrun", "launch failed"])(
    "%s still delivers a booted session and explains runner unavailability",
    async (reason) => {
      const f = await arrange();
      if (reason === "missing xctestrun") {
        f.artifacts.resolve = async () => {
          throw new Error(reason);
        };
      } else {
        f.watchLauncher.launch = async () => {
          throw new Error(reason);
        };
      }
      const result = toolJson(await start({ platform: "watchos", deviceId: WATCH_UDID }));
      expect(result).toMatchObject({ isReady: true, readiness: { level: "booted" } });
      expect(result.message).toContain(`watch runner unavailable: ${reason}`);
      expect(watchRunners.get(WATCH_UDID)).toBeUndefined();
    },
  );

  test("a second start keeps the runner and release of the bound session stops it exactly once", async () => {
    const f = await arrange();
    const result = toolJson(await start({ platform: "watchos", deviceId: WATCH_UDID }));
    await start({ platform: "watchos", deviceId: WATCH_UDID });
    expect(f.watchLauncher.launches).toHaveLength(1);
    const sessionId = boundSessionSchema.parse(result).runtime.session.sessionUuid;
    await f.sessions.releaseSession(sessionId, "explicit-release");
    expect(watchRunners.get(WATCH_UDID)).toBeUndefined();
    expect(f.watchLauncher.stops).toBe(1);
    watchRunner?.stopAll();
    expect(f.watchLauncher.stops).toBe(1);
  });

  test("cancellation during runner startup never binds a session", async () => {
    const f = await arrange();
    const request = new AbortController();
    f.watchLauncher.launch = async (options) => {
      expect(f.pool.getDevice(WATCH_UDID)?.sessionId ?? null).toBeNull();
      request.abort();
      options.signal?.throwIfAborted();
      throw new Error("cancelled startup must not continue");
    };
    const outcome = await ToolRegistry.getTool("startDevice")!
      .handler(
        { __mcpSessionId: "client-a", platform: "watchos", deviceId: WATCH_UDID },
        undefined,
        request.signal,
      )
      .then(
        () => "delivered",
        () => "refused",
      );
    expect(outcome).toBe("refused");
    expect(f.pool.getDevice(WATCH_UDID)?.sessionId ?? null).toBeNull();
    expect(f.sessions.getAllSessions()).toEqual([]);
    expect(watchRunners.get(WATCH_UDID)).toBeUndefined();
  });

  test("lease cancellation during startup stops the runner before binding", async () => {
    const f = await arrange();
    const lease = new AbortController();
    let released = 0;
    let binds = 0;
    setDeviceToolsDependencies({
      lifecycleCoordinator: {
        isReserved: () => false,
        reserve: async (identity) => ({
          identity,
          signal: lease.signal,
          bindCanonicalIdentity: async () => {},
          transitionToTeardown: () => {},
          release: () => {
            released++;
          },
        }),
      },
    });
    const launch = f.watchLauncher.launch.bind(f.watchLauncher);
    f.watchLauncher.launch = async (options) => {
      const handle = await launch(options);
      lease.abort();
      expect(options.signal?.aborted).toBe(true);
      return handle;
    };
    await expect(
      startWatchDevice({ platform: "watchos", deviceId: WATCH_UDID }, async () => {
        binds++;
        return "unexpected-session";
      }),
    ).rejects.toThrow();
    expect(binds).toBe(0);
    expect(f.watchLauncher.stops).toBe(1);
    expect(released).toBe(1);
    expect(watchRunners.get(WATCH_UDID)).toBeUndefined();
  });

  test("a direct start without daemon session ownership still delivers booted readiness", async () => {
    const f = await arrange();
    DaemonState.getInstance().reset();
    const result = toolJson(await start({ platform: "watchos", deviceId: WATCH_UDID }));
    expect(result).toMatchObject({ isReady: true, readiness: { level: "booted" } });
    expect(result.message).toContain("watch runner unavailable");
    expect(f.watchLauncher.launches).toEqual([]);
  });

  // A cancellation that lands after the bind minted the session, while it still publishes its
  // claim, must take the session back: the client never receives its UUID.
  test.each(["0", "1"])(
    "autolock %s: a start cancelled during its bind releases the watch session it minted",
    async (autolock) => {
      env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = autolock;
      const claims = new GatedWatchClaims();
      const { pool, sessions, watchLauncher } = await arrange([watchDevice()], {
        ownership: claims,
      });
      const request = new AbortController();

      const outcome = ToolRegistry.getTool("startDevice")!
        .handler(
          { __mcpSessionId: "client-a", platform: "watchos", deviceId: WATCH_UDID },
          undefined,
          request.signal,
        )
        .then(
          () => "delivered",
          () => "refused",
        );
      for (let turn = 0; turn < 5_000 && claims.pending.length === 0; turn++) {
        await Promise.resolve();
      }
      expect(claims.pending).toHaveLength(1);
      expect(sessions.getAllSessions()).toHaveLength(1);
      request.abort();
      claims.pending[0]!();

      expect(await outcome).toBe("refused");
      expect(pool.getDevice(WATCH_UDID)?.sessionId ?? null).toBeNull();
      expect(sessions.getAllSessions()).toEqual([]);
      expect(claims.held.size).toBe(0);
      expect(watchLauncher.stops).toBe(1);
      expect(watchRunners.get(WATCH_UDID)).toBeUndefined();
    },
  );

  // A start cancelled while its boot waits for simulator capacity must leave the admission queue
  // instead of holding its place and lease until a slot frees (#15882).
  test("a start cancelled while its boot waits for admission cancels the admission", async () => {
    const request = new AbortController();
    const seen: Array<boolean | undefined> = [];
    const { simctl } = await arrange([watchDevice()], {
      admission: {
        run: async (boot) => {
          seen.push(boot.signal?.aborted);
          request.abort();
          seen.push(boot.signal?.aborted);
          boot.signal?.throwIfAborted();
          throw new Error("admission must observe the cancelled request");
        },
      },
    });

    const outcome = await ToolRegistry.getTool("startDevice")!
      .handler(
        { __mcpSessionId: "client-a", platform: "watchos", deviceId: WATCH_UDID },
        undefined,
        request.signal,
      )
      .then(
        () => "delivered",
        () => "refused",
      );

    expect(outcome).toBe("refused");
    expect(seen).toEqual([false, true]);
    expect(simctl.commands).toEqual([]);
  });

  test("adopts an already-booted, pooled idle watch by exact name without booting it", async () => {
    const { simctl, pool } = await arrange([watchDevice({ state: "Booted" })]);
    expect(pool.getDevice(WATCH_UDID)).toMatchObject({ platform: "watchos", sessionId: null });

    const result = toolJson(await start({ device: { platform: "watchos", name: WATCH_NAME } }));

    expect(simctl.commands).toEqual([]);
    expect(result).toMatchObject({ acquisition: "already-booted", platform: "watchos" });
    expect(pool.getDevice(WATCH_UDID)?.sessionId).not.toBeNull();
  });

  test("refuses to bind a watch no fresh watchOS listing shows booted", async () => {
    const { simctl, pool } = await arrange([watchDevice()], { listingFollowsBoot: false });

    const error = await start({ platform: "watchos", deviceId: WATCH_UDID }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(simctl.commands).toEqual([`boot ${WATCH_UDID} 360000`]);
    expect(pool.getDevice(WATCH_UDID)).toBeNull();
  });

  test("refuses a pooled watch that the fresh watchOS listing no longer shows booted", async () => {
    const { simctl, pool, deviceUtils } = await arrange([watchDevice({ state: "Booted" })]);
    expect(pool.getDevice(WATCH_UDID)?.sessionId).toBeNull();
    deviceUtils.setBootedDevices("watchos", []);

    const error = await start({ platform: "watchos", deviceId: WATCH_UDID }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(simctl.commands).toEqual([]);
    expect(pool.getDevice(WATCH_UDID)?.sessionId ?? null).toBeNull();
  });

  test("refuses a pooled watch while the watchOS listing fails, instead of trusting the row", async () => {
    const { simctl, pool, deviceUtils } = await arrange([watchDevice({ state: "Booted" })]);
    deviceUtils.failedPlatforms.add("watchos");

    const error = await start({ platform: "watchos", deviceId: WATCH_UDID }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(simctl.commands).toEqual([]);
    expect(pool.getDevice(WATCH_UDID)?.sessionId ?? null).toBeNull();
  });

  test("refuses an iPhone UDID named as a watch before any simctl command", async () => {
    const { simctl, pool } = await arrange();

    const error = await start({ platform: "watchos", deviceId: IPHONE_UDID }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`No Apple Watch simulator matches UDID ${IPHONE_UDID}`);
    expect(simctl.commands).toEqual([]);
    expect(pool.getDevice(IPHONE_UDID)).toBeNull();
  });

  test.each([
    ["createIfMissing", { createIfMissing: true }],
    ["avdName", { avdName: "Pixel_8" }],
    ["runnerReadinessTimeoutMs", { runnerReadinessTimeoutMs: 60_000 }],
    ["formFactor", { formFactor: "watch" }],
  ])("refuses the Android/iOS-only option %s for a watch", async (key, option) => {
    const { simctl } = await arrange();

    const error = await start({ platform: "watchos", deviceId: WATCH_UDID, ...option }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`unsupported option(s): ${key}`);
    expect(simctl.commands).toEqual([]);
  });

  test("the registered schema admits a watch request and keeps refusing an unknown platform", () => {
    const schema = ToolRegistry.getTool("startDevice")?.schema;
    expect(schema?.safeParse({ platform: "watchos", deviceId: WATCH_UDID }).success).toBe(true);
    expect(schema?.safeParse({ platform: "visionos", deviceId: WATCH_UDID }).success).toBe(false);
  });
});
