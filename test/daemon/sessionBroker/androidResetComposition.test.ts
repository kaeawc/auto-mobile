import { mutationIncarnation } from "../../../src/daemon/sessionBroker/mutations/incarnation";
import { describe, expect, test } from "bun:test";
import {
  AndroidBaselineReset,
  type AndroidResetStrategy,
} from "../../../src/daemon/sessionBroker/androidBaselineReset";
import { AndroidKeepBootedReset } from "../../../src/daemon/sessionBroker/androidKeepBootedReset";
import { AndroidSnapshotReset } from "../../../src/daemon/sessionBroker/androidSnapshotReset";
import { drainFailureOutcome } from "../../../src/daemon/sessionBroker/brokerSupport";
import { DEVICE_MUTATION_KINDS } from "../../../src/daemon/sessionBroker/mutations/types";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import { FakeAndroidKeepBootedResetPort } from "../../fakes/FakeAndroidKeepBootedResetPort";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ResetFailureError } from "../../../src/daemon/sessionBroker/ResetFailureError";
import { drainUntil } from "../../helpers/fakeTimerStepping";
import { FakeAndroidSnapshotPort } from "./fixtures/androidSnapshotReset";
import {
  ANDROID_RESET_DEVICE,
  ANDROID_RESET_PROFILE,
  FakeAndroidResetHost,
} from "./fixtures/androidReset";

async function rig(fallback?: AndroidResetStrategy, resetTimeoutMs?: number) {
  const timer = new FakeTimer();
  const host = new FakeAndroidResetHost();
  host.timer = timer;
  host.resetTimeoutMs = resetTimeoutMs;
  const journal = new FakeDeviceMutationJournal(timer);
  const port = new FakeAndroidKeepBootedResetPort({
    completeKinds: [...DEVICE_MUTATION_KINDS],
    observations: [],
    unobservable: [],
  });
  const snapshotPort = new FakeAndroidSnapshotPort();
  const snapshot = new AndroidSnapshotReset(snapshotPort, timer, {
    prepareForIncarnationChange: async () => {},
    invalidate: async () => {},
    settleIncarnationChange: async () => {},
  });
  host.strategy = new AndroidKeepBootedReset({
    journal,
    port: () => port,
    timer,
    fallback: fallback ?? snapshot,
    fallbackBudgetMs: resetTimeoutMs,
  });
  const baseline = new AndroidBaselineReset(host);
  let owned = true;
  const assertOwned = async () => {
    if (!owned) {
      throw new Error("binding ownership lost");
    }
  };
  const capture = (sessionId: string, fresh = false) =>
    baseline.capture("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, {
      sessionId,
      stableDeviceId: "stable-avd",
      timer,
      timeoutMs: 60_000,
      assertOwned,
      fresh,
    });
  const reset = () =>
    baseline.reset("resource-a", ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, { assertOwned });
  const scope = () => ({
    deviceId: ANDROID_RESET_DEVICE.deviceId,
    sessionUuid: "session-a",
    incarnation: mutationIncarnation({
      platform: "android",
      resourceId: "resource-a",
      stableDeviceId: "stable-avd",
      bootId: host.bootId,
    }),
  });
  await capture("session-a", true);
  port.beforeClean = async () => {
    throw new Error("hard cleaning failure");
  };
  return {
    timer,
    host,
    journal,
    port,
    snapshotPort,
    capture,
    reset,
    scope,
    loseOwnership: () => {
      owned = false;
    },
  };
}

