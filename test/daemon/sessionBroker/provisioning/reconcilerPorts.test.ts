import { FakeDeviceUtils } from "../../../fakes/FakeDeviceUtils";
import { AndroidEmulatorUnavailableError } from "../../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { SimctlUnavailableError } from "../../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { describe, expect, spyOn, test } from "bun:test";
import { DeviceManagerBindingInventory } from "../../../../src/daemon/sessionBroker/provisioning/DeviceManagerBindingInventory";
import {
  BOOT_CAPACITY_CHECK_TIMEOUT_MS,
  GateBindingBootCapacity,
} from "../../../../src/daemon/sessionBroker/provisioning/GateBindingBootCapacity";
import { DEFAULT_SAMPLE_TIMEOUT_MS } from "../../../../src/devices/bootAdmission/BootAdmissionGate";
import { PoolBindingDeviceClaims } from "../../../../src/daemon/sessionBroker/provisioning/PoolBindingDeviceClaims";
import {
  ToolBindingProvisioner,
  type BindingToolInvoker,
} from "../../../../src/daemon/sessionBroker/provisioning/reconcilerPorts";
import type { PooledDevice } from "../../../../src/daemon/devicePool";
import { ProvisionDeviceError } from "../../../../src/devices/exactDeviceProvisioning";
import type { BootedDevice, DeviceInfo } from "../../../../src/models/index";
import { BootCapacityExhaustedError } from "../../../../src/models/BootCapacityExhaustedError";
import { BootedDeviceDiscoveryIncompleteError } from "../../../../src/models/BootedDeviceDiscoveryIncompleteError";
import {
  createProvisionDeviceResponse,
  createToolErrorResponse,
} from "../../../../src/server/deviceTools";
import { MultiPlatformDeviceManager } from "../../../../src/devices/deviceUtils";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { createFakeAndroidEmulator } from "../../../fakes/FakeAndroidEmulator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { drainUntil } from "../../../helpers/fakeTimerStepping";
import { BindingDiscoveryIncompleteError } from "../../../../src/daemon/sessionBroker/provisioning/refusal";
import { logger } from "../../../../src/utils/logger";

const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";

function recordingInvoker(response: unknown) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const invoke: BindingToolInvoker = async (name, args) => {
    calls.push({ name, args });
    return response;
  };
  return { calls, invoke };
}

function provisionerWith(invoke: BindingToolInvoker, images: DeviceInfo[] = []) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000);
  return new ToolBindingProvisioner({
    invokeTool: invoke,
    deviceManager: { listDeviceImages: async () => images },
    androidConfigReader: {
      readConfig: async () => ({ deviceName: "pixel_8" }) as never,
    },
    timer,
    releaseSession: async () => {},
  });
}

