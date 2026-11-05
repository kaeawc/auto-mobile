import { DeviceCriteriaMatcher } from "../../src/daemon/DeviceCriteriaMatcher";
import {
  runWithAcquisitionReceipt,
  type AcquisitionReceipt,
} from "../../src/daemon/acquisitionReceipt";
import { patchDeviceBinding } from "../helpers/patchDeviceBinding";
import { holderOf } from "../../src/daemon/deviceBinding";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { startDeviceOutputSchema } from "../../src/server/toolOutputSchemas";
import { provisionAppleVisionDevice } from "../../src/server/deviceToolsAppleVisionProvision";
import { bindBootedDeviceSession } from "../../src/server/deviceToolsStartDevice";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { toolJson } from "../helpers/toolResponse";
import { withWireConnection } from "../helpers/mcpConnection";
import type { ProgressCallback } from "../../src/server/toolRegistry";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import {
  provisionDeviceRegistrationSchema,
  provisionDeviceSchema,
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { provisionDeviceOutputSchema } from "../../src/features/deviceLifecycle/core/toolSchemas";
import { clearDirectSessionDevices } from "../../src/utils/directSessionDeviceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { isAnonymousAcquisitionSession, SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError, type BootedDevice } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { AppleVisionSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleVisionSimulatorInventory";
import {
  AppleVisionSimulatorBoot,
  type AppleVisionBootAdmission,
} from "../../src/utils/ios-cmdline-tools/AppleVisionSimulatorBoot";
import { AppleVisionSimulatorProvisioner } from "../../src/utils/ios-cmdline-tools/AppleVisionSimulatorProvisioner";
import {
  type VirtualDeviceLifecycleCoordinator,
  InMemoryVirtualDeviceLifecycleCoordinator,
} from "../../src/devices/virtualDeviceLifecycleCoordinator";
import type { AppleDevice } from "../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { DeviceOwnedByOtherDaemonError } from "../../src/models/deviceAcquisitionRefusals";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  FakeAppleVisionProvisionSimctl,
  VISION_DEVICE_TYPE,
  VISION_RUNTIME_ID,
  visionDevice,
} from "../fakes/FakeAppleVisionSimctl";

isolateToolRegistry();

// provisionDevice with platform "visionos" adopts or creates an exact Apple Vision Pro simulator and,
// with boot, binds a session at readiness "booted"; no automation runner runs.

const NAME = "AutoMobile Vision";
const SPEC = { deviceType: VISION_DEVICE_TYPE.identifier, runtime: VISION_RUNTIME_ID };
const headset = { platform: "visionos", name: NAME, spec: SPEC };
const sessionSchema = z.object({ sessionId: z.string() });

/** Another daemon's Vision claims: `claimed` decides, per read, which UDIDs it holds. */
class FakeVisionClaims implements ForeignDeviceOwnership {
  readonly reads: string[] = [];
  constructor(private readonly claimed: (udid: string) => boolean) {}
  async refresh(ids: readonly string[]): Promise<void> {
    this.reads.push(...ids);
  }
  foreignOwnerPid(udid: string): number | undefined {
    return this.claimed(udid) ? 4242 : undefined;
  }
  async claim(): Promise<boolean> {
    return true;
  }
  release(): void {}
}

