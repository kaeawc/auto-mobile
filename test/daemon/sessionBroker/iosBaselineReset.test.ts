import { describe, expect, test } from "bun:test";
import { IosBaselineReset } from "../../../src/daemon/sessionBroker/iosBaselineReset";
import type { BrokerNativeProfile } from "../../../src/daemon/sessionBroker/profile";
import { InMemoryBootDurationHistory } from "../../../src/features/iosSimFleet/BootDurationHistory";
import { FleetBootInstrumentation } from "../../../src/features/iosSimFleet/IosBootInstrumentation";
import type {
  IosBootInstrumentation,
  IosBootRequest,
} from "../../../src/models/IosBootInstrumentation";
import { BootedDeviceDiscoveryIncompleteError } from "../../../src/models/BootedDeviceDiscoveryIncompleteError";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../../src/utils/deviceTimeouts";
import { FakeSimulatorCapacityGate } from "../../fakes/FakeSimulatorCapacityGate";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ActionableError } from "../../../src/models/ActionableError";
import type { BootedDevice } from "../../../src/models/DeviceInfo";
import type { AppleDevice } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { BootCapacityReserver } from "../../../src/devices/bootAdmission/BootSlotReservation";

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
  overrides: Partial<AppleDevice> = {},
): AppleDevice {
  return {
    name: DEVICE.name,
    udid: UDID,
    state,
    isAvailable: true,
    deviceTypeIdentifier: DEVICE_TYPE,
    runtime: RUNTIME,
    os_version: "27.0",
    ...overrides,
  };
}

class FakeResetBootInstrumentation implements IosBootInstrumentation {
  reserveBoot?: BootCapacityReserver["reserveBoot"];
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

function discoveryFailure(): BootedDeviceDiscoveryIncompleteError {
  return new BootedDeviceDiscoveryIncompleteError("ios", {
    code: "timeout",
    message: "timed out after 15000ms collecting iOS simulator capacity",
    retryable: true,
  });
}

const RESERVATION = {
  run: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
  markReplacedDeviceGone: () => {},
  release: () => {},
};

interface HarnessOptions {
  instrumentation?: IosBootInstrumentation;
  timer?: FakeTimer;
  inventories?: AppleDevice[][];
  readError?: Error;
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
        readSimulatorTarget: async (...args) => {
          events.push(`list:${++listCall}`);
          listOptions.push(args);
          if (options.readError) {
            throw options.readError;
          }
          const matches = (inventories[listCall - 1] ?? []).filter((row) => row.udid === args[0]);
          return matches.length === 1 ? matches[0] : undefined;
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
  test("retries incomplete discovery with backoff and fresh ownership before mutation", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const h = harness({ timer });
    const attempts: number[] = [];
    h.instrumentation.reserveBoot = async ({ timeoutMs }) => {
      attempts.push(timeoutMs);
      expect(h.events.at(-1)).toBe(`owned:${attempts.length}`);
      if (attempts.length <= 2) {
        throw discoveryFailure();
      }
      return RESERVATION;
    };
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).resolves.toBe("clean");
    expect(timer.getSleepHistory()).toEqual([1_000, 2_000]);
    expect(attempts).toEqual([
      DEFAULT_DEVICE_READY_TIMEOUT_MS,
      DEFAULT_DEVICE_READY_TIMEOUT_MS - 1_000,
      DEFAULT_DEVICE_READY_TIMEOUT_MS - 3_000,
    ]);
    expect(h.events.filter((event) => event.startsWith("stop:"))).toHaveLength(1);
    expect(h.events.filter((event) => event.startsWith("erase:"))).toHaveLength(1);
  });

