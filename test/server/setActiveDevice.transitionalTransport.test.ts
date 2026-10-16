import { RunnerReadinessError } from "../../src/ctrlProxy/RunnerReadinessService";
import { afterEach, expect, test } from "bun:test";
import {
  createSetActiveDeviceHandler,
  type LegacyDeviceSelection,
} from "../../src/server/setActiveDevice";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  DeviceTransportOfflineError,
  DeviceShuttingDownError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import {
  deviceAssignedToOtherSessionError,
  devicePreparedForOtherRequestError,
} from "../../src/daemon/inputDeviceOwnership";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import { DisplayPinNeedsSessionError } from "../../src/models/PinnedDisplayError";
import { ActionableError } from "../../src/models/ActionableError";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Pixel" };
let sessions: SessionManager | undefined;
afterEach(() => {
  sessions?.stopCleanupTimer();
  sessions = undefined;
  DaemonState.getInstance().reset();
  expect(DaemonState.getInstance().isInitialized()).toBe(false);
});

function arrange(
  states: (string | undefined)[],
  failures: number,
  error = new ActionableError("not found"),
  onAttempt?: () => void,
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const calls: string[] = [];
  let probes = 0;
  let attempts = 0;
  const legacy: LegacyDeviceSelection = {
    getCurrentDevice: () => undefined,
    getCurrentPlatform: () => undefined,
    ensureDeviceReady: async () => {
      calls.push("ready");
      onAttempt?.();
      if (++attempts <= failures) {
        throw error;
      }
      return device;
    },
    setExplicitDevicePin: () => {
      calls.push("pin");
    },
  };
  const select = createSetActiveDeviceHandler({
    legacyDeviceSelection: () => legacy,
    resumeCtrlProxy: async () => {
      calls.push("resume");
    },
    transportWait: {
      timer,
      invalidateDeviceList: () => {
        calls.push("invalidate");
      },
      probe: async () => {
        const state = states[Math.min(probes++, states.length - 1)];
        return state === undefined ? new Map() : new Map([[device.deviceId, state]]);
      },
    },
  });
  return { timer, calls, select, probes: () => probes };
}

test("legacy readiness verification retries offline and succeeds through absence", async () => {
  const h = arrange(
    ["offline", undefined],
    1,
    new ActionableError(
      "Failed to verify Android device emulator-5554 readiness: Cannot get active window information from Android device emulator-5554. The device may not be fully booted or is in an unusual state.",
    ),
  );
  await h.select({ deviceId: device.deviceId });
  expect(h.calls).toEqual(["ready", "invalidate", "ready", "resume", "pin"]);
  expect(h.probes()).toBe(1);
});

test("legacy not-found retries offline then not listed then ready", async () => {
  const h = arrange(["offline", undefined, "device"], 2);
  await h.select({ deviceId: device.deviceId });
  expect(h.calls).toEqual(["ready", "invalidate", "ready", "invalidate", "ready", "resume", "pin"]);
  expect(h.timer.now()).toBe(300);
});

