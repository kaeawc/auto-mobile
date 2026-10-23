import { describe, expect, test } from "bun:test";
import { AndroidKeepBootedReset } from "../../../src/daemon/sessionBroker/androidKeepBootedReset";
import {
  AndroidBaselineReset,
  type AndroidResetStrategy,
} from "../../../src/daemon/sessionBroker/androidBaselineReset";
import {
  DEVICE_MUTATION_KINDS,
  opaqueIntentKey,
  type DeviceMutationInput,
} from "../../../src/daemon/sessionBroker/mutations/types";
import { FakeDeviceMutationJournal } from "../../fakes/FakeDeviceMutationJournal";
import { FakeAndroidKeepBootedResetPort } from "../../fakes/FakeAndroidKeepBootedResetPort";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";
import { getAbortSignal } from "../../../src/utils/AbortContext";
import {
  ANDROID_RESET_DEVICE,
  ANDROID_RESET_PROFILE,
  FakeAndroidResetHost,
} from "./fixtures/androidReset";

const SESSION = {
  resourceId: "resource-a",
  sessionId: "session-a",
  incarnation: JSON.stringify(["resource-a", "resource-a", "12345678-1234-1234-1234-123456789abc"]),
};
const SCOPE = {
  deviceId: ANDROID_RESET_DEVICE.deviceId,
  incarnation: SESSION.incarnation,
  sessionUuid: SESSION.sessionId,
};
const SETTING: DeviceMutationInput = {
  kind: "device-setting",
  key: "global:window_animation_scale",
  priorValue: { state: "absent" },
  toolName: "test",
};

async function rig(
  options: { maxUses?: number; fallback?: AndroidResetStrategy; fallbackBudgetMs?: number } = {},
) {
  const timer = new FakeTimer();
  const journal = new FakeDeviceMutationJournal(timer);
  const port = new FakeAndroidKeepBootedResetPort({
    completeKinds: [...DEVICE_MUTATION_KINDS],
    observations: [],
    unobservable: [],
  });
  const strategy = new AndroidKeepBootedReset({
    journal,
    port: () => port,
    timer,
    budgetMs: 50,
    ...options,
  });
  const capture = (sessionId = SESSION.sessionId) =>
    strategy.capture(ANDROID_RESET_DEVICE, {
      ...SESSION,
      sessionId,
      signal: new AbortController().signal,
      timeoutMs: 50,
      assertOwned: async () => {},
    });
  await capture();
  const reset = (sessionId = SESSION.sessionId, assertOwned = async () => {}) =>
    strategy.reset(ANDROID_RESET_DEVICE, new Set(), assertOwned, { ...SESSION, sessionId });
  return { timer, journal, port, strategy, capture, reset };
}

const BASELINE_PACKAGE_OBSERVATION = {
  kind: "installed-app",
  key: "user:0:com.example.baseline",
  value: { state: "present" as const, value: true },
};

