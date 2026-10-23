import { legacyAppContainerFileKey } from "../../../src/daemon/sessionBroker/mutations/appContainerFileKey";
import { iosAppContainerWriteCovered } from "../../../src/daemon/sessionBroker/mutations/iosResetPort";
import { deviceToolMutations } from "../../../src/server/deviceMutationAdapters";
import { InMemoryMutationRecordingGaps } from "../../../src/daemon/sessionBroker/mutations/recordingGaps";
import { describe, expect, test } from "bun:test";
import {
  IosKeepBootedReset,
  type IosKeepBootedMutationPort,
  type IosResetHealthPort,
  type IosKeepBootedResetDependencies,
} from "../../../src/daemon/sessionBroker/iosKeepBootedReset";
import { ResetFailureError } from "../../../src/daemon/sessionBroker/ResetFailureError";
import { drainFailureOutcome } from "../../../src/daemon/sessionBroker/brokerSupport";
import { ActionableError } from "../../../src/models/ActionableError";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import type { AppleDevice } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  DEVICE_MUTATION_KINDS,
  opaqueIntentKey,
  type DeviceBaseline,
  type DeviceMutationInput,
} from "../../../src/daemon/sessionBroker/mutations/types";
import type { DeviceMutationResetContext } from "../../../src/daemon/sessionBroker/mutations/reset";
import type { IosResetProfile } from "../../../src/daemon/sessionBroker/iosResetTarget";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { FakeDeviceMutationResetPort } from "../../fakes/FakeDeviceMutationResetPort";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { ResetBootRunner } from "../../../src/daemon/sessionBroker/devicePort";
import { drainUntilQuiescent } from "../../helpers/fakeTimerStepping";

const PROFILE: IosResetProfile = {
  platform: "ios",
  metadataState: "current",
  simulatorDeviceTypeIdentifier: "iphone",
  archetype: "phone",
  modelType: { family: "iphone", variant: "pro" },
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
  osVersion: "27",
  compatibility: "supported",
};
const DEVICE = { deviceId: "UDID", platform: "ios", name: "phone" } as const;
const SCOPE = { deviceId: DEVICE.deviceId, incarnation: "generation-1", sessionUuid: "session-a" };

class FakeFastMutations extends FakeDeviceMutationResetPort implements IosKeepBootedMutationPort {
  sanitizeCovers(
    entry: DeviceMutationInput,
    context?: Pick<DeviceMutationResetContext, "baseline">,
  ): boolean {
    if (entry.kind === "shared-file") {
      return iosAppContainerWriteCovered(entry, context);
    }
    return (
      ["clipboard", "keychain", "permission", "certificate", "media"].includes(entry.kind) ||
      (entry.kind === "device-setting" && entry.key === "appearance")
    );
  }
  sanitizeCount = 0;
  sanitizeError?: Error;
  sanitizedBaseline?: DeviceBaseline;
  async assertSettled(context: DeviceMutationResetContext): Promise<void> {
    await context.assertOwned();
  }
  async sanitize(context: DeviceMutationResetContext): Promise<void> {
    await context.assertOwned();
    this.sanitizeCount++;
    this.sanitizedBaseline = context.baseline;
    if (this.sanitizeError) {
      throw this.sanitizeError;
    }
  }
}