  test("persistent incomplete discovery shares one remaining reservation budget", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const failure = discoveryFailure();
    const h = harness({ timer });
    const attempts: number[] = [];
    h.instrumentation.reserveBoot = async ({ timeoutMs }) => {
      attempts.push(timeoutMs);
      timer.advanceTime(Math.min(15_000, timeoutMs));
      throw failure;
    };
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(failure);
    expect(attempts.length).toBeGreaterThan(2);
    let elapsed = 0;
    for (const [index, timeout] of attempts.entries()) {
      expect(timeout).toBe(DEFAULT_DEVICE_READY_TIMEOUT_MS - elapsed);
      elapsed += Math.min(15_000, timeout) + (timer.getSleepHistory()[index] ?? 0);
    }
    expect(timer.now()).toBe(DEFAULT_DEVICE_READY_TIMEOUT_MS);
    expect(h.events.filter((event) => /^(stop|erase|boot):/.test(event))).toEqual([]);
  });

  test("abort during reservation backoff prevents another attempt", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const controller = new AbortController();
    const abort = new ActionableError("reset cancelled");
    const h = harness({ timer });
    let attempts = 0;
    h.instrumentation.reserveBoot = async () => {
      attempts++;
      timer.setTimeout(() => controller.abort(abort), 500);
      throw discoveryFailure();
    };
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned, controller.signal)).rejects.toBe(
      abort,
    );
    expect(attempts).toBe(1);
    expect(timer.getSleepHistory()).toEqual([1_000]);
    expect(h.events).toEqual(["list:1", "owned:1"]);
  });

  test("does not sleep when the remaining budget cannot cover the next backoff", async () => {
    const timer = new FakeTimer();
    const h = harness({ timer });
    const failure = discoveryFailure();
    let attempts = 0;
    h.instrumentation.reserveBoot = async () => {
      attempts++;
      timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS - 500);
      throw failure;
    };
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(h.events).toEqual(["list:1", "owned:1"]);
  });

  test.each(["lost", "expired"] as const)(
    "ownership fence after backoff stops retry when ownership is %s",
    async (state) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const failure = discoveryFailure();
      const lost = new ActionableError("ownership lost");
      const h = harness({
        timer,
        assertOwned: async (call) => {
          if (call === 2) {
            if (state === "lost") {
              throw lost;
            }
            timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS);
          }
        },
      });
      let attempts = 0;
      h.instrumentation.reserveBoot = async () => {
        attempts++;
        throw failure;
      };
      await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(
        state === "lost" ? lost : failure,
      );
      expect(attempts).toBe(1);
      expect(timer.getSleepHistory()).toEqual([1_000]);
      expect(h.events).toEqual(["list:1", "owned:1", "owned:2"]);
    },
  );

  test("reservation capacity exhaustion is not retried in process", async () => {
    const timer = new FakeTimer();
    const h = harness({ timer });
    const failure = capacityRefusal();
    let attempts = 0;
    h.instrumentation.reserveBoot = async () => {
      attempts++;
      throw failure;
    };
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(timer.getSleepHistory()).toEqual([]);
    expect(h.events).toEqual(["list:1", "owned:1"]);
  });

  test("incomplete discovery before boot defers an already erased Shutdown simulator", async () => {
    const h = harness({
      inventories: [
        [image()],
        [image("Shutdown")],
        [image("Shutdown")],
        [image("Shutdown")],
        [image()],
      ],
    });
    const failure = discoveryFailure();
    h.instrumentation.error = failure;
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(failure);
    h.instrumentation.error = undefined;
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).resolves.toBe("clean");
    expect(h.events.filter((event) => event.startsWith("stop:"))).toHaveLength(1);
    expect(h.events.filter((event) => event.startsWith("erase:"))).toHaveLength(2);
  });

  test("a deferred Shutdown reset survives exhausted reservation discovery retries", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const h = harness({
      timer,
      inventories: [
        [image()],
        [image("Shutdown")],
        [image("Shutdown")],
        [image("Shutdown")],
        [image("Shutdown")],
        [image()],
      ],
    });
    const failure = discoveryFailure();
    h.instrumentation.error = failure;
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(failure);
    h.instrumentation.error = undefined;
    h.instrumentation.reserveBoot = async ({ timeoutMs }) => {
      timer.advanceTime(timeoutMs);
      throw failure;
    };
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(failure);
    h.instrumentation.reserveBoot = undefined;
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).resolves.toBe("clean");
    expect(h.events.filter((event) => event.startsWith("stop:"))).toHaveLength(1);
    expect(h.events.filter((event) => event.startsWith("erase:"))).toHaveLength(2);
  });

  test.each(["abort", "ownership"] as const)(
    "a deferred Shutdown reset survives %s during reservation backoff",
    async (failureKind) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const controller = new AbortController();
      const interrupted = new ActionableError("reset interrupted during backoff");
      let ownershipLost = false;
      const h = harness({
        timer,
        inventories: [
          [image()],
          [image("Shutdown")],
          [image("Shutdown")],
          [image("Shutdown")],
          [image("Shutdown")],
          [image()],
        ],
        assertOwned: async () => {
          if (ownershipLost) {
            throw interrupted;
          }
        },
      });
      const refusal = capacityRefusal();
      h.instrumentation.error = refusal;
      await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(refusal);
      h.instrumentation.error = undefined;
      let attempts = 0;
      h.instrumentation.reserveBoot = async () => {
        attempts++;
        timer.setTimeout(() => {
          if (failureKind === "abort") {
            controller.abort(interrupted);
          } else {
            ownershipLost = true;
          }
        }, 500);
        throw discoveryFailure();
      };
      await expect(
        h.resetter.reset(DEVICE, PROFILE, h.assertOwned, controller.signal),
      ).rejects.toBe(interrupted);
      expect(controller.signal.aborted).toBe(failureKind === "abort");
      expect(attempts).toBe(1);
      expect(timer.getSleepHistory()).toEqual([1_000]);
      expect(h.events.filter((event) => event.startsWith("erase:"))).toHaveLength(1);
      ownershipLost = false;
      h.instrumentation.reserveBoot = undefined;
      await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).resolves.toBe("clean");
      expect(h.events.filter((event) => event.startsWith("stop:"))).toHaveLength(1);
      expect(h.events.filter((event) => event.startsWith("erase:"))).toHaveLength(2);
      expect(h.events.filter((event) => event.startsWith("boot:"))).toHaveLength(1);
    },
  );

  test("incomplete discovery from inside the boot callback does not defer reset", async () => {
    const failure = discoveryFailure();
    const h = harness({
      inventories: [[image()], [image("Shutdown")], [image("Shutdown")]],
      bootSimulator: async () => {
        throw failure;
      },
    });
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(failure);
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toThrow(
      "lacks authoritative Booted",
    );
  });

  test.each([undefined, "  ", " 27.0 "])(
    "normalizes raw os_version %j with the runtime fallback",
    async (os_version) => {
      const h = harness({
        inventories: [
          [image("Booted", { os_version })],
          [image("Shutdown", { os_version })],
          [image("Booted", { os_version })],
        ],
      });
      await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).resolves.toBe("clean");
    },
  );

  test("fresh-read failures stop before mutation and retain their cause", async () => {
    const failure = new Error("raw inventory unavailable");
    const h = harness({ readError: failure });
    const error = await h.resetter
      .reset(DEVICE, PROFILE, h.assertOwned)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error).toMatchObject({ cause: failure });
    expect(h.events).toEqual(["list:1"]);
  });

  test("returns measured stop, erase and boot durations with a fake clock", async () => {
    const timer = new FakeTimer();
    const h = harness({
      timer,
      stopDevice: async () => {
        timer.advanceTime(3);
      },
      eraseSimulator: async () => {
        timer.advanceTime(5);
      },
      bootSimulator: async () => {
        timer.advanceTime(7);
        return DEVICE;
      },
    });
    expect(await h.resetter.resetWithTiming(DEVICE, PROFILE, h.assertOwned)).toEqual({
      outcome: "clean",
      mode: "erase",
      phases: { stop: 3, erase: 5, boot: 7 },
    });
  });

  test("failed erase preserves completed and failed phase evidence", async () => {
    const timer = new FakeTimer();
    const failure = new ActionableError("erase failed");
    const h = harness({
      timer,
      stopDevice: async () => {
        timer.advanceTime(3);
      },
      eraseSimulator: async () => {
        timer.advanceTime(5);
        throw failure;
      },
    });
    await expect(h.resetter.resetWithTiming(DEVICE, PROFILE, h.assertOwned)).rejects.toMatchObject({
      cause: failure,
      reset: {
        mode: "erase",
        outcome: "pending",
        phases: { stop: 3, erase: 5 },
        fallbackReason: "erase failed",
      },
    });
  });
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
      {
        udid: UDID,
        runtime: RUNTIME,
        timeoutMs: DEFAULT_DEVICE_READY_TIMEOUT_MS,
        reason: "reset",
        signal: undefined,
      },
    ]);
    expect(h.listOptions).toEqual([[UDID], [UDID], [UDID]]);
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
        [image("Shutdown", { runtime: `${RUNTIME}-other` })],
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
    expect(gate.requests).toEqual([undefined]);
    expect(history.latestFor(UDID)).toMatchObject({ udid: UDID, durationMs: 42, reason: "reset" });
    expect(gate.admitted).toBe(0);
  });

  test("a deferred reset keeps its shutdown retry when reserving capacity is refused", async () => {
    const h = harness({
      inventories: [
        [image()],
        [image("Shutdown")],
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
    h.instrumentation.reserveBoot = async () => {
      throw refusal;
    };
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(refusal);
    h.instrumentation.reserveBoot = undefined;
    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).resolves.toBe("clean");
    expect(h.events.filter((event) => event.startsWith("stop:"))).toHaveLength(1);
  });

  test.each(["stop", "erase", "ownership", "abort", "boot"] as const)(
    "held reset slot is released after %s failure",
    async (failure) => {
      const timer = new FakeTimer();
      const history = new InMemoryBootDurationHistory();
      const gate = new FakeSimulatorCapacityGate(timer, {
        outcome: "allow",
        limits: { maxBooted: 1, source: "derived" },
        bootedCount: 0,
      });
      const controller = new AbortController();
      const h = harness({
        instrumentation: new FleetBootInstrumentation({ timer, history, gate }),
        assertOwned: async (call) => {
          if (failure === "ownership" && call === 2) {
            throw new ActionableError("ownership failed");
          }
        },
        stopDevice: async () => {
          expect(gate.admitted).toBe(1);
          if (failure === "abort") {
            controller.abort(new ActionableError("abort failed"));
          }
          if (failure === "stop") {
            throw new Error("stop failed");
          }
        },
        eraseSimulator: async () => {
          expect(gate.admitted).toBe(1);
          if (failure === "erase") {
            throw new Error("erase failed");
          }
        },
        bootSimulator: async () => {
          throw new Error("boot failed");
        },
      });
      await expect(
        h.resetter.reset(DEVICE, PROFILE, h.assertOwned, controller.signal),
      ).rejects.toThrow(`${failure} failed`);
      expect(gate.admitted).toBe(0);
      expect(history.latestFor(UDID)).toBeUndefined();
    },
  );

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
    ["partial type", [image("Booted", { deviceTypeIdentifier: undefined })]],
    ["transitional state", [image("Booting")]],
    ["shutdown without a deferred boot", [image("Shutdown")]],
    ["missing runtime", [image("Booted", { runtime: undefined })]],
    ["different runtime", [image("Booted", { runtime: `${RUNTIME}-other` })]],
    ["different type", [image("Booted", { deviceTypeIdentifier: `${DEVICE_TYPE}-other` })]],
    ["different OS", [image("Booted", { os_version: "28.0" })]],
    ["unavailable target", [image("Booted", { isAvailable: false })]],
  ] satisfies Array<[string, AppleDevice[]]>)(
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
    ["changed runtime", image("Booted", { runtime: `${RUNTIME}-other` })],
    ["changed type", image("Booted", { deviceTypeIdentifier: `${DEVICE_TYPE}-other` })],
    ["changed OS", image("Booted", { os_version: "28" })],
    ["unavailable target", image("Booted", { isAvailable: false })],
  ] satisfies Array<[string, AppleDevice]>)(
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
