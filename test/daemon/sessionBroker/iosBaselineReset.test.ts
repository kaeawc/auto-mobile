import { describe, expect, test } from "bun:test";
import { IosBaselineReset } from "../../../src/daemon/sessionBroker/iosBaselineReset";
import type { BrokerNativeProfile } from "../../../src/daemon/sessionBroker/profile";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { FleetBootInstrumentation } from "../../../src/features/iosSimFleet/IosBootInstrumentation";
import type {
  IosBootInstrumentation,
  IosBootRequest,
} from "../../../src/models/IosBootInstrumentation";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../../src/utils/deviceTimeouts";
import { FakeSimulatorCapacityGate } from "../../fakes/FakeSimulatorCapacityGate";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ActionableError } from "../../../src/models/ActionableError";
import type { BootedDevice, DeviceInfo } from "../../../src/models/DeviceInfo";

const UDID = "A1B2C3D4-E5F6-47A8-90AB-CDEF12345678";
const DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
const PROFILE: Extract<BrokerNativeProfile, { platform: "ios" }> = {
  platform: "ios",
  metadataState: "current",
  simulatorDeviceTypeIdentifier: DEVICE_TYPE,
  modelIdentifier: "iPhone18,1",
  archetype: "phone",
  modelType: { family: "iphone", variant: "pro" },
  runtimeId: RUNTIME,
  osVersion: "27",
  compatibility: "supported",
};
const DEVICE: BootedDevice = {
  name: "Broker iPhone",
  platform: "ios",
  deviceId: UDID,
};

function image(
  state: "Booted" | "Shutdown" | "Booting" | "Shutting Down" = "Booted",
  overrides: Partial<DeviceInfo> = {},
): DeviceInfo {
  return {
    name: DEVICE.name,
    platform: "ios",
    deviceId: UDID,
    isRunning: state === "Booted",
    state,
    isAvailable: true,
    deviceType: DEVICE_TYPE,
    runtimeId: RUNTIME,
    runtime: RUNTIME,
    osVersion: "27.0",
    iosVersion: "27.0",
    ...overrides,
  };
}

class FakeResetBootInstrumentation implements IosBootInstrumentation {
  readonly requests: IosBootRequest[] = [];
  error: Error | undefined;
  beforeBoot: (() => void) | undefined;

  constructor(private readonly events: string[]) {}

  async run<T>(request: IosBootRequest, boot: (remainingMs: number) => Promise<T>): Promise<T> {
    this.requests.push(request);
    this.events.push("admission:start");
    if (this.error) {
      throw this.error;
    }
    this.beforeBoot?.();
    const result = await boot(request.timeoutMs);
    this.events.push("admission:end");
    return result;
  }
}

function capacityRefusal(): BootCapacityExhaustedError {
  return new BootCapacityExhaustedError(
    { platform: "ios", limit: 1, booted: 1, retryAfterMs: 5_000 },
    "iOS simulator capacity exhausted",
  );
}

interface HarnessOptions {
  instrumentation?: IosBootInstrumentation;
  timer?: FakeTimer;
  inventories?: DeviceInfo[][];
  assertOwned?: (call: number) => Promise<void>;
  stopDevice?: () => Promise<void>;
  eraseSimulator?: () => Promise<void>;
  bootSimulator?: () => Promise<BootedDevice>;
}

function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const instrumentation = new FakeResetBootInstrumentation(events);
  const listOptions: unknown[] = [];
  const inventories = options.inventories ?? [[image()], [image("Shutdown")], [image()]];
  let listCall = 0;
  let ownershipCall = 0;
  const resetter = new IosBaselineReset(
    {
      iosBootInstrumentation: options.instrumentation ?? instrumentation,
      simctl: {
        listSimulatorImages: async (...args) => {
          events.push(`list:${++listCall}`);
          listOptions.push(args);
          return inventories[listCall - 1] ?? [];
        },
        eraseSimulator: async (udid) => {
          events.push(`erase:${udid}`);
          await options.eraseSimulator?.();
        },
        bootSimulator: async (udid) => {
          events.push(`boot:${udid}`);
          return (await options.bootSimulator?.()) ?? DEVICE;
        },
      },
      stopDevice: async (device) => {
        events.push(`stop:${device.deviceId}`);
        await options.stopDevice?.();
      },
    },
    options.timer ?? new FakeTimer(),
  );
  const assertOwned = async () => {
    events.push(`owned:${++ownershipCall}`);
    await options.assertOwned?.(ownershipCall);
  };
  return { resetter, assertOwned, events, listOptions, instrumentation };
}