describe("provisionDevice on an Apple Vision Pro simulator", () => {
  const env: Record<string, string | undefined> = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
  let restoreEnv: (() => void) | undefined;
  let sessionManager: SessionManager | undefined;

  const cleanup = () => {
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
    devices: AppleDevice[] = [],
    {
      autolock = "0",
      admission,
      ownership,
    }: {
      autolock?: "0" | "1";
      admission?: AppleVisionBootAdmission;
      ownership?: ForeignDeviceOwnership;
    } = {},
  ) {
    env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = autolock;
    restoreEnv = ToolRegistry.setPipelineOverridesForTesting({ env });
    const simctl = new FakeAppleVisionProvisionSimctl(devices);
    const inventory = new AppleVisionSimulatorInventory(simctl, "arm64");
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.listDeviceImages = () => inventory.listAppleVisionSimulators();
    const publishBootedAppleVisions = () =>
      deviceUtils.setBootedDevices(
        "visionos",
        Object.values(simctl.listing.devices)
          .flat()
          .filter((device) => device.state === "Booted" && device.name !== "iPhone 16")
          .map((device): BootedDevice => ({
            name: device.name,
            platform: "visionos",
            deviceId: device.udid,
          })),
      );
    publishBootedAppleVisions();
    simctl.onStateChange = publishBootedAppleVisions;
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        env,
        timer,
        deviceManager: deviceUtils,
        ...(ownership ? { visionForeignDeviceOwnership: ownership } : {}),
      }),
    );
    await pool.initializeWithDevices(await deviceUtils.getBootedDevices("visionos"));
    DaemonState.getInstance().initialize(sessionManager, pool);
    const runnerCalls: string[] = [];
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    setDeviceToolsDependencies({
      tvosRunnerLifecycleFactory: () => {
        throw new Error("visionOS must never use a tvOS runner");
      },
      watchRunnerLifecycleFactory: () => {
        throw new Error("visionOS must never use a watch runner");
      },
      lifecycleCoordinator,
      env,
      timer,
      deviceManagerFactory: () => deviceUtils,
      idGenerator: new CountingIdGenerator("session"),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async (request) => {
        runnerCalls.push(request.device.deviceId);
        throw new Error("a headset provision must never prepare an automation runner");
      },
      appleVisionSimulatorBootFactory: () => new AppleVisionSimulatorBoot(simctl, admission),
      appleVisionSimulatorProvisionerFactory: () =>
        new AppleVisionSimulatorProvisioner(inventory, simctl),
    });
    registerDeviceTools();
    return {
      simctl,
      pool,
      sessions: sessionManager,
      runnerCalls,
      timer,
      lifecycleCoordinator,
    };
  }

  /** Call a registered tool as MCP ingress does: under the connection its args name (#15663). */
  const call = (
    name: string,
    args: Record<string, unknown>,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) =>
    withWireConnection(args, (wireArgs) =>
      ToolRegistry.getTool(name)!.handler(wireArgs, progress, signal),
    );

  /** `provisionAppleVisionDevice` called directly, under the connection its args name. */
  const provisionVisionDirect = (
    args: Record<string, unknown>,
    bind: Parameters<typeof provisionAppleVisionDevice>[1],
  ) => withWireConnection(args, (wireArgs) => provisionAppleVisionDevice(wireArgs, bind));

  const provision = (args: Record<string, unknown>) =>
    call("provisionDevice", { __mcpSessionId: "client-a", ...args });

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  test("startDevice boots an existing headset, binds at booted readiness", async () => {
    const headset = visionDevice({ name: NAME, state: "Shutdown" });
    const { simctl, sessions, runnerCalls, timer } = await arrange([headset]);
    const result = toolJson(
      await call("startDevice", {
        platform: "visionos",
        deviceId: headset.udid,
        __mcpSessionId: "client-a",
      }),
    );
    expect(startDeviceOutputSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      platform: "visionos",
      acquisition: "cold-boot",
      readiness: { level: "booted", checks: ["bootCompleted", "sessionBound"] },
    });
    expect(
      sessions.getSession(
        z
          .object({ runtime: z.object({ session: z.object({ sessionUuid: z.string() }) }) })
          .parse(result).runtime.session.sessionUuid,
      )?.cacheData.deviceReadiness,
    ).toBe("booted");
    expect(simctl.commands).toEqual([`boot ${headset.udid} 360000`]);
    expect(runnerCalls).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("startDevice adopts an already booted headset by exact name without another boot", async () => {
    const { simctl, timer } = await arrange([visionDevice({ name: NAME, state: "Booted" })]);
    const result = toolJson(
      await call("startDevice", {
        platform: "visionos",
        name: NAME,
        __mcpSessionId: "client-a",
      }),
    );
    expect(result).toMatchObject({ platform: "visionos", acquisition: "already-booted" });
    expect(simctl.commands).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("one-shot CLI startDevice reuses the anonymous acquisition session for the same headset", async () => {
    const headset = visionDevice({ name: NAME, state: "Booted" });
    const { sessions, simctl, timer } = await arrange([headset]);
    const start = () =>
      call("startDevice", {
        platform: "visionos",
        deviceId: headset.udid,
        __oneShotCli: true,
      });
    const resultSchema = z.object({
      runtime: z.object({ session: z.object({ sessionUuid: z.string() }) }),
    });
    const first = resultSchema.parse(toolJson(await start()));
    const sessionId = first.runtime.session.sessionUuid;
    const session = sessions.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session && isAnonymousAcquisitionSession(session)).toBe(true);

    const repeated = resultSchema.parse(toolJson(await start()));
    expect(repeated.runtime.session.sessionUuid).toBe(sessionId);
    expect(sessions.getAllSessions()).toHaveLength(1);
    expect(simctl.commands).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("one-shot CLI startDevice rejects a headset held by another client's session", async () => {
    const headset = visionDevice({ name: NAME, state: "Booted" });
    const { sessions, simctl, timer } = await arrange([headset]);
    const result = toolJson(
      await call("startDevice", {
        platform: "visionos",
        deviceId: headset.udid,
        __mcpSessionId: "client-a",
      }),
    );
    const sessionId = z
      .object({ runtime: z.object({ session: z.object({ sessionUuid: z.string() }) }) })
      .parse(result).runtime.session.sessionUuid;
    const session = sessions.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session && isAnonymousAcquisitionSession(session)).toBe(false);

    await expect(
      call("startDevice", {
        platform: "visionos",
        deviceId: headset.udid,
        __oneShotCli: true,
      }),
    ).rejects.toThrow(`held by session ${sessionId}`);
    expect(sessions.getAllSessions()).toHaveLength(1);
    expect(simctl.commands).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("an unqualified pool request never selects an Apple Vision Pro", async () => {
    const { pool } = await arrange([visionDevice({ name: NAME, state: "Booted" })]);
    expect(new DeviceCriteriaMatcher().filterDevices(pool.getAllDevices())).toEqual([]);
    expect(
      new DeviceCriteriaMatcher()
        .filterDevices(pool.getAllDevices(), { platform: "visionos" })
        .map((device) => device.platform),
    ).toEqual(["visionos"]);
  });

  test("startDevice waits for simctl readiness before binding a session", async () => {
    const headset = visionDevice({ name: NAME, state: "Shutdown" });
    const { simctl, timer, sessions } = await arrange([headset]);
    const reachedBoot = Promise.withResolvers<void>();
    const readyDevice = Promise.withResolvers<BootedDevice>();
    simctl.waitForSimulatorReady = async () => {
      reachedBoot.resolve();
      return await readyDevice.promise;
    };
    const pending = call("startDevice", {
      platform: "visionos",
      deviceId: headset.udid,
      timeoutMs: 50,
      __mcpSessionId: "client-a",
    });
    const ready = await Promise.race([reachedBoot.promise.then(() => "boot"), pending]);
    expect(ready).toBe("boot");
    expect(sessions.getAllSessions()).toEqual([]);
    timer.advanceTime(7);
    headset.state = "Booted";
    simctl.onStateChange?.();
    readyDevice.resolve({ platform: "ios", name: headset.name, deviceId: headset.udid });
    expect(toolJson(await pending)).toMatchObject({
      platform: "visionos",
      readiness: { elapsedMs: 7 },
    });
    expect(sessions.getAllSessions()).toHaveLength(1);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("startDevice reports a failed simctl boot without binding or preparing a runner", async () => {
    const headset = visionDevice({ name: NAME, state: "Shutdown" });
    const { simctl, sessions, runnerCalls, timer } = await arrange([headset]);
    simctl.bootError = new Error("simctl bootstatus failed");
    await expect(
      call("startDevice", {
        platform: "visionos",
        deviceId: headset.udid,
        __mcpSessionId: "client-a",
      }),
    ).rejects.toThrow("simctl bootstatus failed");
    expect(sessions.getAllSessions()).toEqual([]);
    expect(runnerCalls).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("startDevice refuses Android/iOS setup options before booting a headset", async () => {
    const { simctl } = await arrange([visionDevice({ name: NAME })]);
    await expect(
      call("startDevice", {
        platform: "visionos",
        name: NAME,
        screenSize: "1080x1920",
        __mcpSessionId: "client-a",
      }),
    ).rejects.toThrow("Invalid visionOS startDevice request");
    expect(simctl.commands).toEqual([]);
  });

  test("setActiveDevice selects a headset only when visionos is named and skips runner preparation", async () => {
    const headset = visionDevice({ name: NAME, state: "Booted" });
    const { pool, sessions, timer } = await arrange([headset]);
    const sessionId = "headset-selection";
    expect(sessions.getSession(sessionId)).toBeNull();
    expect(pool.getDevice(headset.udid)?.sessionId).toBeNull();
    const handler = createSetActiveDeviceHandler({
      resumeCtrlProxy: async () => {
        throw new Error("a headset must not resume CtrlProxy");
      },
    });
    await expect(handler({ deviceId: headset.udid, sessionUuid: sessionId })).rejects.toThrow(
      "platform",
    );
    await handler({ deviceId: headset.udid, platform: "visionos", sessionUuid: sessionId });
    expect(sessions.getSession(sessionId)?.platform).toBe("visionos");
    expect(sessions.getSession(sessionId)?.assignedDevice).toBe(headset.udid);
    expect(pool.getDevice(headset.udid)?.sessionId).toBe(sessionId);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("creates a missing headset, boots it and binds a visionOS session without a runner", async () => {
    const { simctl, pool, sessions, runnerCalls } = await arrange();

    const result = toolJson(await provision({ device: headset }));

    const created = simctl.commands[0]!;
    expect(created).toBe(`create ${NAME} ${SPEC.deviceType} ${SPEC.runtime}`);
    const udid = Object.values(simctl.listing.devices)
      .flat()
      .find((device) => device.name === NAME)!.udid;
    // The boot gets what is left of the default 8-minute provisionDevice budget.
    expect(simctl.commands.slice(1)).toEqual([`boot ${udid} 480000`]);
    expect(runnerCalls).toEqual([]);
    const { sessionId } = sessionSchema.parse(result);
    expect(pool.getDevice(udid)).toMatchObject({ platform: "visionos", sessionId });
    expect(sessions.getSession(sessionId)?.cacheData.deviceReadiness).toBe("booted");
    expect(result).toMatchObject({
      message: `visionos '${NAME}' provisioned (ready)`,
      created: true,
      adopted: false,
      lifecycleState: "ready",
      readiness: { mode: "none", status: "device_ready" },
      requestedSpec: SPEC,
      acquisition: "cold-boot",
    });
    expect(provisionDeviceOutputSchema.safeParse(result).success).toBe(true);
  });

  test("with autolock, the bound headset session belongs to the calling connection", async () => {
    const { pool } = await arrange([], { autolock: "1" });

    const { sessionId } = sessionSchema.parse(toolJson(await provision({ device: headset })));

    expect(pool.resolveAutolockSessionForMcpSession("client-a", "visionos")).toBe(sessionId);
  });

  for (const caller of ["client-a", "client-b"] as const) {
    test(`reprovisioning a held headset checks the caller's ownership (${caller})`, async () => {
      const { simctl, timer } = await arrange();
      const { sessionId } = sessionSchema.parse(toolJson(await provision({ device: headset })));
      simctl.commands.length = 0;
      let bindCalls = 0;
      const outcome = await provisionVisionDirect(
        { __mcpSessionId: caller, device: headset },
        async (...args) => {
          bindCalls++;
          return await bindBootedDeviceSession(...args);
        },
      ).then(toolJson, (error: unknown) => error);

      if (caller === "client-a") {
        expect(outcome).toMatchObject({ sessionId, lifecycleState: "ready", adopted: true });
        expect(bindCalls).toBe(1);
      } else {
        expect(outcome).toBeInstanceOf(ActionableError);
        expect(String(outcome)).toContain(`held by session ${sessionId}`);
        expect(bindCalls).toBe(0);
      }
      expect(simctl.commands).toEqual([]);
      expect(timer.getSleepHistory()).toEqual([]);
    });
  }

  for (const held of [true, false]) {
    for (const confirmation of ["throws", "omits"] as const) {
      test(`unconfirmed create respects a stable lifecycle holder (held=${held}, ${confirmation})`, async () => {
        const { simctl, lifecycleCoordinator, timer } = await arrange();
        const udid = "C0FFEE00-0000-4000-8000-000000000001";
        const identity = { kind: "stable", platform: "visionos", stableId: udid } as const;
        const foreign = held
          ? await lifecycleCoordinator.reserve(identity, {
              operation: "start",
              deadlineMs: timer.now() + 60_000,
            })
          : undefined;
        const inventory = new AppleVisionSimulatorInventory(simctl, "arm64");
        setDeviceToolsDependencies({
          appleVisionSimulatorProvisionerFactory: () =>
            new AppleVisionSimulatorProvisioner(
              {
                readCatalog: inventory.readCatalog.bind(inventory),
                listAppleVisionSimulators: async (signal) => {
                  if (simctl.commands.length > 0) {
                    if (confirmation === "omits") {
                      return [];
                    }
                    throw new Error("inventory unavailable after create");
                  }
                  return await inventory.listAppleVisionSimulators(signal);
                },
              },
              simctl,
            ),
        });
        try {
          const error = await failure(provision({ device: headset }));
          expect(error).toBeInstanceOf(ActionableError);
          expect(String(error)).toContain("Could not confirm created Apple Vision Pro simulator");
          expect(String(error)).toContain(
            confirmation === "throws" ? "inventory unavailable after create" : "does not show it",
          );
          expect(simctl.commands.filter((cmd) => cmd.startsWith("delete "))).toEqual(
            held ? [] : [`delete ${udid}`],
          );
          if (held) {
            expect(String(error)).toContain("the headset was left in place");
            expect(String(error)).toContain("deleteDevice");
            expect(lifecycleCoordinator.isReserved(identity)).toBe(true);
            expect(Object.values(simctl.listing.devices).flat()).toHaveLength(1);
          } else {
            expect(String(error)).toContain("the headset was deleted again");
            expect(lifecycleCoordinator.isReserved(identity)).toBe(false);
            expect(Object.values(simctl.listing.devices).flat()).toEqual([]);
          }
          expect(timer.getSleepHistory()).toEqual([]);
        } finally {
          foreign?.release();
        }
      });
    }
  }

  test("a headset shut down while provisioning waited for its lease is booted, not adopted as booted", async () => {
    const existing = visionDevice({ name: NAME, state: "Booted" });
    const { simctl, timer, lifecycleCoordinator } = await arrange([existing]);
    const shutdown = await lifecycleCoordinator.reserve(
      { kind: "stable", platform: "visionos", stableId: existing.udid },
      { operation: "shutdown", deadlineMs: timer.now() + 60_000 },
    );

    const pending = provision({ device: headset });
    for (let turn = 0; turn < 2_000; turn++) {
      await Promise.resolve();
    }
    await simctl.killSimulator({ name: NAME, platform: "visionos", deviceId: existing.udid });
    shutdown.release();
    const result = toolJson(await pending);

    expect(simctl.commands).toEqual([`shutdown ${existing.udid}`, `boot ${existing.udid} 480000`]);
    expect(result).toMatchObject({ lifecycleState: "ready", acquisition: "cold-boot" });
  });

  // A provision cancelled while its boot waits for simulator capacity must leave the admission
  // queue instead of holding its place and lease until a slot frees.
  test("a provision cancelled while its boot waits for admission cancels the admission", async () => {
    const request = new AbortController();
    const seen: Array<boolean | undefined> = [];
    const { simctl } = await arrange([], {
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

    const outcome = await call(
      "provisionDevice",
      { __mcpSessionId: "client-a", device: headset },
      undefined,
      request.signal,
    ).then(
      () => "delivered",
      () => "refused",
    );

    expect(outcome).toBe("refused");
    expect(seen).toEqual([false, true]);
    expect(simctl.commands.filter((cmd) => cmd.startsWith("delete "))).toHaveLength(1);
  });

  test("a start preempted while its boot waits for admission neither boots nor binds", async () => {
    const headset = visionDevice({ name: NAME, state: "Shutdown" });
    const reachedAdmission = Promise.withResolvers<AbortSignal | undefined>();
    const releaseAdmission = Promise.withResolvers<void>();
    const { simctl, pool, sessions, timer, lifecycleCoordinator } = await arrange([headset], {
      admission: {
        run: async (request, boot) => {
          reachedAdmission.resolve(request.signal);
          await releaseAdmission.promise;
          request.signal?.throwIfAborted();
          return await boot(request.timeoutMs);
        },
      },
    });
    const pending = failure(
      call("startDevice", {
        platform: "visionos",
        deviceId: headset.udid,
        __mcpSessionId: "client-a",
      }),
    );
    const admissionSignal = await reachedAdmission.promise;
    const teardown = lifecycleCoordinator.reserve(
      { kind: "stable", platform: "visionos", stableId: headset.udid },
      { operation: "teardown", deadlineMs: timer.now() + 60_000 },
    );
    releaseAdmission.resolve();
    const error = await pending;
    const lease = await teardown;
    lease.release();

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("preempted by teardown");
    expect(admissionSignal?.aborted).toBe(true);
    expect(simctl.commands).toEqual([]);
    expect(sessions.getAllSessions()).toEqual([]);
    expect(pool.getDevice(headset.udid)).toBeNull();
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("a provision preempted while its boot waits for admission neither boots nor binds", async () => {
    const existing = visionDevice({ name: NAME, state: "Shutdown" });
    const reachedAdmission = Promise.withResolvers<AbortSignal | undefined>();
    const releaseAdmission = Promise.withResolvers<void>();
    const { simctl, pool, sessions, timer, lifecycleCoordinator } = await arrange([existing], {
      admission: {
        run: async (request, boot) => {
          reachedAdmission.resolve(request.signal);
          await releaseAdmission.promise;
          request.signal?.throwIfAborted();
          return await boot(request.timeoutMs);
        },
      },
    });
    const pending = failure(
      call("provisionDevice", { __mcpSessionId: "client-a", device: headset }),
    );
    const admissionSignal = await reachedAdmission.promise;
    const teardown = lifecycleCoordinator.reserve(
      { kind: "stable", platform: "visionos", stableId: existing.udid },
      { operation: "teardown", deadlineMs: timer.now() + 60_000 },
    );
    releaseAdmission.resolve();
    const error = await pending;
    const lease = await teardown;
    lease.release();

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("preempted by teardown");
    expect(admissionSignal?.aborted).toBe(true);
    expect(simctl.commands).toEqual([]);
    expect(sessions.getAllSessions()).toEqual([]);
    expect(pool.getDevice(existing.udid)).toBeNull();
  });

  test("one-shot CLI provisionDevice reuses the anonymous acquisition session for the same headset", async () => {
    const existing = visionDevice({ name: NAME, state: "Booted" });
    const { sessions, simctl } = await arrange([existing]);
    const provision = () => call("provisionDevice", { device: headset, __oneShotCli: true });
    const sessionOf = () => {
      const all = sessions.getAllSessions();
      expect(all).toHaveLength(1);
      return all[0]!.sessionId;
    };

    await provision();
    const sessionId = sessionOf();
    const session = sessions.getSession(sessionId);
    expect(session && isAnonymousAcquisitionSession(session)).toBe(true);

    await provision();
    expect(sessionOf()).toBe(sessionId);
    expect(simctl.commands).toEqual([]);
  });

  test("boot false adopts the existing headset and binds nothing", async () => {
    const existing = visionDevice({ name: NAME });
    const { simctl, pool } = await arrange([existing]);

    const result = toolJson(await provision({ device: headset, boot: false }));

    expect(simctl.commands).toEqual([]);
    expect(pool.getDevice(existing.udid)).toBeNull();
    expect(result).toMatchObject({
      created: false,
      adopted: true,
      lifecycleState: "adopted",
      readiness: { mode: "none", status: "not_requested" },
    });
    expect(result).not.toHaveProperty("sessionId");
    expect(provisionDeviceOutputSchema.safeParse(result).success).toBe(true);
  });

  test("refuses readiness automation, resources and enableTools before any simctl call", async () => {
    const { simctl } = await arrange();

    const readiness = await failure(provision({ device: headset, readiness: "automation" }));
    const resources = await failure(
      provision({ device: headset, resources: { animations: "disabled" } }),
    );
    const tools = await failure(provision({ device: headset, enableTools: ["observe"] }));

    expect(readiness).toBeInstanceOf(ActionableError);
    expect(String(readiness)).toContain("visionOS has no automation runner");
    expect(String(resources)).toContain("resources is not supported on visionOS");
    expect(String(tools)).toContain("enableTools is not supported on visionOS");
    expect(simctl.commands).toEqual([]);
  });

  test("cancelled boot false deletes the created headset through the acquisition receipt", async () => {
    const { simctl } = await arrange();
    const request = new AbortController();
    const create = simctl.createSimulator.bind(simctl);
    simctl.createSimulator = async (...args) => {
      const udid = await create(...args);
      request.abort(new Error("client cancelled after create"));
      return udid;
    };
    const error = await failure(
      call(
        "provisionDevice",
        { __mcpSessionId: "client-a", device: headset, boot: false },
        undefined,
        request.signal,
      ),
    );
    expect(String(error)).toContain("cancelled");
    expect(simctl.commands.at(-1)).toBe("delete C0FFEE00-0000-4000-8000-000000000001");
    expect(Object.values(simctl.listing.devices).flat()).toEqual([]);
  });

  for (const claim of ["none", "lifecycle", "session"] as const) {
    test(`canonical bind failure cleans up only without a foreign claim (${claim})`, async () => {
      const { simctl, pool, lifecycleCoordinator } = await arrange();
      const coordinator: VirtualDeviceLifecycleCoordinator = {
        isReserved: (identity) => identity.kind === "stable" && claim === "lifecycle",
        reserve: async (identity, options) => {
          const lease = await lifecycleCoordinator.reserve(identity, options);
          if (identity.kind === "stable") {
            return lease;
          }
          return {
            ...lease,
            bindCanonicalIdentity: async (canonical) => {
              if (claim === "session") {
                await pool.addDevice({
                  name: NAME,
                  platform: "visionos",
                  deviceId: canonical.stableId,
                });
                patchDeviceBinding(pool.getDevice(canonical.stableId)!, {
                  sessionId: "foreign-session",
                  status: "busy",
                });
              }
              throw new ActionableError("canonical bind failed");
            },
          };
        },
      };
      setDeviceToolsDependencies({ lifecycleCoordinator: coordinator });
      const error = await failure(provision({ device: headset, boot: false }));
      expect(error).toBeInstanceOf(ActionableError);
      expect(String(error)).toContain("canonical bind failed");
      expect(simctl.commands.some((cmd) => cmd.startsWith("delete "))).toBe(claim === "none");
      if (claim !== "none") {
        expect(String(error)).toContain("deleteDevice");
      }
    });
  }

  test("the acquisition receipt leaves a created headset another lifecycle acquired", async () => {
    const { simctl, lifecycleCoordinator, timer } = await arrange();
    const receipt: AcquisitionReceipt = {};
    await runWithAcquisitionReceipt(receipt, () =>
      provisionAppleVisionDevice({ device: headset, boot: false }, async () => {
        throw new Error("must not bind");
      }),
    );
    const udid = Object.values(simctl.listing.devices).flat()[0]!.udid;
    const foreign = await lifecycleCoordinator.reserve(
      { kind: "stable", platform: "visionos", stableId: udid },
      { operation: "start", deadlineMs: timer.now() + 60_000 },
    );
    try {
      expect(receipt.started).toBeDefined();
      const error = await failure(receipt.started!.rollBack(new Error("cancelled delivery")));
      expect(String(error)).toContain("deleteDevice");
      expect(simctl.commands.some((cmd) => cmd.startsWith("delete "))).toBe(false);
    } finally {
      foreign.release();
    }
  });

  for (const created of [false, true]) {
    test(`a foreign pool holder refuses boot without deleting its headset (created=${created})`, async () => {
      const existing = visionDevice({ name: NAME });
      const { simctl, pool, lifecycleCoordinator } = await arrange(created ? [] : [existing]);
      setDeviceToolsDependencies({
        lifecycleCoordinator: {
          isReserved: lifecycleCoordinator.isReserved.bind(lifecycleCoordinator),
          reserve: async (identity, options) => {
            const lease = await lifecycleCoordinator.reserve(identity, options);
            return {
              ...lease,
              get identity() {
                return lease.identity;
              },
              bindCanonicalIdentity: async (canonical, revalidate) => {
                await lease.bindCanonicalIdentity(canonical, revalidate);
                await pool.addDevice({
                  name: NAME,
                  platform: "visionos",
                  deviceId: canonical.stableId,
                });
                const row = pool.getDevice(canonical.stableId)!;
                patchDeviceBinding(row, { sessionId: "foreign-session", status: "busy" });
              },
            };
          },
        },
      });
      const error = await failure(provision({ device: headset }));
      expect(error).toBeInstanceOf(ActionableError);
      expect(String(error)).toContain("held");
      expect(simctl.commands.some((cmd) => cmd.startsWith("boot "))).toBe(false);
      expect(simctl.commands.some((cmd) => cmd.startsWith("delete "))).toBe(false);
    });
  }

  test("a headset this call created is deleted again when its boot fails", async () => {
    const { simctl, pool } = await arrange();
    simctl.bootError = new Error("Unable to boot: CoreSimulator timed out");

    const error = await failure(provision({ device: headset }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("the headset was deleted again");
    expect(String(error)).toContain("CoreSimulator timed out");
    const udid = simctl.commands.at(-1)!.replace("delete ", "");
    expect(simctl.commands.map((command) => command.split(" ")[0])).toEqual([
      "create",
      "boot",
      "delete",
    ]);
    expect(
      Object.values(simctl.listing.devices)
        .flat()
        .map((d) => d.udid),
    ).not.toContain(udid);
    expect(pool.getDevice(udid)).toBeNull();
  });

  test("boot failure names deleteDevice when deleting the created headset also fails", async () => {
    const { simctl } = await arrange();
    const bootError = new ActionableError("CoreSimulator could not boot");
    simctl.bootError = bootError;
    simctl.deleteError = new Error("headset is busy");
    const error = await failure(provision({ device: headset }));
    expect(error).toBeInstanceOf(ActionableError);
    expect(error instanceof Error && error.cause).toBe(bootError);
    expect(String(error)).toContain("CoreSimulator could not boot");
    expect(String(error)).toContain(
      "deleting it again failed (headset is busy); delete it with deleteDevice",
    );
    expect(simctl.commands.map((cmd) => cmd.split(" ")[0])).toEqual(["create", "boot", "delete"]);
  });

  test("a headset this call created is deleted again when session binding fails", async () => {
    const { simctl } = await arrange();
    const error = await failure(
      provisionVisionDirect({ __mcpSessionId: "client-a", device: headset }, async () => {
        throw new Error("session bind failed");
      }),
    );
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("session bind failed");
    expect(simctl.commands.map((command) => command.split(" ")[0])).toEqual([
      "create",
      "boot",
      "delete",
    ]);
    expect(Object.values(simctl.listing.devices).flat()).toEqual([]);
  });

  test("an adopted headset whose boot fails is left in place", async () => {
    const existing = visionDevice({ name: NAME });
    const { simctl } = await arrange([existing]);
    simctl.bootError = new Error("Unable to boot: CoreSimulator timed out");

    const error = await failure(provision({ device: headset }));

    expect(String(error)).toContain("CoreSimulator timed out");
    expect(simctl.commands.some((command) => command.startsWith("delete"))).toBe(false);
  });

  test("startDevice refuses a headset another daemon claims before booting it", async () => {
    const existing = visionDevice({ name: NAME });
    const claims = new FakeVisionClaims((udid) => udid === existing.udid);
    const { simctl, sessions } = await arrange([existing], { ownership: claims });

    const error = await failure(
      call("startDevice", {
        platform: "visionos",
        deviceId: existing.udid,
        __mcpSessionId: "client-a",
      }),
    );

    expect(error).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect(claims.reads).toContain(existing.udid);
    expect(simctl.commands).toEqual([]);
    expect(sessions.getAllSessions()).toEqual([]);
  });

  test("provisionDevice refuses to boot an adopted headset another daemon claims", async () => {
    const existing = visionDevice({ name: NAME });
    const { simctl } = await arrange([existing], {
      ownership: new FakeVisionClaims((udid) => udid === existing.udid),
    });

    const error = await failure(provision({ device: headset }));

    expect(String(error)).toContain("another AutoMobile");
    expect(simctl.commands).toEqual([]);
  });

  test("a created headset another daemon claimed after a failed boot is left in place", async () => {
    const ref: { simctl?: FakeAppleVisionProvisionSimctl } = {};
    const { simctl } = await arrange([], {
      // The peer claims the new headset only once this call has tried to boot it.
      ownership: new FakeVisionClaims(
        () => ref.simctl?.commands.some((command) => command.startsWith("boot ")) === true,
      ),
    });
    ref.simctl = simctl;
    simctl.bootError = new Error("Unable to boot: CoreSimulator timed out");

    const error = await failure(provision({ device: headset }));

    expect(String(error)).toContain("delete it with deleteDevice");
    expect(simctl.commands.map((command) => command.split(" ")[0])).toEqual(["create", "boot"]);
    expect(Object.values(simctl.listing.devices).flat()).toHaveLength(1);
  });

  test("startDevice cancelled between boot and bind stops the headset it cold-booted", async () => {
    const existing = visionDevice({ name: NAME });
    const { simctl, sessions, pool } = await arrange([existing]);
    const request = new AbortController();
    const boot = simctl.waitForSimulatorReady.bind(simctl);
    simctl.waitForSimulatorReady = async (udid, timeoutMs) => {
      const booted = await boot(udid, timeoutMs);
      request.abort(new Error("client cancelled"));
      return booted;
    };

    const error = await failure(
      call(
        "startDevice",
        { platform: "visionos", deviceId: existing.udid, __mcpSessionId: "client-a" },
        undefined,
        request.signal,
      ),
    );

    expect(error).toBeDefined();
    expect(simctl.commands).toEqual([`boot ${existing.udid} 360000`, `shutdown ${existing.udid}`]);
    expect(sessions.getAllSessions()).toEqual([]);
    expect(holderOf(pool.getDevice(existing.udid)) ?? null).toBeNull();
  });

  for (const state of ["Shutdown", "Booted"] as const) {
    test(`a failed bind stops only a headset this call cold-booted (${state})`, async () => {
      const existing = visionDevice({ name: NAME, state });
      const { simctl } = await arrange([existing]);

      const error = await failure(
        provisionVisionDirect({ __mcpSessionId: "client-a", device: headset }, async () => {
          throw new Error("session bind failed");
        }),
      );

      expect(String(error)).toContain("session bind failed");
      expect(simctl.commands).toEqual(
        state === "Shutdown" ? [`boot ${existing.udid} 480000`, `shutdown ${existing.udid}`] : [],
      );
      expect(Object.values(simctl.listing.devices).flat()).toHaveLength(1);
    });
  }

  test("a boot refused for capacity is refused before simctl create", async () => {
    const { simctl } = await arrange();
    const checked: string[] = [];
    setDeviceToolsDependencies({
      checkBootCapacity: async (platform) => {
        checked.push(platform);
        throw new ActionableError("simulator boot capacity exhausted");
      },
    });

    const error = await failure(provision({ device: headset }));

    expect(String(error)).toContain("simulator boot capacity exhausted");
    expect(checked).toEqual(["visionos"]);
    expect(simctl.commands).toEqual([]);
  });

  for (const scenario of ["boot false", "adopt"] as const) {
    test(`no pre-create capacity check runs when nothing would be created and booted (${scenario})`, async () => {
      const { simctl } = await arrange(
        scenario === "adopt" ? [visionDevice({ name: NAME, state: "Booted" })] : [],
      );
      const checked: string[] = [];
      setDeviceToolsDependencies({
        checkBootCapacity: async (platform) => {
          checked.push(platform);
          throw new ActionableError("simulator boot capacity exhausted");
        },
      });

      const result = toolJson(
        await provision({ device: headset, ...(scenario === "boot false" ? { boot: false } : {}) }),
      );

      expect(checked).toEqual([]);
      expect(result).toMatchObject({ created: scenario === "boot false" });
      expect(simctl.commands.filter((command) => command.startsWith("boot "))).toEqual([]);
    });
  }

  test("Android and iOS keep their readiness default; the registered schema gives a headset none", () => {
    const ios = provisionDeviceSchema.parse({
      device: {
        platform: "ios",
        name: "iPhone",
        spec: {
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        },
      },
    });
    const parsedHeadset = provisionDeviceRegistrationSchema.parse({ device: headset });

    expect(ios).toMatchObject({ readiness: "automation", boot: true });
    expect(parsedHeadset).toMatchObject({ boot: true });
    expect(parsedHeadset.readiness).toBeUndefined();
  });
});
