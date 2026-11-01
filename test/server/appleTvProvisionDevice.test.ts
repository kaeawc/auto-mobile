import { DeviceCriteriaMatcher } from "../../src/daemon/DeviceCriteriaMatcher";
import {
  runWithAcquisitionReceipt,
  type AcquisitionReceipt,
} from "../../src/daemon/acquisitionReceipt";
import { patchDeviceBinding } from "../helpers/patchDeviceBinding";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import { startDeviceOutputSchema } from "../../src/server/toolOutputSchemas";
import { provisionAppleTvDevice } from "../../src/server/deviceToolsAppleTvProvision";
import { bindBootedDeviceSession } from "../../src/server/deviceToolsStartDevice";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { toolJson } from "../helpers/toolResponse";
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
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError, type BootedDevice } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { AppleTvSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import {
  AppleTvSimulatorBoot,
  type AppleTvBootAdmission,
} from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorBoot";
import { AppleTvSimulatorProvisioner } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorProvisioner";
import {
  type VirtualDeviceLifecycleCoordinator,
  InMemoryVirtualDeviceLifecycleCoordinator,
} from "../../src/devices/virtualDeviceLifecycleCoordinator";
import type { AppleDevice } from "../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  FakeAppleTvProvisionSimctl,
  TV_DEVICE_TYPE,
  TV_RUNTIME_ID,
  tvDevice,
} from "../fakes/FakeAppleTvSimctl";

isolateToolRegistry();

// provisionDevice with platform "tvos" adopts or creates an exact Apple TV simulator and,
// with boot, binds a session at readiness "booted"; no automation runner runs (#15889).

const NAME = "AutoMobile TV";
const SPEC = { deviceType: TV_DEVICE_TYPE.identifier, runtime: TV_RUNTIME_ID };
const TV = { platform: "tvos", name: NAME, spec: SPEC };
const sessionSchema = z.object({ sessionId: z.string() });