for (const deadlineExhausted of [true, false]) {
  test(`runner readiness error retries offline then device: deadlineExhausted=${deadlineExhausted}`, async () => {
    const original = new RunnerReadinessError(
      "runner deadline",
      false,
      deadlineExhausted,
      "runner-connect",
    );
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let state = "offline";
    let attempts = 0;
    const probedStates: string[] = [];
    const legacy: LegacyDeviceSelection = {
      getCurrentDevice: () => undefined,
      getCurrentPlatform: () => undefined,
      ensureDeviceReady: async () => {
        attempts++;
        if (state === "offline") {
          throw original;
        }
        expect(state).toBe("device");
        return device;
      },
      setExplicitDevicePin: () => {},
    };
    const select = createSetActiveDeviceHandler({
      legacyDeviceSelection: () => legacy,
      resumeCtrlProxy: async () => {},
      transportWait: {
        timer,
        invalidateDeviceList: () => {
          state = "device";
        },
        probe: async () => {
          probedStates.push(state);
          return new Map([[device.deviceId, state]]);
        },
      },
    });
    await select({ deviceId: device.deviceId });
    expect(attempts).toBe(2);
    expect(probedStates).toEqual(["offline"]);
    expect(timer.now()).toBe(100);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
}

test("runner readiness deadline finally propagates with the typed timeout wire shape", async () => {
  const original = new RunnerReadinessError("runner deadline", false, true, "runner-connect");
  const h = arrange(["offline", "device"], 2, original);
  const error = await h.select({ deviceId: device.deviceId }).catch((caught: unknown) => caught);
  expect(error).toBe(original);
  expect(h.probes()).toBe(2);
  expect(h.timer.now()).toBe(100);
  expect(
    JSON.parse(
      shapeToolCallError(error, { toolName: "setActiveDevice", source: "MCP" }).content[0].text,
    ),
  ).toMatchObject({ code: "timeout", retryable: true });
});

test("fresh readiness retries recover offline then absent then ready at 700ms", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const order: string[] = [];
  const currentState = () =>
    timer.now() < 300 ? "offline" : timer.now() < 700 ? undefined : "device";
  let cached: { state: string | undefined; expires: number } | undefined;
  const legacy: LegacyDeviceSelection = {
    getCurrentDevice: () => undefined,
    getCurrentPlatform: () => undefined,
    ensureDeviceReady: async () => {
      order.push(`attempt:${timer.now()}`);
      if (!cached || timer.now() >= cached.expires) {
        cached = { state: currentState(), expires: timer.now() + 5000 };
      }
      if (cached.state !== "device") {
        throw new ActionableError("not found");
      }
      return device;
    },
    setExplicitDevicePin: () => {
      order.push("pin");
    },
  };
  const select = createSetActiveDeviceHandler({
    legacyDeviceSelection: () => legacy,
    resumeCtrlProxy: async () => {
      order.push("resume");
    },
    transportWait: {
      timer,
      invalidateDeviceList: () => {
        order.push(`invalidate:${timer.now()}`);
        cached = undefined;
      },
      probe: async () => {
        const state = currentState();
        return state === undefined ? new Map() : new Map([[device.deviceId, state]]);
      },
    },
  });
  await select({ deviceId: device.deviceId });
  expect(order).toEqual([
    "attempt:0",
    "invalidate:100",
    "attempt:100",
    "invalidate:300",
    "attempt:300",
    "invalidate:700",
    "attempt:700",
    "resume",
    "pin",
  ]);
  expect(timer.now()).toBe(700);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("legacy persistent offline returns the typed wire refusal within five seconds", async () => {
  const h = arrange(["offline"], Infinity);
  const error = await h.select({ deviceId: device.deviceId }).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(DeviceTransportOfflineError);
  expect(
    JSON.parse(
      shapeToolCallError(error, { toolName: "setActiveDevice", source: "MCP" }).content[0].text,
    ),
  ).toMatchObject({ code: "device_offline", retryable: true });
  expect(h.timer.now()).toBe(5000);
  expect(h.calls).not.toContain("pin");
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test("ordinary absence keeps the original failure without waiting", async () => {
  const original = new ActionableError("ordinary failure");
  const h = arrange([undefined], Infinity, original);
  await expect(h.select({ deviceId: device.deviceId })).rejects.toBe(original);
  expect(h.calls).toEqual(["ready"]);
  expect(h.timer.now()).toBe(0);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

for (const original of [
  deviceAssignedToOtherSessionError(device.deviceId, "holder", "other"),
  devicePreparedForOtherRequestError(device.deviceId),
  new DeviceShuttingDownError(device.deviceId),
  new BootedDeviceDiscoveryIncompleteError("android", undefined),
  new DisplayPinNeedsSessionError(),
]) {
  test(`typed refusal ${original.message} is preserved without probing`, async () => {
    const h = arrange(["offline"], Infinity, original);
    await expect(h.select({ deviceId: device.deviceId })).rejects.toBe(original);
    expect(h.probes()).toBe(0);
    expect(h.calls).toEqual(["ready"]);
    expect(h.timer.now()).toBe(0);
  });
}

test("an aborted selection preserves main's actionable attempt error without probing or waiting", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled selection", "AbortError");
  // Main calls readiness even when already aborted and preserves its actionable error.
  const original = new ActionableError("readiness failed during cancellation");
  const h = arrange(["offline"], Infinity, original);
  controller.abort(reason);
  await expect(h.select({ deviceId: device.deviceId }, undefined, controller.signal)).rejects.toBe(
    original,
  );
  expect(h.probes()).toBe(0);
  expect(h.calls).toEqual(["ready"]);
  expect(h.timer.now()).toBe(0);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test("an attempt error racing cancellation keeps main's wrapper and cause", async () => {
  const controller = new AbortController();
  const original = new Error("readiness failed");
  const h = arrange(["offline"], Infinity, original, () => controller.abort("cancelled"));
  const error = await h
    .select({ deviceId: device.deviceId }, undefined, controller.signal)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ActionableError);
  expect(error).toMatchObject({
    message: "Failed to set active device: readiness failed",
    cause: original,
  });
  expect(h.probes()).toBe(0);
  expect(h.calls).toEqual(["ready"]);
  expect(h.timer.now()).toBe(0);
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

for (const args of [
  { deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE" },
  { deviceId: "phone", platform: "ios" as const },
]) {
  test(`iOS selection ${args.deviceId} never probes adb`, async () => {
    const original = new ActionableError("iOS failure");
    const h = arrange(["offline"], Infinity, original);
    await expect(h.select(args)).rejects.toBe(original);
    expect(h.probes()).toBe(0);
  });
}

async function arrangePool(returns: boolean) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const utils = new FakeDeviceUtils();
  sessions = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  sessions.stopCleanupTimer();
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "transitional-selection", {
      timer,
      deviceManager: utils,
    }),
  );
  await pool.initializeWithDevices([]);
  DaemonState.getInstance().initialize(sessions, pool);
  let probes = 0;
  const select = createSetActiveDeviceHandler({
    resumeCtrlProxy: async () => {},
    transportWait: {
      timer,
      invalidateDeviceList: () => {},
      probe: async () => {
        probes++;
        if (returns) {
          utils.setBootedDevices("android", [device]);
        }
        return new Map([[device.deviceId, "offline"]]);
      },
    },
  });
  return {
    timer,
    pool,
    probes: () => probes,
    select: () => select({ deviceId: device.deviceId, sessionUuid: "selector" }),
  };
}

test("session selection refreshes after offline absence and binds the returned device", async () => {
  const h = await arrangePool(true);
  await h.select();
  expect(h.pool.getDevice(device.deviceId)?.sessionId).toBe("selector");
  expect(h.probes()).toBe(1);
});

test("session selection missing for the offline budget returns device_offline", async () => {
  const h = await arrangePool(false);
  await expect(h.select()).rejects.toMatchObject({ code: "device_offline", retryable: true });
  expect(h.timer.now()).toBe(5000);
  expect(sessions?.getSession("selector")).toBeNull();
});