async function harness(
  observations: DeviceBaseline["observations"] = [],
  missingBaseline = false,
  budgets: Pick<
    IosKeepBootedResetDependencies,
    "hostLoad" | "budgetCeilingMs" | "recordingGaps"
  > = {},
) {
  const timer = new FakeTimer();
  const baseline: DeviceBaseline = {
    completeKinds: ["installed-app", "device-setting"],
    observations,
    unobservable: DEVICE_MUTATION_KINDS.filter(
      (kind) => !["installed-app", "device-setting"].includes(kind),
    ),
  };
  const journal = new FakeDeviceMutationJournal(timer);
  if (!missingBaseline) {
    await journal.captureBaseline(SCOPE, baseline);
  }
  const mutations = new FakeFastMutations(structuredClone(baseline));
  const state = {
    owned: true,
    healthy: true,
    eraseCalls: 0,
    healthCalls: 0,
    eraseError: undefined as Error | undefined,
    targetError: undefined as Error | undefined,
    target: {
      udid: DEVICE.deviceId,
      name: DEVICE.name,
      state: "Booted",
      isAvailable: true,
      deviceTypeIdentifier: PROFILE.simulatorDeviceTypeIdentifier,
      runtime: PROFILE.runtimeId,
      os_version: "27.0",
    } as AppleDevice,
  };
  const owned = async () => {
    if (!state.owned) {
      throw new ActionableError("Ownership lost");
    }
  };
  const health: IosResetHealthPort = {
    probe: async () => {
      state.healthCalls++;
      return state.healthy;
    },
  };
  const reset = new IosKeepBootedReset({
    timer,
    journal,
    mutations,
    maxUses: 3,
    budgetMs: 50,
    ...budgets,
    simctl: {
      readSimulatorTarget: async () => {
        await owned();
        if (state.targetError) {
          throw state.targetError;
        }
        return state.target;
      },
    },
    health,
    erase: {
      resetWithTiming: async (_device, _profile, assertOwned) => {
        await assertOwned();
        state.eraseCalls++;
        if (state.eraseError) {
          throw state.eraseError;
        }
        timer.advanceTime(7);
        return { outcome: "clean", mode: "erase", phases: { stop: 2, erase: 1, boot: 4 } };
      },
    },
  });
  return {
    state,
    journal,
    mutations,
    timer,
    health,
    run: (count = 0, signal?: AbortSignal, runResetBoot?: ResetBootRunner) =>
      reset.resetWithTiming(DEVICE, PROFILE, owned, SCOPE, count, { signal, runResetBoot }),
  };
}

async function recordClipboard(rig: Awaited<ReturnType<typeof harness>>) {
  await rig.journal.record(SCOPE, {
    kind: "clipboard",
    key: "device",
    priorValue: { state: "absent" },
    toolName: "clipboard",
  });
}