describe("ToolBindingProvisioner", () => {
  test("provisions with automation readiness and reads the provisionDevice result", async () => {
    const { calls, invoke } = recordingInvoker(
      createProvisionDeviceResponse({
        device: {
          name: "amslot-abc-0-g1-x",
          platform: "ios",
          identity: { stableId: "UDID-1" },
          runtime: { deviceId: "UDID-1" },
        },
        created: true,
        adopted: false,
        lifecycleState: "ready",
        readiness: { mode: "automation", status: "automation_ready" },
        sessionId: "session-9",
      }),
    );

    const provisioned = await provisionerWith(invoke).provision({
      platform: "ios",
      name: "amslot-abc-0-g1-x",
      spec: { runtime: IOS_18, deviceType: IPHONE_16 },
      mode: "create",
      deadlineMs: 61_000,
    });

    expect(calls[0]).toEqual({
      name: "provisionDevice",
      args: {
        device: {
          platform: "ios",
          name: "amslot-abc-0-g1-x",
          spec: { runtime: IOS_18, deviceType: IPHONE_16 },
        },
        boot: true,
        readiness: "automation",
        rollbackOnRetryableReadiness: false,
        timeoutMs: 60_000,
      },
    });
    expect(provisioned).toMatchObject({
      device: { stableId: "UDID-1", transportId: "UDID-1", name: "amslot-abc-0-g1-x" },
      created: true,
      sessionUuid: "session-9",
      readiness: { mode: "automation", status: "automation_ready" },
    });
  });

  test("passes the retained simulator identity from readiness failure evidence", async () => {
    const { invoke } = recordingInvoker(
      createToolErrorResponse("timeout", "readiness deadline", {
        error: { code: "timeout", retryable: true },
        lifecycle: {
          state: "created_not_ready",
          phase: "readiness",
          device: {
            platform: "ios",
            stableId: "UDID-kept",
            name: "kept",
            runtimeDeviceId: "UDID-kept",
          },
        },
      }),
    );
    await expect(
      provisionerWith(invoke).provision({
        platform: "ios",
        name: "kept",
        spec: { runtime: IOS_18, deviceType: IPHONE_16 },
        mode: "create",
        deadlineMs: 61_000,
      }),
    ).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
      diagnostics: { retainedDevice: { platform: "ios", stableId: "UDID-kept", name: "kept" } },
    });
  });

  test.each([undefined, "kept", "UDID-kept"])(
    "retained identity rejects a device name and falls back to runtime UDID %s",
    async (runtimeDeviceId) => {
      const { invoke } = recordingInvoker(
        createToolErrorResponse("timeout", "readiness deadline", {
          error: { code: "timeout", retryable: true },
          lifecycle: {
            state: "created_not_ready",
            phase: "readiness",
            device: { platform: "ios", stableId: "kept", name: "kept", runtimeDeviceId },
          },
        }),
      );
      const error = await provisionerWith(invoke)
        .provision({
          platform: "ios",
          name: "kept",
          spec: { runtime: IOS_18, deviceType: IPHONE_16 },
          mode: "create",
          deadlineMs: 61_000,
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProvisionDeviceError);
      if (!(error instanceof ProvisionDeviceError)) {
        throw new Error("Expected a typed provision failure");
      }
      expect(error.diagnostics.retainedDevice).toEqual(
        runtimeDeviceId === "UDID-kept"
          ? { platform: "ios", stableId: "UDID-kept", name: "kept" }
          : undefined,
      );
    },
  );

  test("an error response is rethrown as the typed provision failure", async () => {
    const { invoke } = recordingInvoker(
      createToolErrorResponse("capacity_exhausted", "3 devices booted", {
        error: {
          code: "capacity_exhausted",
          message: "3 devices booted",
          retryable: true,
          retryAfterMs: 5_000,
          limit: 3,
          booted: 3,
        },
      }),
    );

    const error = await provisionerWith(invoke)
      .provision({
        platform: "ios",
        name: "n",
        spec: { runtime: IOS_18, deviceType: IPHONE_16 },
        mode: "create",
        deadlineMs: 61_000,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProvisionDeviceError);
    expect(error).toMatchObject({
      code: "capacity_exhausted",
      retryable: true,
      diagnostics: { retryAfterMs: 5_000, capacity: { limit: 3, booted: 3 } },
    });
  });

  test("adopting with an omitted model passes the existing device's own model", async () => {
    const { calls, invoke } = recordingInvoker(
      createProvisionDeviceResponse({
        device: { name: "sim", platform: "ios", identity: { stableId: "UDID-2" } },
        created: false,
        lifecycleState: "ready",
        readiness: { mode: "automation", status: "automation_ready" },
        sessionId: "s",
      }),
    );
    const images: DeviceInfo[] = [
      { name: "sim", platform: "ios", deviceId: "UDID-2", isRunning: false, deviceType: IPHONE_16 },
    ];

    await provisionerWith(invoke, images).provision({
      platform: "ios",
      name: "sim",
      deviceId: "UDID-2",
      spec: { runtime: IOS_18 },
      mode: "adopt",
      deadlineMs: 61_000,
    });

    expect((calls[0]!.args.device as { spec: unknown }).spec).toEqual({
      runtime: IOS_18,
      deviceType: IPHONE_16,
    });
  });
});