describe("provisionDevice on an Apple TV simulator", () => {
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
    { autolock = "0", admission }: { autolock?: "0" | "1"; admission?: AppleTvBootAdmission } = {},
  ) {
    env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = autolock;
    restoreEnv = ToolRegistry.setPipelineOverridesForTesting({ env });
    const simctl = new FakeAppleTvProvisionSimctl(devices);
    const inventory = new AppleTvSimulatorInventory(simctl, "arm64");
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.listDeviceImages = () => inventory.listAppleTvSimulators();
    const publishBootedAppleTves = () =>
      deviceUtils.setBootedDevices(
        "tvos",
        Object.values(simctl.listing.devices)
          .flat()
          .filter((device) => device.state === "Booted" && device.name !== "iPhone 16")
          .map((device): BootedDevice => ({
            name: device.name,
            platform: "tvos",
            deviceId: device.udid,
          })),
      );
    publishBootedAppleTves();
    simctl.onStateChange = publishBootedAppleTves;
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        env,
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices(await deviceUtils.getBootedDevices("tvos"));
    DaemonState.getInstance().initialize(sessionManager, pool);
    const runnerCalls: string[] = [];
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    setDeviceToolsDependencies({
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
        throw new Error("a TV provision must never prepare an automation runner");
      },
      appleTvSimulatorBootFactory: () => new AppleTvSimulatorBoot(simctl, admission),
      appleTvSimulatorProvisionerFactory: () => new AppleTvSimulatorProvisioner(inventory, simctl),
    });
    registerDeviceTools();
    return { simctl, pool, sessions: sessionManager, runnerCalls, timer, lifecycleCoordinator };
  }

  const provision = (args: Record<string, unknown>) =>
    ToolRegistry.getTool("provisionDevice")!.handler({ __mcpSessionId: "client-a", ...args });

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  test("startDevice boots an existing TV and binds at booted readiness without a runner", async () => {
    const tv = tvDevice({ name: NAME, state: "Shutdown" });
    const { simctl, sessions, runnerCalls, timer } = await arrange([tv]);
    const result = toolJson(
      await ToolRegistry.getTool("startDevice")!.handler({
        platform: "tvos",
        deviceId: tv.udid,
        __mcpSessionId: "client-a",
      }),
    );
    expect(startDeviceOutputSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      platform: "tvos",
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
    expect(simctl.commands).toEqual([`boot ${tv.udid} 360000`]);
    expect(runnerCalls).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("startDevice adopts an already booted TV by exact name without another boot", async () => {
    const { simctl, timer } = await arrange([tvDevice({ name: NAME, state: "Booted" })]);
    const result = toolJson(
      await ToolRegistry.getTool("startDevice")!.handler({
        platform: "tvos",
        name: NAME,
        __mcpSessionId: "client-a",
      }),
    );
    expect(result).toMatchObject({ platform: "tvos", acquisition: "already-booted" });
    expect(simctl.commands).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("an unqualified pool request never selects an Apple TV", async () => {
    const { pool } = await arrange([tvDevice({ name: NAME, state: "Booted" })]);
    expect(new DeviceCriteriaMatcher().filterDevices(pool.getAllDevices())).toEqual([]);
    expect(
      new DeviceCriteriaMatcher()
        .filterDevices(pool.getAllDevices(), { platform: "tvos" })
        .map((device) => device.platform),
    ).toEqual(["tvos"]);
  });

  test("startDevice waits for simctl readiness before binding a session", async () => {
    const tv = tvDevice({ name: NAME, state: "Shutdown" });
    const { simctl, timer, sessions } = await arrange([tv]);
    const reachedBoot = Promise.withResolvers<void>();
    const readyDevice = Promise.withResolvers<BootedDevice>();
    simctl.waitForSimulatorReady = async () => {
      reachedBoot.resolve();
      return await readyDevice.promise;
    };
    const pending = ToolRegistry.getTool("startDevice")!.handler({
      platform: "tvos",
      deviceId: tv.udid,
      timeoutMs: 50,
      __mcpSessionId: "client-a",
    });
    const ready = await Promise.race([reachedBoot.promise.then(() => "boot"), pending]);
    expect(ready).toBe("boot");
    expect(sessions.getAllSessions()).toEqual([]);
    timer.advanceTime(7);
    tv.state = "Booted";
    simctl.onStateChange?.();
    readyDevice.resolve({ platform: "ios", name: tv.name, deviceId: tv.udid });
    expect(toolJson(await pending)).toMatchObject({
      platform: "tvos",
      readiness: { elapsedMs: 7 },
    });
    expect(sessions.getAllSessions()).toHaveLength(1);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("startDevice reports a failed simctl boot without binding or preparing a runner", async () => {
    const tv = tvDevice({ name: NAME, state: "Shutdown" });
    const { simctl, sessions, runnerCalls, timer } = await arrange([tv]);
    simctl.bootError = new Error("simctl bootstatus failed");
    await expect(
      ToolRegistry.getTool("startDevice")!.handler({
        platform: "tvos",
        deviceId: tv.udid,
        __mcpSessionId: "client-a",
      }),
    ).rejects.toThrow("simctl bootstatus failed");
    expect(sessions.getAllSessions()).toEqual([]);
    expect(runnerCalls).toEqual([]);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("startDevice refuses Android/iOS setup options before booting a TV", async () => {
    const { simctl } = await arrange([tvDevice({ name: NAME })]);
    await expect(
      ToolRegistry.getTool("startDevice")!.handler({
        platform: "tvos",
        name: NAME,
        screenSize: "1080x1920",
        __mcpSessionId: "client-a",
      }),
    ).rejects.toThrow("Invalid tvOS startDevice request");
    expect(simctl.commands).toEqual([]);
  });

  test("setActiveDevice selects a TV only when tvos is named and skips runner preparation", async () => {
    const tv = tvDevice({ name: NAME, state: "Booted" });
    const { sessions, timer } = await arrange([tv]);
    const provisioned = toolJson(await provision({ device: TV }));
    const { sessionId } = sessionSchema.parse(provisioned);
    const handler = createSetActiveDeviceHandler({
      resumeCtrlProxy: async () => {
        throw new Error("a TV must not resume CtrlProxy");
      },
    });
    await expect(handler({ deviceId: tv.udid, sessionUuid: sessionId })).rejects.toThrow(
      "platform",
    );
    await handler({ deviceId: tv.udid, platform: "tvos", sessionUuid: sessionId });
    expect(sessions.getSession(sessionId)?.platform).toBe("tvos");
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("creates a missing tv, boots it and binds a TVos session without a runner", async () => {
    const { simctl, pool, sessions, runnerCalls } = await arrange();

    const result = toolJson(await provision({ device: TV }));

    const created = simctl.commands[0]!;
    expect(created).toBe(`create ${NAME} ${SPEC.deviceType} ${SPEC.runtime}`);
    const udid = Object.values(simctl.listing.devices)
      .flat()
      .find((device) => device.name === NAME)!.udid;
    // The boot gets what is left of the default 8-minute provisionDevice budget.
    expect(simctl.commands.slice(1)).toEqual([`boot ${udid} 480000`]);
    expect(runnerCalls).toEqual([]);
    const { sessionId } = sessionSchema.parse(result);
    expect(pool.getDevice(udid)).toMatchObject({ platform: "tvos", sessionId });
    expect(sessions.getSession(sessionId)?.cacheData.deviceReadiness).toBe("booted");
    expect(result).toMatchObject({
      message: `tvos '${NAME}' provisioned (ready)`,
      created: true,
      adopted: false,
      lifecycleState: "ready",
      readiness: { mode: "none", status: "device_ready" },
      requestedSpec: SPEC,
      acquisition: "cold-boot",
    });
    expect(provisionDeviceOutputSchema.safeParse(result).success).toBe(true);
  });

  test("with autolock, the bound tv session belongs to the calling connection", async () => {
    const { pool } = await arrange([], { autolock: "1" });

    const { sessionId } = sessionSchema.parse(toolJson(await provision({ device: TV })));

    expect(pool.resolveAutolockSessionForMcpSession("client-a", "tvos")).toBe(sessionId);
  });

  for (const caller of ["client-a", "client-b"] as const) {
    test(`reprovisioning a held TV checks the caller's ownership (${caller})`, async () => {
      const { simctl, timer } = await arrange();
      const { sessionId } = sessionSchema.parse(toolJson(await provision({ device: TV })));
      simctl.commands.length = 0;
      let bindCalls = 0;
      const outcome = await provisionAppleTvDevice(
        { __mcpSessionId: caller, device: TV },
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
        const identity = { kind: "stable", platform: "tvos", stableId: udid } as const;
        const foreign = held
          ? await lifecycleCoordinator.reserve(identity, {
              operation: "start",
              deadlineMs: timer.now() + 60_000,
            })
          : undefined;
        const inventory = new AppleTvSimulatorInventory(simctl, "arm64");
        setDeviceToolsDependencies({
          appleTvSimulatorProvisionerFactory: () =>
            new AppleTvSimulatorProvisioner(
              {
                readCatalog: inventory.readCatalog.bind(inventory),
                listAppleTvSimulators: async (signal) => {
                  if (simctl.commands.length > 0) {
                    if (confirmation === "omits") {
                      return [];
                    }
                    throw new Error("inventory unavailable after create");
                  }
                  return await inventory.listAppleTvSimulators(signal);
                },
              },
              simctl,
            ),
        });
        try {
          const error = await failure(provision({ device: TV }));
          expect(error).toBeInstanceOf(ActionableError);
          expect(String(error)).toContain("Could not confirm created Apple TV simulator");
          expect(String(error)).toContain(
            confirmation === "throws" ? "inventory unavailable after create" : "does not show it",
          );
          expect(simctl.commands.filter((cmd) => cmd.startsWith("delete "))).toEqual(
            held ? [] : [`delete ${udid}`],
          );
          if (held) {
            expect(String(error)).toContain("the TV was left in place");
            expect(String(error)).toContain("deleteDevice");
            expect(lifecycleCoordinator.isReserved(identity)).toBe(true);
            expect(Object.values(simctl.listing.devices).flat()).toHaveLength(1);
          } else {
            expect(String(error)).toContain("the TV was deleted again");
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

  test("a TV shut down while provisioning waited for its lease is booted, not adopted as booted", async () => {
    const existing = tvDevice({ name: NAME, state: "Booted" });
    const { simctl, timer, lifecycleCoordinator } = await arrange([existing]);
    const shutdown = await lifecycleCoordinator.reserve(
      { kind: "stable", platform: "tvos", stableId: existing.udid },
      { operation: "shutdown", deadlineMs: timer.now() + 60_000 },
    );

    const pending = provision({ device: TV });
    for (let turn = 0; turn < 2_000; turn++) {
      await Promise.resolve();
    }
    await simctl.killSimulator({ name: NAME, platform: "tvos", deviceId: existing.udid });
    shutdown.release();
    const result = toolJson(await pending);

    expect(simctl.commands).toEqual([`shutdown ${existing.udid}`, `boot ${existing.udid} 480000`]);
    expect(result).toMatchObject({ lifecycleState: "ready", acquisition: "cold-boot" });
  });

  // A provision cancelled while its boot waits for simulator capacity must leave the admission
  // queue instead of holding its place and lease until a slot frees (#15889).
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

    const outcome = await ToolRegistry.getTool("provisionDevice")!
      .handler({ __mcpSessionId: "client-a", device: TV }, undefined, request.signal)
      .then(
        () => "delivered",
        () => "refused",
      );

    expect(outcome).toBe("refused");
    expect(seen).toEqual([false, true]);
    expect(simctl.commands.filter((cmd) => cmd.startsWith("delete "))).toHaveLength(1);
  });

  test("boot false adopts the existing TV and binds nothing", async () => {
    const existing = tvDevice({ name: NAME });
    const { simctl, pool } = await arrange([existing]);

    const result = toolJson(await provision({ device: TV, boot: false }));

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

    const readiness = await failure(provision({ device: TV, readiness: "automation" }));
    const resources = await failure(
      provision({ device: TV, resources: { animations: "disabled" } }),
    );
    const tools = await failure(provision({ device: TV, enableTools: ["observe"] }));

    expect(readiness).toBeInstanceOf(ActionableError);
    expect(String(readiness)).toContain("tvOS has no automation runner");
    expect(String(resources)).toContain("resources is not supported on tvOS");
    expect(String(tools)).toContain("enableTools is not supported on tvOS");
    expect(simctl.commands).toEqual([]);
  });

  test("cancelled boot false deletes the created TV through the acquisition receipt", async () => {
    const { simctl } = await arrange();
    const request = new AbortController();
    const create = simctl.createSimulator.bind(simctl);
    simctl.createSimulator = async (...args) => {
      const udid = await create(...args);
      request.abort(new Error("client cancelled after create"));
      return udid;
    };
    const error = await failure(
      ToolRegistry.getTool("provisionDevice")!.handler(
        { __mcpSessionId: "client-a", device: TV, boot: false },
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
                  platform: "tvos",
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
      const error = await failure(provision({ device: TV, boot: false }));
      expect(error).toBeInstanceOf(ActionableError);
      expect(String(error)).toContain("canonical bind failed");
      expect(simctl.commands.some((cmd) => cmd.startsWith("delete "))).toBe(claim === "none");
      if (claim !== "none") {
        expect(String(error)).toContain("deleteDevice");
      }
    });
  }

  test("the acquisition receipt leaves a created TV another lifecycle acquired", async () => {
    const { simctl, lifecycleCoordinator, timer } = await arrange();
    const receipt: AcquisitionReceipt = {};
    await runWithAcquisitionReceipt(receipt, () =>
      provisionAppleTvDevice({ device: TV, boot: false }, async () => {
        throw new Error("must not bind");
      }),
    );
    const udid = Object.values(simctl.listing.devices).flat()[0]!.udid;
    const foreign = await lifecycleCoordinator.reserve(
      { kind: "stable", platform: "tvos", stableId: udid },
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
    test(`a foreign pool holder refuses boot without deleting its TV (created=${created})`, async () => {
      const existing = tvDevice({ name: NAME });
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
                  platform: "tvos",
                  deviceId: canonical.stableId,
                });
                const row = pool.getDevice(canonical.stableId)!;
                patchDeviceBinding(row, { sessionId: "foreign-session", status: "busy" });
              },
            };
          },
        },
      });
      const error = await failure(provision({ device: TV }));
      expect(error).toBeInstanceOf(ActionableError);
      expect(String(error)).toContain("held");
      expect(simctl.commands.some((cmd) => cmd.startsWith("boot "))).toBe(false);
      expect(simctl.commands.some((cmd) => cmd.startsWith("delete "))).toBe(false);
    });
  }

  test("a TV this call created is deleted again when its boot fails", async () => {
    const { simctl, pool } = await arrange();
    simctl.bootError = new Error("Unable to boot: CoreSimulator timed out");

    const error = await failure(provision({ device: TV }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("the TV was deleted again");
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

  test("boot failure names deleteDevice when deleting the created TV also fails", async () => {
    const { simctl } = await arrange();
    const bootError = new ActionableError("CoreSimulator could not boot");
    simctl.bootError = bootError;
    simctl.deleteError = new Error("TV is busy");
    const error = await failure(provision({ device: TV }));
    expect(error).toBeInstanceOf(ActionableError);
    expect(error instanceof Error && error.cause).toBe(bootError);
    expect(String(error)).toContain("CoreSimulator could not boot");
    expect(String(error)).toContain(
      "deleting it again failed (TV is busy); delete it with deleteDevice",
    );
    expect(simctl.commands.map((cmd) => cmd.split(" ")[0])).toEqual(["create", "boot", "delete"]);
  });

  test("a TV this call created is deleted again when session binding fails", async () => {
    const { simctl } = await arrange();
    const error = await failure(
      provisionAppleTvDevice({ __mcpSessionId: "client-a", device: TV }, async () => {
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

  test("an adopted tv whose boot fails is left in place", async () => {
    const existing = tvDevice({ name: NAME });
    const { simctl } = await arrange([existing]);
    simctl.bootError = new Error("Unable to boot: CoreSimulator timed out");

    const error = await failure(provision({ device: TV }));

    expect(String(error)).toContain("CoreSimulator timed out");
    expect(simctl.commands.some((command) => command.startsWith("delete"))).toBe(false);
  });

  test("Android and iOS keep their readiness default; the registered schema gives a TV none", () => {
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
    const tv = provisionDeviceRegistrationSchema.parse({ device: TV });

    expect(ios).toMatchObject({ readiness: "automation", boot: true });
    expect(tv).toMatchObject({ boot: true });
    expect(tv.readiness).toBeUndefined();
  });
});