describe("composed Android reset strategies", () => {
  test("an injected fake snapshot reset must prove clean before incarnation rebinding", async () => {
    let resets = 0;
    const fallback: AndroidResetStrategy = {
      fullBaseline: true,
      reset: async (_device, _packages, assertOwned, context) => {
        await assertOwned();
        expect(context.assertOwned).toBe(assertOwned);
        expect(context.signal?.aborted).toBe(false);
        expect(context.timeoutMs).toBeGreaterThan(0);
        resets++;
        return { outcome: "pending", mode: "snapshot", phases: {} };
      },
    };
    const { port, reset } = await rig(fallback);
    await expect(reset()).rejects.toThrow("did not prove a clean reset");
    expect(resets).toBe(1);
    expect(port.captureCount).toBe(1);
  });
  test.each([false, true])(
    "snapshot fallback rebinds boot identity and permits subsequent reuse (wipe=%s)",
    async (wipe) => {
      const { host, journal, port, snapshotPort, capture, reset, scope } = await rig();
      const previousScope = scope();
      await journal.record(previousScope, {
        kind: "device-setting",
        key: "global:window_animation_scale",
        priorValue: { state: "absent" },
        toolName: "test",
      });
      if (wipe) {
        snapshotPort.failures.add("load");
      }
      snapshotPort.onStep = async (action) => {
        if (action === (wipe ? "launch" : "load")) {
          host.bootId = "87654321-1234-1234-1234-123456789abc";
        }
      };
      await expect(reset()).resolves.toMatchObject({
        outcome: wipe ? "fallback:wipe-data" : "fallback:snapshot",
        mode: wipe ? "wipe-data" : "snapshot",
        fallbackReason: wipe ? "hard cleaning failure; load failed" : "hard cleaning failure",
        phases: { journal: 0, clean: 0, fallback: 0, "snapshot:load": 0 },
      });
      expect(port.captureCount).toBe(2);
      expect(await journal.getBaseline(previousScope)).toBeNull();
      expect(await journal.list(previousScope)).toEqual([]);
      expect(await journal.getBaseline(scope())).not.toBeNull();
      expect(snapshotPort.calls).toContain(wipe ? "launch" : "load");
      port.beforeClean = null;
      await capture("session-b");
      await expect(reset()).resolves.toMatchObject({ outcome: "clean", mode: "keep-booted" });
      expect(port.captureCount).toBe(2);
      expect(snapshotPort.calls.filter((action) => action === "save")).toHaveLength(wipe ? 2 : 1);
    },
  );

  test("failed snapshot and wipe-data fallback cannot report clean", async () => {
    const { snapshotPort, port, reset } = await rig();
    snapshotPort.failures.add("load");
    snapshotPort.failures.add("launch");
    const error = await reset().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ResetFailureError);
    expect(error).toMatchObject({
      reset: {
        outcome: "pending",
        mode: "wipe-data",
        fallbackReason: "hard cleaning failure; load failed",
        phases: {
          journal: 0,
          clean: 0,
          fallback: 0,
          "snapshot:load": 0,
          "snapshot:wipe-data launch": 0,
        },
      },
    });
    expect((error as ResetFailureError).message).toContain("destroy required");
    expect((error as ResetFailureError).reset.phases).not.toHaveProperty("load");
    expect(port.captureCount).toBe(1);
    expect(snapshotPort.calls).toContain("launch");
  });

  test("boot-capacity refusal in snapshot fallback remains pending through composition", async () => {
    const { snapshotPort, reset } = await rig();
    const capacityError = new BootCapacityExhaustedError(
      { platform: "android", retryAfterMs: 1000, limit: 1, booted: 1 },
      "Android boot capacity exhausted",
    );
    snapshotPort.failures.add("load");
    snapshotPort.capacity = {
      reserveBoot: async () => {
        throw capacityError;
      },
    };

    const error = await reset().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ResetFailureError);
    expect((error as ResetFailureError).cause).toBe(capacityError);
    expect(drainFailureOutcome((error as ResetFailureError).cause, "session-a", false)).toBe(
      "pending",
    );
  });

  test("fallback deadline and drain expire before the overall deadline after cleaning consumes time", async () => {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let fallbackSignal: AbortSignal | undefined;
    let fallbackBudget: number | undefined;
    const { timer, host, port, reset } = await rig(
      {
        reset: async (_device, _packages, _fence, context) => {
          fallbackSignal = context.signal;
          fallbackBudget = context.timeoutMs;
          expect(context.deadlineMs).toBe(7999);
          reached.resolve();
          await release.promise;
        },
      },
      10_000,
    );
    port.beforeClean = async () => {
      timer.advanceTime(20);
      throw new Error("hard cleaning failure");
    };
    const result = reset().catch((error: unknown) => error);
    await reached.promise;
    expect(fallbackBudget).toBe(7979);
    timer.advanceTime(7979);
    expect(fallbackSignal?.aborted).toBe(true);
    await drainUntil(() => timer.getPendingTimeoutCount() === 2, {
      description: "fallback drain started",
    });
    expect(host.lastInventorySignal?.aborted).toBe(false);
    timer.advanceTime(2000);
    const error = await result;
    expect(timer.now()).toBe(9999);
    expect(error).toBeInstanceOf(ResetFailureError);
    expect((error as ResetFailureError).message).toContain("command settlement");
    release.resolve();
  });

  test("ownership loss during restore never rebinds or captures a new baseline", async () => {
    const { snapshotPort, port, reset, loseOwnership } = await rig();
    snapshotPort.onStep = async (action) => {
      if (action === "load") {
        loseOwnership();
      }
    };
    await expect(reset()).rejects.toThrow("ownership lost");
    expect(port.captureCount).toBe(1);
    expect(snapshotPort.calls).not.toContain("launch");
  });

  test("insufficient time for fallback settlement fails without starting snapshot restore", async () => {
    const { snapshotPort, reset } = await rig(undefined, 2001);
    const error = await reset().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ResetFailureError);
    expect(error).toMatchObject({
      reset: {
        outcome: "pending",
        mode: "keep-booted",
        fallbackReason: "hard cleaning failure",
        phases: { journal: 0, clean: 0 },
      },
    });
    expect((error as ResetFailureError).message).toContain("remaining fallback settlement budget");
    expect(snapshotPort.calls).not.toContain("load");
    expect(snapshotPort.calls).not.toContain("launch");
  });

  test("failed journal recapture after restore requires destruction", async () => {
    const { host, snapshotPort, port, reset } = await rig();
    snapshotPort.onStep = async (action) => {
      if (action === "load") {
        host.bootId = "87654321-1234-1234-1234-123456789abc";
      }
    };
    port.capture = async () => {
      throw new Error("journal recapture failed");
    };
    await expect(reset()).rejects.toThrow("journal recapture failed");
  });
});