describe("IosBaselineReset", () => {
  test("runs the bounded clean-baseline sequence with fresh authoritative reads", async () => {
    const h = harness();

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).resolves.toBe("clean");

    expect(h.events).toEqual([
      "list:1",
      "owned:1",
      `stop:${UDID}`,
      "list:2",
      "owned:2",
      `erase:${UDID}`,
      "admission:start",
      "owned:3",
      `boot:${UDID}`,
      "admission:end",
      "list:3",
      "owned:4",
    ]);
    expect(h.instrumentation.requests).toEqual([
      { udid: UDID, runtime: RUNTIME, timeoutMs: DEFAULT_DEVICE_READY_TIMEOUT_MS },
    ]);
    expect(h.listOptions).toEqual([
      [undefined, { bypassCache: true }],
      [undefined, { bypassCache: true }],
      [undefined, { bypassCache: true }],
    ]);
  });

  test("a capacity refusal stays typed and never calls bootSimulator", async () => {
    const h = harness();
    const refusal = capacityRefusal();
    h.instrumentation.error = refusal;

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(refusal);
    expect(refusal).toMatchObject({ code: "capacity_exhausted", retryable: true });
    expect(h.events).toEqual([
      "list:1",
      "owned:1",
      `stop:${UDID}`,
      "list:2",
      "owned:2",
      `erase:${UDID}`,
      "admission:start",
    ]);
  });

  test("ownership lost during admission prevents the boot mutation", async () => {
    const ownershipLost = new ActionableError("ownership changed during admission");
    let owned = true;
    const h = harness({
      assertOwned: async () => {
        if (!owned) {
          throw ownershipLost;
        }
      },
    });
    h.instrumentation.beforeBoot = () => {
      owned = false;
    };

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(ownershipLost);
    expect(h.events).toContain("admission:start");
    expect(h.events).not.toContain(`boot:${UDID}`);
    expect(h.events).not.toContain("list:3");
  });

  test("a deferred boot retries from authoritative Shutdown and re-erases before admission", async () => {
    const h = harness({
      inventories: [
        [image()],
        [image("Shutdown")],
        [image("Shutdown")],
        [image("Shutdown")],
        [image()],
      ],
    });
    const refusal = capacityRefusal();
    h.instrumentation.error = refusal;
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(refusal);
    h.instrumentation.error = undefined;
    h.events.length = 0;

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).resolves.toBe("clean");
    expect(h.events).toEqual([
      "list:3",
      "owned:3",
      "list:4",
      "owned:4",
      `erase:${UDID}`,
      "admission:start",
      "owned:5",
      `boot:${UDID}`,
      "admission:end",
      "list:5",
      "owned:6",
    ]);
  });

  test("a non-capacity boot failure does not permit a Shutdown retry", async () => {
    const h = harness({
      inventories: [[image()], [image("Shutdown")], [image("Shutdown")]],
      bootSimulator: async () => {
        throw new Error("boot failed");
      },
    });

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toThrow("boot failed");
    expect(h.events).toContain(`boot:${UDID}`);
    h.events.length = 0;

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toThrow(
      "lacks authoritative Booted",
    );
    expect(h.events).toEqual(["list:3"]);
  });

  test("a deferred boot refuses changed identity before any retry mutation", async () => {
    const h = harness({
      inventories: [
        [image()],
        [image("Shutdown")],
        [image("Shutdown", { runtimeId: `${RUNTIME}-other` })],
      ],
    });
    const refusal = capacityRefusal();
    h.instrumentation.error = refusal;
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(refusal);
    h.instrumentation.error = undefined;
    h.events.length = 0;

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toThrow(
      "lacks authoritative Shutdown",
    );
    expect(h.events).toEqual(["list:3"]);
  });

  test("an admitted reset records only boot duration in the shared instrumentation history", async () => {
    const timer = new FakeTimer();
    const history = new InMemoryBootDurationHistory();
    const gate = new FakeSimulatorCapacityGate(timer, {
      outcome: "allow",
      limits: { maxBooted: 1, source: "derived" },
      bootedCount: 0,
    });
    const h = harness({
      timer,
      instrumentation: new FleetBootInstrumentation({ timer, history, gate }),
      stopDevice: async () => {
        timer.advanceTime(10);
      },
      eraseSimulator: async () => {
        timer.advanceTime(20);
      },
      bootSimulator: async () => {
        expect(gate.admitted).toBe(1);
        timer.advanceTime(42);
        return DEVICE;
      },
    });

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).resolves.toBe("clean");
    expect(gate.requests[0]).toMatchObject({ runtime: RUNTIME, excludeUdids: [UDID] });
    expect(history.latestFor(UDID)).toMatchObject({ udid: UDID, durationMs: 42 });
    expect(gate.admitted).toBe(0);
  });

  test("the real instrumentation's gate refusal prevents boot and records no duration", async () => {
    const timer = new FakeTimer();
    const history = new InMemoryBootDurationHistory();
    const gate = new FakeSimulatorCapacityGate(timer, {
      outcome: "refuse",
      reason: "at-capacity",
      limits: { maxBooted: 1, source: "derived" },
      bootedCount: 1,
      retryAfterMs: 5_000,
      message: "capacity exhausted",
    });
    const h = harness({
      timer,
      instrumentation: new FleetBootInstrumentation({ timer, history, gate }),
    });

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBeInstanceOf(
      BootCapacityExhaustedError,
    );
    expect(h.events).not.toContain(`boot:${UDID}`);
    expect(history.latestFor(UDID)).toBeUndefined();
    expect(gate.admitted).toBe(0);
  });

  test("cannot erase until fresh inventory authoritatively reports Shutdown", async () => {
    const h = harness({ inventories: [[image()], [image("Shutting Down")]] });

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBeInstanceOf(
      ActionableError,
    );

    expect(h.events).toEqual(["list:1", "owned:1", `stop:${UDID}`, "list:2"]);
  });

  test("an ownership change stops before the next native mutation", async () => {
    const ownershipLost = new ActionableError("resource ownership changed");
    const h = harness({
      assertOwned: async (call) => {
        if (call === 2) {
          throw ownershipLost;
        }
      },
    });

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(ownershipLost);
    expect(h.events).toEqual(["list:1", "owned:1", `stop:${UDID}`, "list:2", "owned:2"]);
  });

  test("a final ownership change prevents a clean result", async () => {
    const ownershipLost = new ActionableError("resource ownership changed");
    const h = harness({
      assertOwned: async (call) => {
        if (call === 4) {
          throw ownershipLost;
        }
      },
    });

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(ownershipLost);
    expect(h.events.at(-1)).toBe("owned:4");
  });

  test.each([
    ["stop", { stopDevice: async () => Promise.reject(new Error("stop failed")) }],
    ["erase", { eraseSimulator: async () => Promise.reject(new Error("erase failed")) }],
    ["boot", { bootSimulator: async () => Promise.reject(new Error("boot failed")) }],
  ] satisfies Array<[string, HarnessOptions]>)(
    "%s failure does not start the following mutation",
    async (operation, options) => {
      const h = harness(options);

      await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toThrow(
        `${operation} failed`,
      );

      if (operation === "stop") {
        expect(h.events).not.toContain("list:2");
      } else if (operation === "erase") {
        expect(h.events.some((event) => event.startsWith("boot:"))).toBe(false);
      } else {
        expect(h.events).not.toContain("list:3");
      }
    },
  );

  test.each([
    ["missing target", []],
    ["duplicate target", [image(), image()]],
    ["unknown availability", [image("Booted", { isAvailable: undefined })]],
    ["partial type", [image("Booted", { deviceType: undefined })]],
    ["transitional state", [image("Booting")]],
    ["shutdown without a deferred boot", [image("Shutdown")]],
    ["different runtime", [image("Booted", { runtimeId: `${RUNTIME}-other` })]],
    ["different type", [image("Booted", { deviceType: `${DEVICE_TYPE}-other` })]],
    ["different OS", [image("Booted", { osVersion: "28.0", iosVersion: "28.0" })]],
  ] satisfies Array<[string, DeviceInfo[]]>)(
    "rejects %s before the first native mutation",
    async (_description, inventory) => {
      const h = harness({ inventories: [inventory] });

      await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBeInstanceOf(
        ActionableError,
      );
      expect(h.events).toEqual(["list:1"]);
    },
  );

  test.each([
    ["non-Booted state", image("Shutdown")],
    ["changed runtime", image("Booted", { runtimeId: `${RUNTIME}-other` })],
    ["changed type", image("Booted", { deviceType: `${DEVICE_TYPE}-other` })],
  ] satisfies Array<[string, DeviceInfo]>)(
    "does not return clean when final inventory has %s",
    async (_description, finalImage) => {
      const h = harness({ inventories: [[image()], [image("Shutdown")], [finalImage]] });

      await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBeInstanceOf(
        ActionableError,
      );
      expect(h.events.at(-1)).toBe("list:3");
    },
  );

  test("does not return clean before bootSimulator joins the completed boot", async () => {
    const bootEntered = Promise.withResolvers<void>();
    const finishBoot = Promise.withResolvers<BootedDevice>();
    let settled = false;
    const h = harness({
      bootSimulator: async () => {
        bootEntered.resolve();
        return finishBoot.promise;
      },
    });

    const reset = h.resetter.reset(DEVICE, PROFILE, h.assertOwned).then((result) => {
      settled = true;
      return result;
    });
    await bootEntered.promise;

    expect(settled).toBe(false);
    expect(h.events).not.toContain("list:3");

    finishBoot.resolve(DEVICE);
    await expect(reset).resolves.toBe("clean");
  });

  test("rejects a wrong boot result and invalid iOS reset inputs", async () => {
    const wrongBoot = harness({
      bootSimulator: async () => ({ ...DEVICE, deviceId: `${UDID}-other` }),
    });
    await expect(
      wrongBoot.resetter.reset(DEVICE, PROFILE, wrongBoot.assertOwned),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(wrongBoot.events).not.toContain("list:3");

    const invalidTarget = harness();
    await expect(
      invalidTarget.resetter.reset({ ...DEVICE, platform: "android" }, PROFILE, () =>
        Promise.resolve(),
      ),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(invalidTarget.events).toEqual([]);

    const duoProfile: typeof PROFILE = {
      ...PROFILE,
      archetype: "duo",
      modelType: { family: "duo", variant: "duo" },
    };
    const duo = harness();
    await expect(
      duo.resetter.reset(DEVICE, duoProfile, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(duo.events).toEqual([]);
  });
});