describe("DeviceManagerBindingInventory", () => {
  test.each([
    ["android", new AndroidEmulatorUnavailableError("missing emulator")],
    ["ios", new SimctlUnavailableError("missing simctl")],
  ] as const)(
    "%s missing-toolchain error is incomplete with explicit availability evidence",
    async (platform, error) => {
      const inventory = new DeviceManagerBindingInventory({
        listDeviceImages: async () => {
          throw error;
        },
      });
      expect(await inventory.list(platform, {})).toEqual({
        complete: false,
        devices: [],
        toolchain: "not_installed",
      });
    },
  );

  test("a failed listing is incomplete, never empty-and-complete", async () => {
    const inventory = new DeviceManagerBindingInventory({
      listDeviceImages: async () => {
        throw new Error("simctl list timed out");
      },
    });

    expect(await inventory.list("ios", {})).toEqual({ complete: false, devices: [] });
  });

  describe("probeRunning (#15016)", () => {
    const avd: DeviceInfo = {
      name: "ambroker-verify-api30",
      platform: "android",
      isRunning: false,
    };
    const booted = (name: string, deviceId: string): BootedDevice => ({
      name,
      deviceId,
      platform: "android",
      source: "local",
    });

    function probing(
      discover: NonNullable<
        ConstructorParameters<typeof DeviceManagerBindingInventory>[0]["getBootedDevicesDetailed"]
      >,
    ) {
      return new DeviceManagerBindingInventory({
        listDeviceImages: async () => [],
        getBootedDevicesDetailed: discover,
      });
    }

    test("proves running only from a fresh, complete booted listing naming the AVD", async () => {
      const calls: Array<{ bypass?: boolean }> = [];
      const inventory = probing(async (_platform, options) => {
        calls.push({ bypass: options?.bypassAndroidDeviceListCache });
        return {
          devices: [booted(avd.name, "emulator-5556")],
          succeededPlatforms: new Set(["android"]),
        };
      });
      expect(await inventory.probeRunning?.(avd, {})).toBe(true);
      expect(calls).toEqual([{ bypass: true }]);
    });

    test("a complete listing without the AVD, or with only an unresolved emulator, is not proof", async () => {
      const inventory = probing(async () => ({
        devices: [
          booted("other-avd", "emulator-5554"),
          booted("Unknown (emulator-5610)", "emulator-5610"),
          booted(avd.name, "R58M123ABC"),
        ],
        succeededPlatforms: new Set(["android"]),
      }));
      expect(await inventory.probeRunning?.(avd, {})).toBe(false);
    });

    test("an incomplete listing or a discovery failure is not proof", async () => {
      expect(
        await probing(async () => ({
          devices: [booted(avd.name, "emulator-5556")],
          succeededPlatforms: new Set(),
        })).probeRunning?.(avd, {}),
      ).toBe(false);
      expect(
        await probing(async () => {
          throw new Error("adb offline");
        }).probeRunning?.(avd, {}),
      ).toBe(false);
    });

    test("an aborted probe rethrows the abort", async () => {
      const controller = new AbortController();
      const inventory = probing(async () => {
        controller.abort();
        throw new Error("aborted");
      });
      await expect(inventory.probeRunning?.(avd, { signal: controller.signal })).rejects.toThrow();
    });
  });
});

