import { describe, expect, test } from "bun:test";
import { ForcedRestartBudget } from "../../../../src/ctrlProxy/ForcedRestartBudget";
import {
  AndroidServiceRecovery,
  type AndroidServiceRecoveryContext,
  type AndroidServiceRecoveryManager,
} from "../../../../src/features/observe/android/AndroidServiceRecovery";
import { FakeTimer } from "../../../fakes/FakeTimer";

function harness(options: { state?: string; healthy?: boolean } = {}) {
  const timer = new FakeTimer();
  const budget = new ForcedRestartBudget(timer);
  let healthy = options.healthy ?? true;
  const manager: AndroidServiceRecoveryManager = {
    isAccessibilityServiceHealthy: async () => healthy,
    setup: async () => {
      healthy = true;
      return { success: true, message: "ok" };
    },
  };
  const state = {
    isRecoveringService: false,
    recoveryPromise: null as Promise<boolean> | null,
    consecutiveConnectionFailures: 3,
    connected: false,
    budgetResets: 0,
  };
  const context: AndroidServiceRecoveryContext = {
    adb: {
      getDeviceStates: async () => [{ deviceId: "emu", state: options.state ?? "device" }],
    },
    timer,
    deviceId: "emu",
    device: { deviceId: "emu", name: "Pixel", platform: "android" },
    closed: false,
    connectionGeneration: 1,
    forcedRestartBudget: budget,
    serviceManagerFactory: () => manager,
    restartRearmPending: false,
    socket: null,
    get consecutiveConnectionFailures() {
      return state.consecutiveConnectionFailures;
    },
    set consecutiveConnectionFailures(value: number) {
      state.consecutiveConnectionFailures = value;
    },
    get isRecoveringService() {
      return state.isRecoveringService;
    },
    set isRecoveringService(value: boolean) {
      state.isRecoveringService = value;
    },
    get recoveryPromise() {
      return state.recoveryPromise;
    },
    set recoveryPromise(value: Promise<boolean> | null) {
      state.recoveryPromise = value;
    },
    isConnected: () => state.connected,
    resetConnectionBudget: () => {
      state.budgetResets++;
    },
    connectBackgroundWebSocket: async () => false,
  };
  return { recovery: new AndroidServiceRecovery(context), budget, state, timer };
}

describe("AndroidServiceRecovery", () => {
  test("an absent device gives its attempt back instead of burning a restart slot", async () => {
    const { recovery, budget, state } = harness({ state: "offline" });
    recovery.trigger();
    expect(state.isRecoveringService).toBe(true);
    expect(await state.recoveryPromise).toBe(false);
    expect(state.isRecoveringService).toBe(false);
    expect(budget.snapshot()).toMatchObject({ state: "idle", attempts: 0 });
  });

  test("rearms the budget on device-online only after recovery saw the device absent", async () => {
    const { recovery, budget, state } = harness({ state: "offline" });
    const early = budget.tryBeginAttempt()!;
    budget.recordFailure("x", early);
    recovery.rearmAfterDeviceOnline();
    expect(budget.snapshot().attempts).toBe(1);
    budget.rearm("reset");
    recovery.trigger();
    await state.recoveryPromise;
    const token = budget.tryBeginAttempt()!;
    budget.recordFailure("y", token);
    expect(budget.snapshot().attempts).toBe(1);
    recovery.rearmAfterDeviceOnline();
    expect(budget.snapshot().attempts).toBe(0);
  });

  test("a failed reconnect after a repaired service records a failure and resets the cooldown", async () => {
    const { recovery, budget, state, timer } = harness({ healthy: false });
    timer.enableAutoAdvance();
    recovery.trigger();
    expect(await state.recoveryPromise).toBe(false);
    expect(state.budgetResets).toBe(1);
    expect(budget.snapshot().attempts).toBe(1);
  });

  test("ensureStarted honours auto-reconnect and an existing recovery", async () => {
    const { recovery, state } = harness({ state: "offline" });
    recovery.ensureStarted(false);
    expect(state.recoveryPromise).toBeNull();
    recovery.ensureStarted(true);
    const first = state.recoveryPromise;
    expect(first).not.toBeNull();
    recovery.ensureStarted(true);
    expect(state.recoveryPromise).toBe(first);
    await first;
  });
});