describe("Android keep-booted strategy", () => {
  test("partial certification no longer suppresses baseline capture or cleaning", async () => {
    const timer = new FakeTimer();
    const journal = new FakeDeviceMutationJournal(timer);
    const port = new FakeAndroidKeepBootedResetPort({
      completeKinds: [],
      // An empty capture is never persisted as a baseline, so keep one observation.
      observations: [BASELINE_PACKAGE_OBSERVATION],
      unobservable: [...DEVICE_MUTATION_KINDS],
    });
    const strategy = new AndroidKeepBootedReset({ journal, port: () => port, timer });
    const assertOwned = async () => {};
    await strategy.capture(ANDROID_RESET_DEVICE, {
      ...SESSION,
      signal: new AbortController().signal,
      timeoutMs: 5000,
      assertOwned,
    });
    expect(
      await strategy.reset(ANDROID_RESET_DEVICE, new Set(), assertOwned, SESSION),
    ).toMatchObject({
      outcome: "clean",
      mode: "keep-booted",
      phases: { clean: 0, journal: 0, health: 0 },
    });
    expect(port.captureCount).toBe(1);
    expect(port.cleanCount).toBe(1);
    expect((await journal.getBaseline(SCOPE))?.unobservable).toEqual([...DEVICE_MUTATION_KINDS]);
  });

  test("restarted incarnations are retired rather than resurrecting a use counter", async () => {
    const { timer, journal, port } = await rig();
    let fallbacks = 0;
    const restarted = new AndroidKeepBootedReset({
      journal,
      port: () => port,
      timer,
      fallback: {
        reset: async () => {
          fallbacks++;
        },
      },
    });
    await restarted.capture(ANDROID_RESET_DEVICE, {
      ...SESSION,
      sessionId: "session-b",
      signal: new AbortController().signal,
      timeoutMs: 50,
      assertOwned: async () => {},
    });
    await expect(
      restarted.reset(ANDROID_RESET_DEVICE, new Set(), async () => {}, {
        ...SESSION,
        sessionId: "session-b",
      }),
    ).rejects.toThrow("retirement");
    expect(fallbacks).toBe(0);
    expect(port.captureCount).toBe(1);
    await restarted.forget(SESSION.resourceId);
    expect(await journal.getBaseline(SCOPE)).toBeNull();
  });

  test("retirement prunes the baseline and every session journal", async () => {
    const { journal, strategy } = await rig();
    await journal.record(SCOPE, SETTING);
    await journal.record({ ...SCOPE, sessionUuid: "session-b" }, SETTING);
    await strategy.forget(SESSION.resourceId);
    expect(await journal.getBaseline(SCOPE)).toBeNull();
    expect(await journal.list(SCOPE)).toEqual([]);
    expect(await journal.list({ ...SCOPE, sessionUuid: "session-b" })).toEqual([]);
  });

  test("destroy after restart prunes durable receipts without recapturing a session", async () => {
    const { journal, timer, port } = await rig();
    await journal.record(SCOPE, SETTING);
    const restarted = new AndroidKeepBootedReset({ journal, timer, port: () => port });
    await restarted.forget(SESSION.resourceId);
    expect(await journal.getBaseline(SCOPE)).toBeNull();
    expect(await journal.list(SCOPE)).toEqual([]);
  });

  test("journal capture uses the bounded cleaning budget within a larger preparation deadline", async () => {
    const timer = new FakeTimer();
    const journal = new FakeDeviceMutationJournal(timer);
    const port = new FakeAndroidKeepBootedResetPort({
      completeKinds: [...DEVICE_MUTATION_KINDS],
      observations: [],
      unobservable: [],
    });
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const capture = port.capture.bind(port);
    port.capture = async (context) => {
      reached.resolve();
      await release.promise;
      return capture(context);
    };
    const strategy = new AndroidKeepBootedReset({ journal, port: () => port, timer });
    const result = strategy
      .capture(ANDROID_RESET_DEVICE, {
        ...SESSION,
        signal: new AbortController().signal,
        timeoutMs: 60_000,
        assertOwned: async () => {},
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await reached.promise;
    timer.advanceTime(30_001);
    expect(await result).toBeInstanceOf(Error);
    release.resolve();
    await Promise.resolve();
    expect(await journal.getBaseline(SCOPE)).toBeNull();
  });

  test("a deviceSnapshot session skips the journal clean and escalates with the opaque flag", async () => {
    let seenOpaque: boolean | undefined;
    const { port, strategy } = await rig({
      fallback: {
        reset: async (_device, _packages, _assertOwned, context) => {
          seenOpaque = context.opaquePersistentChanges;
          return { outcome: "clean", mode: "wipe-data", phases: {} };
        },
      },
    });
    const result = await strategy.reset(ANDROID_RESET_DEVICE, new Set(), async () => {}, {
      ...SESSION,
      opaquePersistentChanges: true,
      rebindIncarnation: async () => SESSION.incarnation ?? SESSION.resourceId,
      assertBindingOwned: async () => {},
    });
    expect(port.cleanCount).toBe(0);
    expect(seenOpaque).toBe(true);
    expect(result).toMatchObject({ outcome: "fallback:wipe-data", mode: "wipe-data" });
    expect(result.fallbackReason).toContain("deviceSnapshot");
  });

  test("a fallback-forcing opaque journal row skips the clean and escalates without the wipe flag", async () => {
    let seenOpaque: boolean | undefined = true;
    const { port, strategy, journal } = await rig({
      fallback: {
        reset: async (_device, _packages, _assertOwned, context) => {
          seenOpaque = context.opaquePersistentChanges;
          return { outcome: "clean", mode: "snapshot", phases: {} };
        },
      },
    });
    await journal.record(SCOPE, {
      kind: "opaque",
      key: opaqueIntentKey("sendBroadcast", "com.example.app"),
      priorValue: { state: "unobservable" },
      toolName: "sendBroadcast",
    });
    const result = await strategy.reset(ANDROID_RESET_DEVICE, new Set(), async () => {}, {
      ...SESSION,
      rebindIncarnation: async () => SESSION.incarnation ?? SESSION.resourceId,
      assertBindingOwned: async () => {},
    });
    expect(port.cleanCount).toBe(0);
    expect(seenOpaque).toBeUndefined();
    expect(result).toMatchObject({ outcome: "fallback:snapshot", mode: "snapshot" });
    expect(result.fallbackReason).toContain("sendBroadcast");
  });

  test("a best-effort opaque journal row keeps the booted clean", async () => {
    const { port, strategy, journal } = await rig();
    await journal.record(SCOPE, {
      kind: "opaque",
      key: "tool:sendSms",
      priorValue: { state: "unobservable" },
      toolName: "sendSms",
    });
    const result = await strategy.reset(ANDROID_RESET_DEVICE, new Set(), async () => {}, SESSION);
    expect(port.cleanCount).toBe(1);
    expect(result).toMatchObject({ outcome: "clean", mode: "keep-booted" });
  });

  test("a deviceSnapshot session without a fallback fails closed", async () => {
    const { port, strategy } = await rig();
    await expect(
      strategy.reset(ANDROID_RESET_DEVICE, new Set(), async () => {}, {
        ...SESSION,
        opaquePersistentChanges: true,
      }),
    ).rejects.toThrow("fallback or destruction");
    expect(port.cleanCount).toBe(0);
  });

  test("fallback receives a fresh cancellable budget after replay consumes its entire budget", async () => {
    const replayReached = Promise.withResolvers<void>();
    const replayRelease = Promise.withResolvers<void>();
    const fallbackReached = Promise.withResolvers<void>();
    const fallbackRelease = Promise.withResolvers<void>();
    let fallbackSignal: AbortSignal | undefined;
    let fallbackBudget: number | undefined;
    let lateWrite = false;
    const { timer, port, reset } = await rig({
      fallbackBudgetMs: 75,
      fallback: {
        reset: async (_device, _packages, fence, context) => {
          fallbackSignal = context.signal;
          fallbackBudget = context.timeoutMs;
          fallbackReached.resolve();
          await fallbackRelease.promise;
          context.signal?.throwIfAborted();
          await fence();
          lateWrite = true;
        },
      },
    });
    const clean = port.cleanBaseline.bind(port);
    port.cleanBaseline = async (baseline, context) => {
      replayReached.resolve();
      await replayRelease.promise;
      return clean(baseline, context);
    };
    const result = reset().then(
      () => null,
      (error: unknown) => error,
    );
    await replayReached.promise;
    timer.advanceTime(51);
    await drainMicrotasks(30);
    expect(fallbackSignal).toBeUndefined();
    replayRelease.resolve();
    await fallbackReached.promise;
    expect(fallbackSignal?.aborted).toBe(false);
    expect(fallbackBudget).toBe(75);
    timer.advanceTime(74);
    expect(fallbackSignal?.aborted).toBe(false);
    timer.advanceTime(2);
    expect(fallbackSignal?.aborted).toBe(true);
    fallbackRelease.resolve();
    expect(await result).toBeInstanceOf(Error);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateWrite).toBe(false);
  });

  test.each(["timeout", "cancellation"])(
    "cleaning settlement precedes destruction after %s",
    async (reason) => {
      const { timer, port, strategy } = await rig();
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      let settled = false;
      let cleaningSignal: AbortSignal | undefined;
      port.cleanBaseline = async (_baseline, context) => {
        cleaningSignal = context.signal;
        reached.resolve();
        await release.promise;
      };
      const result = strategy
        .reset(ANDROID_RESET_DEVICE, new Set(), async () => {}, {
          ...SESSION,
          signal: controller.signal,
        })
        .then(
          () => null,
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      await reached.promise;
      if (reason === "timeout") {
        timer.advanceTime(51);
      } else {
        controller.abort(new Error("cancelled"));
      }
      await drainMicrotasks(30);
      expect(cleaningSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      release.resolve();
      expect(await result).toBeInstanceOf(Error);
      expect(settled).toBe(true);
    },
  );

  test("an uncooperative cleaning command exhausts the bounded drain without starting fallback", async () => {
    let fallbacks = 0;
    const { timer, port, reset } = await rig({
      fallback: {
        reset: async () => {
          fallbacks++;
        },
      },
    });
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    port.cleanBaseline = async () => {
      reached.resolve();
      await release.promise;
    };
    const result = reset().then(
      () => null,
      (error: unknown) => error,
    );
    await reached.promise;
    timer.advanceTime(51);
    await drainMicrotasks(30);
    timer.advanceTime(2001);
    expect(await result).toBeInstanceOf(Error);
    expect(fallbacks).toBe(0);
    release.resolve();
  });

  test("timing out a native ownership read drains it without misclassifying timeout as ownership loss", async () => {
    let fallbacks = 0;
    const { timer, port, reset } = await rig({
      fallback: {
        reset: async () => {
          fallbacks++;
        },
      },
    });
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let stall = false;
    port.beforeClean = async () => {
      stall = true;
    };
    const result = reset(SESSION.sessionId, async () => {
      if (stall) {
        stall = false;
        reached.resolve();
        await release.promise;
        getAbortSignal()?.throwIfAborted();
      }
    });
    await reached.promise;
    timer.advanceTime(51);
    await drainMicrotasks(30);
    expect(fallbacks).toBe(0);
    release.resolve();
    expect(await result).toMatchObject({ outcome: "fallback:snapshot" });
    expect(fallbacks).toBe(1);
  });

  test.each(["timeout", "cancellation"])(
    "fallback settlement precedes teardown even when it ignores %s",
    async (reason) => {
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      let lateWrite = false;
      let settled = false;
      const { timer, strategy } = await rig({
        maxUses: 1,
        fallbackBudgetMs: 75,
        fallback: {
          reset: async () => {
            reached.resolve();
            await release.promise;
            lateWrite = true;
          },
        },
      });
      const result = strategy
        .reset(ANDROID_RESET_DEVICE, new Set(), async () => {}, {
          ...SESSION,
          signal: controller.signal,
        })
        .then(
          () => null,
          (error: unknown) => error,
        )
        .then((error) => {
          settled = true;
          return error;
        });
      await reached.promise;
      if (reason === "timeout") {
        timer.advanceTime(76);
      } else {
        controller.abort(new Error("cancelled"));
      }
      await drainMicrotasks(30);
      expect(settled).toBe(false);
      expect(lateWrite).toBe(false);
      release.resolve();
      expect(await result).toBeInstanceOf(Error);
      expect(lateWrite).toBe(true);
    },
  );

  test("fallback capture receives the remaining preparation budget, not the journal cap", async () => {
    const timer = new FakeTimer();
    const journal = new FakeDeviceMutationJournal(timer);
    const port = new FakeAndroidKeepBootedResetPort({
      completeKinds: [...DEVICE_MUTATION_KINDS],
      observations: [],
      unobservable: [],
    });
    const capture = port.capture.bind(port);
    port.capture = async (context) => {
      timer.advanceTime(500);
      return capture(context);
    };
    let fallbackBudget: number | undefined;
    const strategy = new AndroidKeepBootedReset({
      journal,
      port: () => port,
      timer,
      fallback: {
        capture: async (_device, context) => {
          fallbackBudget = context.timeoutMs;
          timer.advanceTime(3000);
          context.signal.throwIfAborted();
          await context.assertOwned();
        },
        reset: async () => {},
      },
    });
    await strategy.capture(ANDROID_RESET_DEVICE, {
      ...SESSION,
      signal: new AbortController().signal,
      timeoutMs: 10_000,
      assertOwned: async () => {},
    });
    expect(fallbackBudget).toBe(9500);
  });

  test("failed journal pruning still forgets the session and fallback", async () => {
    let forgotten: string | undefined;
    const { journal, strategy, reset } = await rig({
      fallback: {
        reset: async () => {},
        forget: (resourceId) => {
          forgotten = resourceId;
        },
      },
    });
    journal.deleteResource = async () => {
      throw new Error("SQLite unavailable");
    };
    await strategy.forget(SESSION.resourceId);
    expect(forgotten).toBe(SESSION.resourceId);
    await expect(reset()).rejects.toThrow("fenced session baseline");
  });
  test("cleans and replays the journal without a certification readback", async () => {
    const { journal, port, reset } = await rig();
    await journal.record(SCOPE, SETTING);
    port.snapshot.observations.push({
      kind: SETTING.kind,
      key: SETTING.key,
      value: { state: "present", value: "0" },
    });
    await reset();
    expect(port.reverted).toMatchObject([SETTING]);
    expect(port.snapshot.observations).toEqual([]);
    expect(port.captureCount).toBe(1);
    expect(await journal.list(SCOPE)).toHaveLength(1);
  });

  test("first baseline survives the next session instead of trusting newly contaminated state", async () => {
    const { journal, port, capture } = await rig();
    port.snapshot.observations.push({
      kind: "account",
      key: "outside",
      value: { state: "present", value: "probe" },
    });
    await capture("session-b");
    expect((await journal.getBaseline(SCOPE))?.observations).toEqual([]);
    expect(port.captureCount).toBe(1);
  });

  test.each(["android", "com.example.fixture"])(
    "journal replay never uninstalls baseline package %s despite an absent prior",
    async (packageName) => {
      const { journal, port, capture, reset } = await rig();
      await journal.deleteResource(SESSION.resourceId);
      port.snapshot.observations.push({
        kind: "installed-app",
        key: `user:0:${packageName}`,
        value: { state: "present", value: true },
      });
      await capture();
      await journal.record(SCOPE, {
        kind: "installed-app",
        key: `user:0:${packageName}`,
        priorValue: { state: "absent" },
        toolName: "test-install-update",
      });
      expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
      expect(port.reverted).toEqual([]);
      expect(port.cleanCount).toBe(1);
    },
  );

  test("phase timings use FakeTimer and include journal, cleaning and health", async () => {
    const { timer, journal, port, strategy } = await rig();
    await journal.record(SCOPE, SETTING);
    port.beforeWrite = async () => {
      timer.advanceTime(3);
    };
    port.beforeClean = async () => {
      timer.advanceTime(5);
    };
    expect(
      await strategy.reset(ANDROID_RESET_DEVICE, new Set(), async () => {}, {
        ...SESSION,
        healthCheck: async (context) => {
          await context.assertOwned();
          timer.advanceTime(7);
        },
      }),
    ).toEqual({
      outcome: "clean",
      mode: "keep-booted",
      phases: { journal: 3, clean: 5, health: 7 },
    });
  });

  test.each([
    "unsupported",
    "unobservable",
    "failed-write",
    "failed-readback",
    "outside-account",
    "outside-file",
  ])("%s does not gate best-effort cleaning on certification", async (failure) => {
    const { journal, port, reset } = await rig();
    await journal.record(SCOPE, SETTING);
    if (failure === "unsupported") {
      port.unsupportedKinds.add(SETTING.kind);
    }
    if (failure === "unobservable") {
      port.snapshot.unobservable.push("clipboard");
    }
    if (failure === "failed-write") {
      port.beforeClean = async () => {
        throw new Error("adb failed");
      };
    }
    if (failure === "failed-readback") {
      port.ignoreWrites = true;
      port.snapshot.observations.push({
        kind: SETTING.kind,
        key: SETTING.key,
        value: { state: "present", value: "0" },
      });
    }
    if (failure === "outside-account" || failure === "outside-file") {
      port.snapshot.observations.push({
        kind: failure === "outside-account" ? "account" : "shared-file",
        key: "external",
        value: { state: "present", value: "probe" },
      });
    }
    if (failure === "failed-write") {
      await expect(reset()).rejects.toThrow("is non-clean");
    } else {
      expect(await reset()).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    }
    expect(await journal.list(SCOPE)).toHaveLength(1);
  });

  test.each(["unsupported", "failed-write"])(
    "%s escalates to an injected snapshot-compatible baseline strategy",
    async (failure) => {
      let fallbacks = 0;
      const fallback: AndroidResetStrategy = {
        reset: async (_device, _packages, assertOwned) => {
          await assertOwned();
          fallbacks++;
        },
      };
      const { journal, port, reset } = await rig({ fallback });
      await journal.record(SCOPE, SETTING);
      if (failure === "unsupported") {
        port.unsupportedKinds.add(SETTING.kind);
      } else {
        port.beforeClean = async () => {
          throw new Error("adb failed");
        };
      }
      await reset();
      expect(fallbacks).toBe(failure === "unsupported" ? 0 : 1);
    },
  );

  test("maxUses retires the keep-booted resource instead of replaying or pooling", async () => {
    const { port, capture, reset } = await rig({ maxUses: 2 });
    await reset();
    await capture("session-b");
    await expect(reset("session-b")).rejects.toThrow("maxUses retirement");
    expect(port.reverted).toEqual([]);
    expect(port.captureCount).toBe(1);
  });

  test("maxUses escalates to the baseline and restarts its use count", async () => {
    let fallbacks = 0;
    const fallback: AndroidResetStrategy = {
      reset: async (_device, _packages, fence) => {
        await fence();
        fallbacks++;
      },
    };
    const { capture, reset } = await rig({ maxUses: 2, fallback });
    await reset();
    await capture("session-b");
    await reset("session-b");
    expect(fallbacks).toBe(1);
    await capture("session-c");
    await reset("session-c");
    expect(fallbacks).toBe(1);
  });

  test("failed baseline fallback propagates rather than returning clean", async () => {
    const { reset } = await rig({
      maxUses: 1,
      fallback: {
        reset: async () => {
          throw new Error("snapshot failed");
        },
      },
    });
    await expect(reset()).rejects.toThrow("snapshot failed");
  });

  test("ownership loss prevents both replay and baseline fallback", async () => {
    let fallbacks = 0;
    const { port, reset } = await rig({
      maxUses: 1,
      fallback: {
        reset: async () => {
          fallbacks++;
        },
      },
    });
    await expect(
      reset(SESSION.sessionId, async () => {
        throw new Error("ownership lost");
      }),
    ).rejects.toThrow("ownership lost");
    expect(fallbacks).toBe(0);
    expect(port.reverted).toEqual([]);
  });

  test("an ownership fence failure is latched even if a later fence would succeed", async () => {
    let fallbacks = 0;
    let lost = false;
    const { port, reset } = await rig({
      fallback: {
        reset: async () => {
          fallbacks++;
        },
      },
    });
    port.beforeClean = async () => {
      lost = true;
    };
    await expect(
      reset(SESSION.sessionId, async () => {
        if (lost) {
          lost = false;
          throw new Error("one-shot ownership loss");
        }
      }),
    ).rejects.toThrow("one-shot ownership loss");
    expect(fallbacks).toBe(0);
  });

  test("total budget exhaustion fences delayed writes and preserves recovery entries", async () => {
    const { timer, journal, port, reset } = await rig();
    await journal.record(SCOPE, SETTING);
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    port.beforeWrite = async () => {
      reached.resolve();
      await release.promise;
    };
    const running = reset();
    const rejected = running.then(
      () => null,
      (error: unknown) => error,
    );
    await reached.promise;
    timer.advanceTime(51);
    await drainMicrotasks(30);
    release.resolve();
    expect(await rejected).toBeInstanceOf(Error);
    await Promise.resolve();
    await Promise.resolve();
    expect(port.reverted).toEqual([]);
    expect(await journal.list(SCOPE)).toHaveLength(1);
  });

  test("wrong session, changed serial and forgotten incarnation cannot reset", async () => {
    const { strategy, reset } = await rig();
    await expect(reset("foreign-session")).rejects.toThrow("fenced session baseline");
    await expect(
      strategy.reset(
        { ...ANDROID_RESET_DEVICE, deviceId: "emulator-5556" },
        new Set(),
        async () => {},
        SESSION,
      ),
    ).rejects.toThrow("fenced session baseline");
    await strategy.forget(SESSION.resourceId);
    await expect(reset()).rejects.toThrow("fenced session baseline");
  });

  test("composes with the seam health check without the legacy mutation veto", async () => {
    const host = new FakeAndroidResetHost();
    const { strategy, journal } = await rig();
    host.strategy = strategy;
    const seam = new AndroidBaselineReset(host);
    await seam.capture(
      SESSION.resourceId,
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      SESSION.sessionId,
    );
    host.safe = false;
    await journal.record(SCOPE, SETTING);
    expect(
      await seam.reset(
        SESSION.resourceId,
        ANDROID_RESET_DEVICE,
        ANDROID_RESET_PROFILE,
        async () => {},
      ),
    ).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(host.closed).toBe(1);
    expect(await journal.list(SCOPE)).toHaveLength(1);
  });

  test("CtrlProxy health failure after replay cannot publish clean or drop the journal", async () => {
    const host = new FakeAndroidResetHost();
    const { strategy, journal } = await rig();
    host.strategy = strategy;
    const seam = new AndroidBaselineReset(host);
    await seam.capture(
      SESSION.resourceId,
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      SESSION.sessionId,
    );
    await journal.record(SCOPE, SETTING);
    host.healthy = false;
    await expect(
      seam.reset(SESSION.resourceId, ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).rejects.toThrow("CtrlProxy health check failed");
    expect(await journal.list(SCOPE)).toHaveLength(1);
  });

  test("seam health ADB reads are non-retrying and CtrlProxy gets a bounded cancellable single attempt", async () => {
    const host = new FakeAndroidResetHost();
    const { strategy } = await rig();
    host.strategy = strategy;
    const seam = new AndroidBaselineReset(host);
    await seam.capture(
      SESSION.resourceId,
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      SESSION.sessionId,
    );
    host.commands = [];
    host.commandOptions = [];
    await seam.reset(
      SESSION.resourceId,
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      async () => {},
    );
    for (const options of host.commandOptions) {
      expect(options).toMatchObject({
        noRetry: true,
        timeoutMs: 2000,
        waitForProcessSettlementAfterAbort: true,
      });
    }
    expect(host.healthOptions).toMatchObject({ noRetry: true, timeoutMs: 2000 });
    expect(host.healthOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(host.healthOptions?.signal?.aborted).toBe(false);
  });

  test("CtrlProxy's own deadline aborts the health probe before the 30-second cleaning cap", async () => {
    const host = new FakeAndroidResetHost();
    const timer = new FakeTimer();
    const port = new FakeAndroidKeepBootedResetPort({
      completeKinds: [],
      // An empty capture is never persisted as a baseline, so keep one observation.
      observations: [BASELINE_PACKAGE_OBSERVATION],
      unobservable: [],
    });
    host.strategy = new AndroidKeepBootedReset({
      journal: new FakeDeviceMutationJournal(timer),
      port: () => port,
      timer,
    });
    const seam = new AndroidBaselineReset(host);
    await seam.capture(
      SESSION.resourceId,
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      SESSION.sessionId,
      { timer },
    );
    const reached = Promise.withResolvers<void>();
    let probeSignal: AbortSignal | undefined;
    host.ctrlProxyReady = async (_device, options) => {
      probeSignal = options?.signal;
      reached.resolve();
      return new Promise<boolean>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    };
    const result = seam
      .reset(SESSION.resourceId, ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {})
      .then(
        () => null,
        (error: unknown) => error,
      );
    await reached.promise;
    timer.advanceTime(2001);
    expect(await result).toBeInstanceOf(Error);
    expect(probeSignal?.aborted).toBe(true);
    expect(port.cleanCount).toBe(1);
  });

  test("a reboot between capture and release prevents cleaning or fallback", async () => {
    const host = new FakeAndroidResetHost();
    let fallbacks = 0;
    const { strategy, port } = await rig({
      fallback: {
        reset: async () => {
          fallbacks++;
        },
      },
    });
    host.strategy = strategy;
    const seam = new AndroidBaselineReset(host);
    await seam.capture(
      SESSION.resourceId,
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      SESSION.sessionId,
    );
    host.bootId = "87654321-1234-1234-1234-123456789abc";
    await expect(
      seam.reset(SESSION.resourceId, ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {}),
    ).rejects.toThrow("changed emulator boot identity");
    expect(port.cleanCount).toBe(0);
    expect(fallbacks).toBe(0);
  });

  test.each(["boot", "package-manager", "CtrlProxy"])(
    "%s health failure can recover through a fenced snapshot fallback",
    async (failure) => {
      const host = new FakeAndroidResetHost();
      let fallbacks = 0;
      const { strategy, port } = await rig({
        fallback: {
          reset: async (_device, _packages, fence) => {
            await fence();
            fallbacks++;
            host.booted = true;
            host.packageManager = true;
            host.healthy = true;
          },
        },
      });
      host.strategy = strategy;
      const seam = new AndroidBaselineReset(host);
      await seam.capture(
        SESSION.resourceId,
        ANDROID_RESET_DEVICE,
        ANDROID_RESET_PROFILE,
        SESSION.sessionId,
      );
      port.beforeClean = async () => {
        host.booted = failure !== "boot";
        host.packageManager = failure !== "package-manager";
        host.healthy = failure !== "CtrlProxy";
      };
      expect(
        await seam.reset(
          SESSION.resourceId,
          ANDROID_RESET_DEVICE,
          ANDROID_RESET_PROFILE,
          async () => {},
        ),
      ).toMatchObject({ outcome: "fallback:snapshot", mode: "snapshot" });
      expect(fallbacks).toBe(1);
    },
  );

  test("ownership lost during health never runs fallback or publishes clean", async () => {
    const host = new FakeAndroidResetHost();
    let owned = true;
    let fallbacks = 0;
    const { strategy } = await rig({
      fallback: {
        reset: async () => {
          fallbacks++;
        },
      },
    });
    host.strategy = strategy;
    const seam = new AndroidBaselineReset(host);
    await seam.capture(
      SESSION.resourceId,
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      SESSION.sessionId,
    );
    host.onHealth = () => {
      owned = false;
    };
    await expect(
      seam.reset(SESSION.resourceId, ANDROID_RESET_DEVICE, ANDROID_RESET_PROFILE, async () => {
        if (!owned) {
          throw new Error("ownership lost during health");
        }
      }),
    ).rejects.toThrow("ownership lost during health");
    expect(fallbacks).toBe(0);
  });

  test("mutation-aware seam permits package additions only when replay restores the original inventory", async () => {
    const host = new FakeAndroidResetHost();
    const { strategy, port } = await rig();
    host.strategy = strategy;
    const seam = new AndroidBaselineReset(host);
    await seam.capture(
      SESSION.resourceId,
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      SESSION.sessionId,
    );
    host.safe = false;
    host.installed.add("com.example.session");
    port.snapshot.observations.push({
      kind: "installed-app",
      key: "com.example.session",
      value: { state: "present", value: true },
    });
    port.beforeWrite = async () => {
      host.installed.delete("com.example.session");
    };
    expect(
      await seam.reset(
        SESSION.resourceId,
        ANDROID_RESET_DEVICE,
        ANDROID_RESET_PROFILE,
        async () => {},
      ),
    ).toMatchObject({ outcome: "clean", mode: "keep-booted" });
    expect(port.reverted).toMatchObject([
      { kind: "installed-app", key: "com.example.session", priorValue: { state: "absent" } },
    ]);
  });

  test("snapshot fallback reports its mode without a certification package equality gate", async () => {
    const host = new FakeAndroidResetHost();
    const { strategy } = await rig({ maxUses: 1, fallback: { reset: async () => {} } });
    host.strategy = strategy;
    const seam = new AndroidBaselineReset(host);
    await seam.capture(
      SESSION.resourceId,
      ANDROID_RESET_DEVICE,
      ANDROID_RESET_PROFILE,
      SESSION.sessionId,
    );
    host.installed.add("com.example.contamination");
    expect(
      await seam.reset(
        SESSION.resourceId,
        ANDROID_RESET_DEVICE,
        ANDROID_RESET_PROFILE,
        async () => {},
      ),
    ).toMatchObject({ outcome: "fallback:snapshot", mode: "snapshot" });
  });

  test("capture deadline aborts late baseline publication using FakeTimer", async () => {
    const timer = new FakeTimer();
    const journal = new FakeDeviceMutationJournal(timer);
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const port = new FakeAndroidKeepBootedResetPort({
      completeKinds: [...DEVICE_MUTATION_KINDS],
      observations: [],
      unobservable: [],
    });
    const capture = port.capture.bind(port);
    port.capture = async (context) => {
      reached.resolve();
      await release.promise;
      return capture(context);
    };
    const strategy = new AndroidKeepBootedReset({ journal, port: () => port, timer });
    const result = strategy
      .capture(ANDROID_RESET_DEVICE, {
        ...SESSION,
        signal: new AbortController().signal,
        timeoutMs: 50,
        assertOwned: async () => {},
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await reached.promise;
    timer.advanceTime(51);
    expect(await result).toBeInstanceOf(Error);
    release.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(await journal.getBaseline(SCOPE)).toBeNull();
    await expect(
      strategy.reset(ANDROID_RESET_DEVICE, new Set(), async () => {}, SESSION),
    ).rejects.toThrow("fenced session baseline");
  });

  test("eviction forgets the strategy receipt and maxUses counter", async () => {
    const { strategy, capture, reset } = await rig({ maxUses: 2 });
    await reset();
    await strategy.forget(SESSION.resourceId);
    await capture("session-b");
    await reset("session-b");
  });

  test("a recycled emulator serial cannot transfer a baseline across device incarnations", async () => {
    const { strategy } = await rig();
    await expect(
      strategy.capture(ANDROID_RESET_DEVICE, {
        ...SESSION,
        incarnation: "replacement-generation",
        signal: new AbortController().signal,
        timeoutMs: 50,
        assertOwned: async () => {},
      }),
    ).rejects.toThrow("changed emulator identity");
    await expect(
      strategy.reset(ANDROID_RESET_DEVICE, new Set(), async () => {}, {
        ...SESSION,
        incarnation: "replacement-generation",
      }),
    ).rejects.toThrow("fenced session baseline");
  });
});