describe("iOS keep-booted best-effort cleaning", () => {
  test("legacy incarnation rows require erase before reverts or sanitation", async () => {
    const rig = await harness();
    await rig.journal.record(
      { ...SCOPE, incarnation: JSON.stringify(["resource", 3]) },
      {
        kind: "clipboard",
        key: "device",
        toolName: "clipboard",
        priorValue: { state: "absent" },
      },
    );
    expect(await rig.run()).toMatchObject({
      outcome: "fallback:erase",
      fallbackReason:
        "iOS journaled mutations recorded under a different incarnation (1) cannot be journal-reverted; erase required",
    });
    expect(rig.state.eraseCalls).toBe(1);
    expect(rig.mutations.reverted).toEqual([]);
    expect(rig.mutations.sanitizeCount).toBe(0);
  });

  test("partial native coverage stays booted, sanitizes and probes without baseline readback", async () => {
    const rig = await harness();
    await recordClipboard(rig);
    rig.mutations.ignoreWrites = true;
    expect(await rig.run()).toMatchObject({
      outcome: "clean",
      mode: "keep-booted",
      phases: { inventory: 0, journal: 0, "revert:clipboard:device": 0, sanitize: 0, health: 0 },
    });
    expect(rig.state.eraseCalls).toBe(0);
    expect(rig.state.healthCalls).toBe(1);
    expect(rig.mutations.captureCount).toBe(0);
    expect(rig.mutations.sanitizeCount).toBe(1);
    expect(await rig.journal.list(SCOPE)).toEqual([]);
  });

  test("baseline settings reach sanitation even with unjournaled drift", async () => {
    const rig = await harness([
      { kind: "device-setting", key: "appearance", value: { state: "present", value: "light" } },
    ]);
    rig.mutations.snapshot.observations[0].value = { state: "present", value: "dark" };
    expect(await rig.run()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(rig.mutations.sanitizedBaseline?.observations[0].value).toEqual({
      state: "present",
      value: "light",
    });
    expect(rig.mutations.captureCount).toBe(0);
    expect(rig.state.eraseCalls).toBe(0);
  });

  test.each(["missing", "unobservable"])(
    "%s app baseline erases before journal reverts or sanitation",
    async (state) => {
      const rig = await harness([], true);
      if (state === "unobservable") {
        await rig.journal.captureBaseline(SCOPE, {
          completeKinds: [],
          observations: [],
          unobservable: [...DEVICE_MUTATION_KINDS],
        });
      }
      await recordClipboard(rig);
      expect(await rig.run()).toMatchObject({
        outcome: "fallback:erase",
        fallbackReason: expect.stringContaining("captured app baseline"),
      });
      expect(rig.mutations.reverted).toEqual([]);
      expect(rig.mutations.sanitizeCount).toBe(0);
      expect(rig.state.eraseCalls).toBe(1);
    },
  );

  test("covered unplannable reverts are skipped while supported entries replay newest first", async () => {
    const rig = await harness();
    rig.mutations.unsupportedKinds.add("media");
    rig.mutations.unsupportedKinds.add("keychain");
    for (const [kind, key] of [
      ["clipboard", "device"],
      ["media", "photo"],
      ["keychain", "device"],
      ["preference", "app:key"],
    ]) {
      await rig.journal.record(SCOPE, {
        kind,
        key,
        priorValue: { state: "absent" },
        toolName: "test",
      });
    }
    expect(await rig.run()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(rig.mutations.reverted.map((entry) => entry.kind)).toEqual(["preference", "clipboard"]);
    expect(rig.mutations.sanitizeCount).toBe(1);
    expect(rig.state.eraseCalls).toBe(0);
  });

  test("a fallback-forcing opaque journal row erases instead of reporting a clean keep-booted reset", async () => {
    const rig = await harness();
    await rig.journal.record(SCOPE, {
      kind: "opaque",
      key: opaqueIntentKey("sendBroadcast", "com.example.app"),
      priorValue: { state: "unobservable" },
      toolName: "sendBroadcast",
    });
    const result = await rig.run();
    expect(result).toMatchObject({ outcome: "fallback:erase", mode: "erase" });
    expect(result.fallbackReason).toContain("sendBroadcast");
    expect(rig.mutations.sanitizeCount).toBe(0);
    expect(rig.state.eraseCalls).toBe(1);
  });

  test("a best-effort opaque journal row keeps the booted reset", async () => {
    const rig = await harness();
    await rig.journal.record(SCOPE, {
      kind: "opaque",
      key: "tool:sendSms",
      priorValue: { state: "unobservable" },
      toolName: "sendSms",
    });
    expect(await rig.run()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(rig.state.eraseCalls).toBe(0);
  });

  test("app journal entries defer to baseline-aware inventory cleaning, avoiding duplicate uninstalls", async () => {
    const rig = await harness();
    for (const kind of ["installed-app", "app-group"]) {
      await rig.journal.record(SCOPE, {
        kind,
        key: "probe.app",
        priorValue: { state: "absent" },
        toolName: "test",
      });
    }
    expect(await rig.run()).toMatchObject({ outcome: "clean" });
    expect(rig.mutations.reverted).toEqual([]);
    expect(rig.mutations.sanitizeCount).toBe(1);
  });

  test.each(["inventory", "revert", "sanitize"] as const)(
    "settled %s timeouts erase on the first attempt",
    async (phase) => {
      const rig = await harness();
      const timeout = new DOMException("command timed out", "TimeoutError");
      if (phase === "inventory") {
        rig.state.targetError = timeout;
      } else if (phase === "revert") {
        await recordClipboard(rig);
        rig.mutations.revert = async () => {
          throw timeout;
        };
      } else {
        rig.mutations.sanitizeError = timeout;
      }
      expect(await rig.run()).toMatchObject({
        outcome: "fallback:erase",
        fallbackReason: expect.stringContaining("timed out"),
      });
      expect(rig.state.eraseCalls).toBe(1);
    },
  );

  test.each(["revert", "sanitize"] as const)(
    "%s timeout fences late writes, then redrives directly to erase",
    async (phase) => {
      const rig = await harness();
      if (phase === "revert") {
        await recordClipboard(rig);
      }
      const finishStep = Promise.withResolvers<void>();
      let writes = 0;
      const delayedStep = async (context: DeviceMutationResetContext) => {
        await finishStep.promise;
        await context.assertOwned();
        writes++;
      };
      if (phase === "revert") {
        rig.mutations.revert = async (_mutation, context) => delayedStep(context);
      } else {
        rig.mutations.sanitize = delayedStep;
      }
      const failure = rig.run().then(
        () => undefined,
        (error: unknown) => error,
      );
      await drainUntilQuiescent(rig.timer);
      rig.timer.advanceTime(50);
      await drainUntilQuiescent(rig.timer);
      // The abandoned step never settles, so the single retry is not attempted.
      rig.timer.advanceTime(100);
      expect(await failure).toBeInstanceOf(ResetFailureError);
      expect(rig.state.eraseCalls).toBe(0);
      await expect(rig.run(2)).rejects.toThrow("unsettled native step");
      finishStep.resolve();
      await drainUntilQuiescent(rig.timer);
      expect(writes).toBe(0);
      expect(await rig.run()).toMatchObject({
        outcome: "fallback:erase",
        fallbackReason: expect.stringMatching(/^budget-driven: /),
      });
      expect(rig.state.eraseCalls).toBe(1);
    },
  );

  test("journal storage failures do not masquerade as cleaning failures or invoke erase", async () => {
    const rig = await harness();
    rig.journal.list = async () => {
      throw new DOMException("storage unavailable", "TimeoutError");
    };
    await expect(rig.run()).rejects.toBeInstanceOf(ResetFailureError);
    expect(rig.mutations.sanitizeCount).toBe(0);
    expect(rig.state.eraseCalls).toBe(0);
  });

  test.each(["list", "getBaseline"] as const)(
    "real journal %s deadline stays pending until the read settles",
    async (method) => {
      const rig = await harness();
      const finishRead = Promise.withResolvers<void>();
      const delayRead = async <Result>(read: () => Promise<Result>) => {
        await finishRead.promise;
        return read();
      };
      if (method === "list") {
        const read = rig.journal.list.bind(rig.journal);
        rig.journal.list = () => delayRead(() => read(SCOPE));
      } else {
        const read = rig.journal.getBaseline.bind(rig.journal);
        rig.journal.getBaseline = () => delayRead(() => read(SCOPE));
      }
      const operation = rig.run().then(
        () => undefined,
        (error: unknown) => error,
      );
      await drainUntilQuiescent(rig.timer);
      rig.timer.advanceTime(50);
      await drainUntilQuiescent(rig.timer);
      rig.timer.advanceTime(100);
      const failure = await operation;
      expect(failure).toBeInstanceOf(ResetFailureError);
      expect(drainFailureOutcome(failure, SCOPE.sessionUuid, false)).toBe("pending");
      await expect(rig.run()).rejects.toThrow("unsettled native step");
      expect(rig.state.eraseCalls).toBe(0);
      finishRead.resolve();
      await drainUntilQuiescent(rig.timer);
      expect(await rig.run()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
      expect(rig.state.eraseCalls).toBe(0);
    },
  );

  test("only erase fallback reserves a reset boot slot", async () => {
    const rig = await harness();
    let bootSlots = 0;
    const runResetBoot: ResetBootRunner = async (operation) => {
      bootSlots++;
      return operation();
    };
    expect(await rig.run(0, undefined, runResetBoot)).toMatchObject({ outcome: "clean" });
    expect(bootSlots).toBe(0);
    expect(await rig.run(2, undefined, runResetBoot)).toMatchObject({ outcome: "fallback:erase" });
    expect(bootSlots).toBe(1);
  });

  test.each(["revert", "sanitize"] as const)(
    "a failed %s command erases exactly once",
    async (step) => {
      const rig = await harness();
      if (step === "revert") {
        await recordClipboard(rig);
        rig.mutations.beforeWrite = async () => {
          throw new ActionableError("revert failed");
        };
      } else {
        rig.mutations.sanitizeError = new ActionableError("sanitize failed");
      }
      expect(await rig.run()).toMatchObject({
        outcome: "fallback:erase",
        fallbackReason: expect.stringContaining("failed"),
      });
      expect(rig.state.eraseCalls).toBe(1);
    },
  );

  test("maxUses erases using the durable lifetime reuse count", async () => {
    const rig = await harness();
    expect(await rig.run(1)).toMatchObject({ outcome: "clean" });
    expect(await rig.run(2)).toMatchObject({
      outcome: "fallback:erase",
      fallbackReason: "maxUses reached",
    });
    expect(await rig.run(3)).toMatchObject({ outcome: "clean" });
    expect(await rig.run(5)).toMatchObject({ outcome: "fallback:erase" });
    expect(rig.state.eraseCalls).toBe(2);
  });

  test.each(["health", "state", "runtime", "type", "udid", "os", "available"])(
    "unhealthy %s falls back to erase",
    async (field) => {
      const rig = await harness();
      if (field === "health") {
        rig.state.healthy = false;
      }
      if (field === "state") {
        rig.state.target.state = "Shutdown";
      }
      if (field === "runtime") {
        rig.state.target.runtime = "other";
      }
      if (field === "type") {
        rig.state.target.deviceTypeIdentifier = "other";
      }
      if (field === "udid") {
        rig.state.target.udid = "other";
      }
      if (field === "os") {
        rig.state.target.os_version = "26";
      }
      if (field === "available") {
        rig.state.target.isAvailable = false;
      }
      expect(await rig.run()).toMatchObject({ outcome: "fallback:erase" });
      expect(rig.state.eraseCalls).toBe(1);
    },
  );

  test("ownership loss mid-reset cannot erase or report clean", async () => {
    const rig = await harness();
    await recordClipboard(rig);
    rig.mutations.beforeWrite = async () => {
      rig.state.owned = false;
    };
    await expect(rig.run()).rejects.toThrow("Ownership lost");
    expect(rig.state.eraseCalls).toBe(0);
    expect(rig.mutations.reverted).toEqual([]);
    expect(await rig.journal.list(SCOPE)).toHaveLength(1);
  });

  test("fresh health inventory detects a simulator stopped during cleaning", async () => {
    const rig = await harness();
    rig.mutations.sanitize = async (context) => {
      await context.assertOwned();
      rig.state.target.state = "Shutdown";
    };
    expect(await rig.run()).toMatchObject({
      outcome: "fallback:erase",
      fallbackReason: expect.stringContaining("confirm keep-booted health"),
    });
    expect(rig.state.healthCalls).toBe(0);
  });

  test("health deadline waits for the abandoned probe before retry", async () => {
    const rig = await harness();
    let calls = 0;
    rig.health.probe = async (_device, signal) => {
      calls++;
      if (calls === 1) {
        await rig.timer.sleep(100);
      }
      signal.throwIfAborted();
      return true;
    };
    const operation = rig.run();
    await drainUntilQuiescent(rig.timer);
    rig.timer.advanceTime(50);
    await drainUntilQuiescent(rig.timer);
    expect(calls).toBe(1);
    rig.timer.advanceTime(50);
    expect(await operation).toMatchObject({ outcome: "clean" });
    expect(calls).toBe(2);
    expect(rig.state.eraseCalls).toBe(0);
  });

  test.each([false, true])(
    "erase failure classification preserves capacity pending: %s",
    async (capacity) => {
      const rig = await harness();
      const cause = capacity
        ? new BootCapacityExhaustedError(
            { platform: "ios", limit: 1, booted: 1, retryAfterMs: 100 },
            "capacity",
          )
        : new ActionableError("erase failed");
      rig.state.eraseError = new ResetFailureError(
        "erase failed",
        { outcome: "pending", mode: "erase", phases: { erase: 2 } },
        { cause },
      );
      const caught = await rig.run(2).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(ResetFailureError);
      const failure = caught as ResetFailureError;
      expect(failure.reset).toMatchObject({
        mode: "erase",
        phases: { erase: 2 },
        fallbackReason: expect.stringContaining("maxUses reached"),
      });
      expect(drainFailureOutcome(failure.cause, SCOPE.sessionUuid, false)).toBe(
        capacity ? "pending" : "destroy",
      );
      expect(rig.state.eraseCalls).toBe(1);
    },
  );

  test("explicit reset caller cancellation never reports clean or invokes erase", async () => {
    const rig = await harness();
    const controller = new AbortController();
    rig.mutations.sanitize = async () => {
      controller.abort(new DOMException("shutdown", "AbortError"));
    };
    await expect(rig.run(0, controller.signal)).rejects.toThrow("shutdown");
    expect(rig.state.eraseCalls).toBe(0);
  });
});

test("sanitize completes within the load-scaled budget", async () => {
  const rig = await harness([], false, { hostLoad: { loadAverage1m: () => 3, cpuCount: () => 1 } });
  rig.mutations.sanitize = async () => {
    await rig.timer.sleep(120);
  };
  const operation = rig.run();
  await drainUntilQuiescent(rig.timer);
  rig.timer.advanceTime(120);
  expect(await operation).toMatchObject({ outcome: "clean" });
  expect(rig.state.eraseCalls).toBe(0);
});

test.each(["sanitize", "health"] as const)(
  "%s retries once with a fresh signal after its deadline",
  async (phase) => {
    const rig = await harness();
    const signals: AbortSignal[] = [];
    const operation = async (signal: AbortSignal) => {
      signals.push(signal);
      if (signals.length === 1) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
      }
    };
    if (phase === "sanitize") {
      rig.mutations.sanitize = (context) => operation(context.signal);
    } else {
      rig.health.probe = async (_device, signal) => {
        await operation(signal);
        return true;
      };
    }
    const result = rig.run();
    await drainUntilQuiescent(rig.timer);
    rig.timer.advanceTime(50);
    expect(await result).toMatchObject({ outcome: "clean" });
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(rig.state.eraseCalls).toBe(0);
  },
);

test("a retry that also times out falls back to a budget-driven erase", async () => {
  const rig = await harness();
  let calls = 0;
  rig.mutations.sanitize = async (context) => {
    calls++;
    const signal = context.signal;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    signal.throwIfAborted();
  };
  const result = rig.run();
  await drainUntilQuiescent(rig.timer);
  rig.timer.advanceTime(50);
  await drainUntilQuiescent(rig.timer);
  rig.timer.advanceTime(100);
  expect(await result).toMatchObject({
    outcome: "fallback:erase",
    fallbackReason: expect.stringMatching(/^budget-driven: /),
  });
  expect(calls).toBe(2);
  expect(rig.state.eraseCalls).toBe(1);
});

test("an abandoned step that never settles is not retried and blocks the erase", async () => {
  const rig = await harness();
  let calls = 0;
  rig.mutations.sanitize = async () => {
    calls++;
    await new Promise<void>(() => {});
  };
  const result = rig.run().then(
    () => undefined,
    (error: unknown) => error,
  );
  await drainUntilQuiescent(rig.timer);
  rig.timer.advanceTime(50);
  await drainUntilQuiescent(rig.timer);
  rig.timer.advanceTime(100);
  expect(await result).toBeInstanceOf(ResetFailureError);
  expect(calls).toBe(1);
  expect(rig.state.eraseCalls).toBe(0);
});

test.each(["rotation", "opened-url", "contact", "future-kind", "device-setting"])(
  "uncovered non-revertible %s erases before sanitize",
  async (kind) => {
    const rig = await harness();
    rig.mutations.unsupportedKinds.add(kind);
    await rig.journal.record(SCOPE, {
      kind,
      key: "unknown",
      toolName: "test",
      priorValue: { state: "unobservable" },
    });
    expect(await rig.run()).toMatchObject({
      outcome: "fallback:erase",
      fallbackReason: expect.stringContaining(`${kind}:unknown (test)`),
    });
    expect(rig.state.eraseCalls).toBe(1);
    expect(rig.mutations.sanitizeCount).toBe(0);
  },
);

test.each([false, true])(
  "iOS recording gap forces erase and clears only after success: %s",
  async (fail) => {
    const gaps = new InMemoryMutationRecordingGaps();
    gaps.mark(SCOPE.sessionUuid, "clipboard: unavailable");
    const rig = await harness([], false, { recordingGaps: gaps });
    if (fail) {
      rig.state.eraseError = new Error("erase failed");
    }
    if (fail) {
      await expect(rig.run()).rejects.toThrow("erase failed");
    } else {
      expect(await rig.run()).toMatchObject({
        outcome: "fallback:erase",
        fallbackReason: expect.stringContaining("clipboard: unavailable"),
      });
    }
    expect(rig.state.eraseCalls).toBe(1);
    expect(rig.mutations.sanitizeCount).toBe(0);
    expect(gaps.reasonFor(SCOPE.sessionUuid)).toBe(fail ? "clipboard: unavailable" : undefined);
  },
);

test.each([
  ["clipboard", "device"],
  ["keychain", "device"],
  ["permission", "app"],
  ["certificate", "root"],
  ["device-setting", "appearance"],
  ["preference", "tool:setUIState"],
  ["preference", "focused-field"],
  ["preference", JSON.stringify({ appId: "session.app", key: "name" })],
  ["opaque", "tool:sendSms"],
  ["installed-app", "session.app"],
  ["app-group", "session.app"],
])("sanitize covers non-revertible %s:%s", async (kind, key) => {
  const rig = await harness();
  await rig.journal.record(SCOPE, {
    kind,
    key,
    toolName: "test",
    priorValue: { state: "unobservable" },
  });
  expect(await rig.run()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
  expect(rig.mutations.sanitizeCount).toBe(1);
  expect(rig.state.eraseCalls).toBe(0);
});

test("non-revertible store preference of a baseline app requires erase", async () => {
  const rig = await harness([
    { kind: "installed-app", key: "baseline.app", value: { state: "present", value: true } },
  ]);
  const key = JSON.stringify({ appId: "baseline.app", key: "name" });
  await rig.journal.record(SCOPE, {
    kind: "preference",
    key,
    toolName: "test",
    priorValue: { state: "unobservable" },
  });
  expect(await rig.run()).toMatchObject({
    outcome: "fallback:erase",
    fallbackReason: expect.stringContaining(key),
  });
  expect(rig.mutations.sanitizeCount).toBe(0);
});

test("snapshot restore adapter row requires erase on iOS", async () => {
  const rig = await harness();
  for (const row of deviceToolMutations(
    "deviceSnapshot",
    { action: "restore", snapshotName: "baseline" },
    "ios",
  )) {
    await rig.journal.record(SCOPE, {
      ...row,
      toolName: "deviceSnapshot",
      priorValue: { state: "unobservable" },
    });
  }
  expect(await rig.run()).toMatchObject({ outcome: "fallback:erase" });
});

test("uncovered older row erases before reverting a newer clipboard row", async () => {
  const rig = await harness();
  await rig.journal.record(SCOPE, {
    kind: "opened-url",
    key: "unknown",
    toolName: "openLink",
    priorValue: { state: "unobservable" },
  });
  await rig.journal.record(SCOPE, {
    kind: "clipboard",
    key: "device",
    toolName: "clipboard",
    priorValue: { state: "present", value: "original" },
  });
  expect(await rig.run()).toMatchObject({ outcome: "fallback:erase" });
  expect(rig.mutations.reverted).toEqual([]);
});

test.each([false, true])("app-container write with baseline app=%s", async (baselineApp) => {
  const rig = await harness(
    baselineApp
      ? [{ kind: "installed-app", key: "app", value: { state: "present", value: true } }]
      : [],
  );
  await rig.journal.record(SCOPE, {
    kind: "shared-file",
    key: legacyAppContainerFileKey("app", "documents", "a.txt"),
    toolName: "putAppFile",
    priorValue: { state: "unobservable" },
  });
  expect(await rig.run()).toMatchObject({ outcome: baselineApp ? "fallback:erase" : "clean" });
  expect(rig.state.eraseCalls).toBe(baselineApp ? 1 : 0);
  expect(rig.mutations.sanitizeCount).toBe(baselineApp ? 0 : 1);
});