describe("PoolBindingDeviceClaims", () => {
  const avd: DeviceInfo = { name: "binding-avd", platform: "android", isRunning: true };

  function pooled(sessionId: string | null): PooledDevice {
    return {
      id: "emulator-5554",
      name: "binding-avd",
      avdName: "binding-avd",
      platform: "android",
      sessionId,
    } as PooledDevice;
  }

  test("a pooled runtime with a session holds the device", async () => {
    const claims = new PoolBindingDeviceClaims({
      getAllDevices: () => [pooled("session-1")],
      assertNotClaimedByForeignDaemon: async () => {},
    });
    expect((await claims.describe(avd)).kind).toBe("held");
  });

  test("reports a session as a live execution only when the daemon holds it as one (#11275)", () => {
    const pool = {
      getAllDevices: () => [pooled("session-1")],
      assertNotClaimedByForeignDaemon: async () => {},
    };
    const claims = new PoolBindingDeviceClaims(pool, {
      isLiveManagedExecutionSession: (sessionUuid) => sessionUuid === "session-1",
    });
    expect(claims.isLiveExecution("session-1")).toBe(true);
    expect(claims.isLiveExecution("session-2")).toBe(false);
    expect(new PoolBindingDeviceClaims(pool).isLiveExecution("session-1")).toBe(false);
  });

  test("lists the sessions this daemon's pool holds on the device, and only on it", () => {
    const claims = new PoolBindingDeviceClaims({
      getAllDevices: () => [
        pooled("session-1"),
        { ...pooled("other-session"), id: "emulator-5556", name: "other", avdName: "other" },
      ],
      assertNotClaimedByForeignDaemon: async () => {},
    });
    expect(claims.sessionsOn(avd)).toEqual(["session-1"]);
    expect(
      new PoolBindingDeviceClaims({
        getAllDevices: () => [pooled(null)],
        assertNotClaimedByForeignDaemon: async () => {},
      }).sessionsOn(avd),
    ).toEqual([]);
  });

  test("another daemon's claim holds the device", async () => {
    const claims = new PoolBindingDeviceClaims({
      getAllDevices: () => [pooled(null)],
      assertNotClaimedByForeignDaemon: async () => {
        throw new Error("owned by daemon 99");
      },
    });
    expect(await claims.describe(avd)).toEqual({ kind: "held", reason: "owned by daemon 99" });
  });

  test("an idle device with a known stopped state is free", async () => {
    const pool = { getAllDevices: () => [], assertNotClaimedByForeignDaemon: async () => {} };
    const claims = new PoolBindingDeviceClaims(pool);
    expect((await claims.describe({ ...avd, isRunning: false })).kind).toBe("free");
  });

  describe("driven by the real Android listing shape", () => {
    async function listedAvd(booted: BootedDevice[] | Error): Promise<DeviceInfo> {
      const fakeEmulator = createFakeAndroidEmulator({
        listAvds: async () => [{ name: "amslot-a", platform: "android", isRunning: false }],
        getBootedDevicesChecked: async () => {
          if (booted instanceof Error) {
            throw booted;
          }
          return booted;
        },
      });
      const manager = new MultiPlatformDeviceManager(new FakeAdbClient(), undefined, fakeEmulator);
      const inventory = await new DeviceManagerBindingInventory(manager).list("android", {});
      return inventory.devices[0];
    }

    const unresolved: BootedDevice = {
      name: "Unknown (emulator-5554)",
      platform: "android",
      deviceId: "emulator-5554",
      source: "local",
    };

    test("an AVD whose adb listing failed is unknown, not free", async () => {
      const device = await listedAvd(new Error("adb devices unavailable"));
      expect(device).toMatchObject({ isRunning: false, isRunningStateKnown: false });
      const pool = { getAllDevices: () => [], assertNotClaimedByForeignDaemon: async () => {} };
      expect((await new PoolBindingDeviceClaims(pool).describe(device)).kind).toBe("unknown");
    });

    test("an unresolved emulator held by a session makes the AVD unknown, not free", async () => {
      const device = await listedAvd([unresolved]);
      expect(device.isRunningStateKnown).toBe(false);
      const heldPool = {
        getAllDevices: () =>
          [
            {
              id: "emulator-5554",
              name: "Unknown (emulator-5554)",
              platform: "android",
              sessionId: "s-1",
            },
          ] as PooledDevice[],
        assertNotClaimedByForeignDaemon: async () => {},
      };
      expect((await new PoolBindingDeviceClaims(heldPool).describe(device)).kind).toBe("unknown");
    });

    test("a fully listed stopped AVD stays free", async () => {
      const device = await listedAvd([]);
      const pool = { getAllDevices: () => [], assertNotClaimedByForeignDaemon: async () => {} };
      expect((await new PoolBindingDeviceClaims(pool).describe(device)).kind).toBe("free");
    });
  });
});

describe("GateBindingBootCapacity", () => {
  test.each(["check", "reserve"] as const)(
    "%s maps an escaping ownership reader failure to typed unknown capacity",
    async (route) => {
      const error = new BindingDiscoveryIncompleteError("registry unreadable");
      const reader = { refresh: () => Promise.reject(error) };
      const capacity = new GateBindingBootCapacity(
        new FakeTimer(),
        () => reader.refresh(),
        async () => {
          await reader.refresh();
          throw new Error("unreachable after failed ownership read");
        },
      );
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const result =
          route === "check"
            ? await capacity.check("ios", {})
            : await capacity.reserve("ios", { timeoutMs: 1000 });
        expect(result).toMatchObject({
          kind: "unknown",
          message: expect.stringContaining("registry unreadable"),
        });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("capacity is unknown"), error);
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("a passing gate check is available capacity", async () => {
    const platforms: string[] = [];
    const capacity = new GateBindingBootCapacity(new FakeTimer(), async (platform) => {
      platforms.push(platform);
    });

    expect(await capacity.check("ios", {})).toEqual({ kind: "available" });
    expect(platforms).toEqual(["ios"]);
  });

  test("the gate's refusal keeps its limit, count, wait hint and external and held devices", async () => {
    const capacity = new GateBindingBootCapacity(new FakeTimer(), async () => {
      throw new BootCapacityExhaustedError(
        {
          platform: "ios",
          limit: 2,
          booted: 3,
          retryAfterMs: 5_000,
          externalDevices: ["UDID-1"],
          heldDevices: ["UDID-HELD"],
        },
        "full",
      );
    });

    expect(await capacity.check("ios", {})).toEqual({
      kind: "exhausted",
      limit: 2,
      booted: 3,
      retryAfterMs: 5_000,
      externalDevices: ["UDID-1"],
      heldDevices: ["UDID-HELD"],
    });
  });

  test("the gate's unknown booted count is unknown, never available", async () => {
    const capacity = new GateBindingBootCapacity(new FakeTimer(), async () => {
      throw new BootedDeviceDiscoveryIncompleteError("ios", {
        code: "failed",
        message: "simulator count unknown",
        retryable: true,
      });
    });

    expect(await capacity.check("ios", {})).toMatchObject({
      kind: "unknown",
      message: expect.stringContaining("simulator count unknown"),
    });
  });

  test("a sample as slow as the gate's own 15 s budget is still answered, not unknown (#13801)", async () => {
    const timer = new FakeTimer();
    const capacity = new GateBindingBootCapacity(
      timer,
      () => new Promise<void>((resolve) => timer.setTimeout(resolve, DEFAULT_SAMPLE_TIMEOUT_MS)),
    );

    const check = capacity.check("ios", {});
    await timer.advanceTimersByTimeAsync(DEFAULT_SAMPLE_TIMEOUT_MS);

    expect(await check).toEqual({ kind: "available" });
  });

  test("a check that never answers is unknown just after the gate's sample budget, with no real wait", async () => {
    const timer = new FakeTimer();
    const capacity = new GateBindingBootCapacity(timer, () => new Promise<void>(() => {}));

    const check = capacity.check("ios", {});
    await timer.advanceTimersByTimeAsync(BOOT_CAPACITY_CHECK_TIMEOUT_MS - 1);
    let settled = false;
    void check.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await timer.advanceTimersByTimeAsync(1);

    expect(await check).toEqual({
      kind: "unknown",
      message: `Timed out after ${BOOT_CAPACITY_CHECK_TIMEOUT_MS}ms checking ios boot capacity.`,
    });
  });

  test.each([3_000, 60_000])(
    "bounds and aborts the probe at min(%i, 17 s)",
    async (remainingMs) => {
      const timer = new FakeTimer();
      let probeSignal: AbortSignal | undefined;
      const capacity = new GateBindingBootCapacity(timer, async (_platform, signal) => {
        probeSignal = signal;
        await new Promise<void>(() => {});
      });
      const timeoutMs = Math.min(remainingMs, BOOT_CAPACITY_CHECK_TIMEOUT_MS);
      const check = capacity.check("ios", {
        timeoutMs: remainingMs,
        signal: new AbortController().signal,
      });
      await timer.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(probeSignal?.aborted).toBe(false);
      await timer.advanceTimersByTimeAsync(1);
      expect(probeSignal?.aborted).toBe(true);
      expect(await check).toEqual({
        kind: "unknown",
        message: `Timed out after ${timeoutMs}ms checking ios boot capacity.`,
      });
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("a short-budget probe finishes at 3 s rather than the 17 s backstop", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const capacity = new GateBindingBootCapacity(timer, () => new Promise<void>(() => {}));
    expect(await capacity.check("ios", { timeoutMs: 3_000 })).toMatchObject({ kind: "unknown" });
    expect(timer.now()).toBe(3_000);
  });

  const slotReservation = () => ({
    run: <T>(operation: () => Promise<T>) => operation(),
    markReplacedDeviceGone: () => {},
    release: () => {},
  });

  test("a slow replacement lookup leaves the reservation the gate's full sample budget (#14495)", async () => {
    const timer = new FakeTimer();
    const reserveTimeouts: number[] = [];
    const capacity = new GateBindingBootCapacity(
      timer,
      async () => {},
      (_platform, options) => {
        reserveTimeouts.push(options.timeoutMs);
        return new Promise((resolve) =>
          timer.setTimeout(() => resolve(slotReservation()), DEFAULT_SAMPLE_TIMEOUT_MS),
        );
      },
    );
    const result = capacity.reserve("android", {
      timeoutMs: 60_000,
      resolveReplacingDeviceId: () =>
        new Promise((resolve) => timer.setTimeout(() => resolve("emulator-5554"), 3_000)),
    });
    await timer.advanceTimersByTimeAsync(3_000);
    await drainUntil(() => reserveTimeouts.length > 0, { description: "gate reservation" });
    await timer.advanceTimersByTimeAsync(DEFAULT_SAMPLE_TIMEOUT_MS);
    expect(await result).toMatchObject({ kind: "available" });
    // The gate is handed what is left of the request, not its original budget.
    expect(reserveTimeouts).toEqual([57_000]);
  });

  test("the request's timeoutMs still bounds the lookup and the sample together", async () => {
    const timer = new FakeTimer();
    let sampleSignal: AbortSignal | undefined;
    const capacity = new GateBindingBootCapacity(
      timer,
      async () => {},
      async (_platform, options) => {
        sampleSignal = options.signal;
        return await new Promise(() => {});
      },
    );
    const result = capacity.reserve("android", {
      timeoutMs: 10_000,
      resolveReplacingDeviceId: () =>
        new Promise((resolve) => timer.setTimeout(() => resolve("emulator-5554"), 3_000)),
    });
    await timer.advanceTimersByTimeAsync(3_000);
    await drainUntil(() => sampleSignal !== undefined, { description: "gate reservation" });
    await timer.advanceTimersByTimeAsync(7_000 - 1);
    expect(sampleSignal?.aborted).toBe(false);
    await timer.advanceTimersByTimeAsync(1);
    expect(sampleSignal?.aborted).toBe(true);
    expect(await result).toMatchObject({
      kind: "unknown",
      message: "Timed out reserving android boot capacity.",
    });
  });

  test("a defect in the gate propagates instead of becoming a retryable refusal", async () => {
    const capacity = new GateBindingBootCapacity(new FakeTimer(), async () => {
      throw new TypeError("gate.decide is not a function");
    });

    await expect(capacity.check("android", {})).rejects.toThrow("gate.decide is not a function");
  });

  test("a cancelled check rethrows the cancellation instead of reporting a count", async () => {
    const controller = new AbortController();
    const capacity = new GateBindingBootCapacity(new FakeTimer(), async () => {
      controller.abort(new Error("cancelled"));
      await new Promise<void>(() => {});
    });

    await expect(capacity.check("android", { signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
  });
});

test("late reservation after adapter timeout is released", async () => {
  const timer = new FakeTimer();
  let complete:
    | ((
        reservation: import("../../../../src/devices/bootAdmission/BootSlotReservation").BootSlotReservation,
      ) => void)
    | undefined;
  let released = 0;
  const capacity = new GateBindingBootCapacity(
    timer,
    async () => {},
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const result = capacity.reserve("ios", { timeoutMs: 60_000 });
  timer.advanceTime(BOOT_CAPACITY_CHECK_TIMEOUT_MS);
  expect(await result).toMatchObject({ kind: "unknown" });
  complete?.({
    run: (operation) => operation(),
    markReplacedDeviceGone: () => {},
    release: () => {
      released += 1;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(released).toBe(1);
});

test("replacement runtime lookup matches an AVD to its emulator serial, excluding physical devices", async () => {
  const manager = new FakeDeviceUtils();
  manager.setBootedDevices("android", [
    { platform: "android", name: "binding-avd", deviceId: "physical-serial" },
    { platform: "android", name: "other-avd", deviceId: "emulator-5554" },
    { platform: "android", name: "binding-avd", deviceId: "emulator-5556" },
  ]);
  const inventory = new DeviceManagerBindingInventory(manager);
  expect(
    await inventory.runtimeDeviceId(
      { platform: "android", name: "binding-avd", isRunning: true },
      {},
    ),
  ).toBe("emulator-5556");
});
