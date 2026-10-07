import { expect, spyOn, test } from "bun:test";
import {
  SendKeys,
  DefaultSendKeysCommandExecutor,
  type SendKeysCommand,
  type TextActionResult,
} from "../../../src/features/action/SendKeys";
import {
  clearAndroidImeQuarantine,
  quarantineAndroidIme,
  withAndroidImeLock,
} from "../../../src/features/action/androidImeLock";
import {
  AndroidImeCatalog,
  AUTO_MOBILE_IME_ID,
  imeCapabilities,
} from "../../../src/features/action/AndroidImeCatalog";
import { runWithTextRequestContext } from "../../../src/features/action/textTransportTimeout";
import {
  getAbortSignal,
  runWithAbortSignal,
  runOutsideRequestContext,
} from "../../../src/utils/AbortContext";
import { FakeTimer } from "../../fakes/FakeTimer";
import { android, createSendKeysHarness, observer } from "./SendKeysTestHarness";

let serial = 0;
function harness() {
  const device = { ...android, deviceId: `budget-10253-${++serial}` };
  const h = createSendKeysHarness(device);
  const timer = new FakeTimer();
  const action = new SendKeys(device, h.adbFactory, {
    executor: h.executor,
    timer,
    observer,
    timestampProvider: { now: async () => 1 },
  });
  return { ...h, action, timer, device };
}

const type: SendKeysCommand = { action: "type", text: "x", mode: "ime" };
const commands = Array.from({ length: 100 }, () => type);

function budgeted(h: ReturnType<typeof harness>, list = commands) {
  const deadlineMs = h.timer.now() + 120_000;
  return runWithTextRequestContext({ getDeadlineMs: () => deadlineMs }, () =>
    h.action.execute(list),
  );
}

test("budget exhaustion between commands reports delivered and not-sent counts and releases IME lock", async () => {
  const h = harness();
  const result = await runWithTextRequestContext({ getDeadlineMs: () => 120_000 }, () =>
    h.action.execute(commands, undefined, async (index) => {
      if (index > 0) {
        h.timer.advanceTime(1500);
      }
    }),
  );
  expect(result).toMatchObject({ success: false, completedCommands: 66, failedIndex: 66 });
  expect(result.commands).toHaveLength(66);
  expect(result.error).toContain("66 command(s) delivered; 34 command(s) not sent");
  expect(result.error).not.toContain("indeterminate");
  expect(result.warning).toContain("Partial application");
  expect(await withAndroidImeLock(h.device.deviceId, async () => true)).toBe(true);
  expect((await h.action.execute([type])).success).toBe(true);
});

test("in-flight budget cancellation awaits cleanup and reports indeterminate outcome without a failed command", async () => {
  const h = harness();
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const commit = h.client.commitViaIme;
  let call = 0;
  h.client.commitViaIme = async (...args) => {
    if (++call !== 2) {
      return commit(...args);
    }
    entered();
    if (!args[2]) {
      return { success: false, error: "No budget cancellation signal was supplied" };
    }
    return new Promise<TextActionResult>((resolve) => {
      args[2]?.addEventListener(
        "abort",
        () =>
          resolve({
            success: false,
            partialApplication: true,
            error: "cancel acknowledged",
          }),
        { once: true },
      );
    });
  };
  const pending = budgeted(h);
  await started;
  h.timer.advanceTime(99_000);
  const result = await pending;
  expect(result).toMatchObject({
    success: false,
    completedCommands: 1,
    failedIndex: 1,
    retryable: false,
  });
  expect(result.commands).toHaveLength(1);
  expect(result.error).toContain("1 command(s) delivered; 98 command(s) not sent");
  expect(result.error).toContain("Command 1 outcome is indeterminate");
  expect(await withAndroidImeLock(h.device.deviceId, async () => true)).toBe(true);
  expect((await h.action.execute([type])).success).toBe(true);
});

test.each(["abort", "device error"])(
  "%s mid-commit completes cleanup, releases lock, and permits later typing",
  async (exit) => {
    const h = harness();
    const controller = new AbortController();
    const commit = h.client.commitViaIme;
    let cleanupSawAbort: boolean | undefined;
    const delegate = h.adbFactory.create(h.device);
    const adb = new Proxy(delegate, {
      get(target, property, receiver) {
        if (property === "execute") {
          return async (...args: Parameters<typeof delegate.execute>) => {
            if (args[0][2] === "set") {
              cleanupSawAbort = getAbortSignal()?.aborted;
              // Model AdbClient's implicit ambient cancellation at the existing seam.
              getAbortSignal()?.throwIfAborted();
            }
            return delegate.execute(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const factory = { create: () => adb };
    const action = new SendKeys(h.device, factory, {
      executor: new DefaultSendKeysCommandExecutor(h.device, factory, observer, {
        textClient: h.client,
        timer: h.timer,
      }),
      timer: h.timer,
      observer,
      timestampProvider: { now: async () => 1 },
    });
    h.client.commitViaIme = async () => {
      h.timer.setTimeout(() => controller.abort(), 1);
      if (exit === "abort") {
        h.timer.advanceTime(1);
        throw controller.signal.reason;
      }
      throw new Error("device error");
    };
    const pending = runWithAbortSignal(controller.signal, () =>
      action.execute([type], undefined, undefined, controller.signal),
    );
    if (exit === "abort") {
      await expect(pending).rejects.toThrow();
    } else {
      expect((await pending).success).toBe(false);
    }
    expect(cleanupSawAbort).not.toBe(true);
    expect(await withAndroidImeLock(h.device.deviceId, async () => true)).toBe(true);
    h.client.commitViaIme = commit;
    expect((await action.execute([type])).success).toBe(true);
  },
);

test("short calls with a request deadline are unaffected", async () => {
  const h = harness();
  const result = await budgeted(h, [type]);
  expect(result).toMatchObject({ success: true, completedCommands: 1 });
  expect(result.observation).toBeDefined();
  h.timer.advanceTime(120_000);
  expect((await h.action.execute([type])).success).toBe(true);
});

test("expired admission budget sends no commands", async () => {
  const h = harness();
  const result = await runWithTextRequestContext(
    { getDeadlineMs: () => h.timer.now() + 1000 },
    () => h.action.execute(commands),
  );
  expect(result).toMatchObject({ success: false, completedCommands: 0, failedIndex: 0 });
  expect(result.error).toContain("100 command(s) not sent");
  expect(result.error).toContain("no request budget remained at admission; no commands were sent");
  expect(result.error).not.toContain("indeterminate");
  expect(result.retryable).toBe(false);
  expect(h.committed).toEqual([]);
  expect((await h.action.execute([type])).success).toBe(true);
});

test.each([
  "safe",
  "installed",
  "disabled",
  "inactive",
  "different",
  "subtype",
  "AutoMobile prior",
  "AutoMobile enabled",
  "AutoMobile absent",
  "missing enabled state",
  "unreadable",
])("quarantine recovery: %s", async (state) => {
  const h = harness();
  const prior = state === "AutoMobile prior" ? AUTO_MOBILE_IME_ID : "com.example.keyboard/.Ime";
  quarantineAndroidIme(h.device.deviceId, {
    imeId: prior,
    subtypeId: null,
    ...(state === "missing enabled state"
      ? {}
      : { wasEnabled: !["AutoMobile enabled", "AutoMobile absent"].includes(state) }),
  });
  const list = spyOn(AndroidImeCatalog.prototype, "list").mockResolvedValue({
    activeImeId: state === "different" ? null : prior,
    installed: [
      {
        id: state === "installed" ? "com.other.keyboard/.Ime" : prior,
        enabled: state !== "disabled",
        active: state !== "inactive",
        capabilities: imeCapabilities(prior),
      },
      ...(prior === AUTO_MOBILE_IME_ID || state === "AutoMobile absent"
        ? []
        : [
            {
              id: AUTO_MOBILE_IME_ID,
              enabled: state !== "missing enabled state",
              active: false,
              capabilities: imeCapabilities(AUTO_MOBILE_IME_ID),
            },
          ]),
    ],
  });
  const subtype = spyOn(AndroidImeCatalog.prototype, "readSubtype").mockResolvedValue({
    id: state === "subtype" ? 42 : null,
  });
  if (state === "unreadable") {
    list.mockRejectedValue(new Error("read unavailable"));
  }
  try {
    // Rejected recovery must leave the lock quarantined and dispatch nothing.
    const pending = h.action.execute([type]);
    if (["safe", "AutoMobile absent"].includes(state)) {
      expect((await pending).success).toBe(true);
      expect(await withAndroidImeLock(h.device.deviceId, async () => true)).toBe(true);
    } else {
      expect((await pending).error).toContain("IME state is unknown");
      await expect(withAndroidImeLock(h.device.deviceId, async () => true)).rejects.toThrow(
        "IME state is unknown",
      );
      expect(h.committed).toEqual([]);
    }
  } finally {
    list.mockRestore();
    subtype.mockRestore();
    clearAndroidImeQuarantine(h.device.deviceId);
  }
});

test("without request context, the existing caller-controlled behaviour is preserved", async () => {
  const h = harness();
  const commit = h.client.commitViaIme;
  h.client.commitViaIme = async (...args) => {
    h.timer.advanceTime(1500);
    return commit(...args);
  };
  expect(await h.action.execute(commands)).toMatchObject({ success: true, completedCommands: 100 });
});

test("budget cancellation with lost acknowledgement retains quarantine until explicit IME recovery", async () => {
  const h = harness();
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const commit = h.client.commitViaIme;
  let priorIme: string | null = null;
  h.client.commitViaIme = async (_text, prior, signal) => {
    priorIme = prior;
    entered();
    if (!signal) {
      return { success: false, error: "No budget cancellation signal was supplied" };
    }
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return { success: false, partialApplication: true, sessionUnsafe: true };
  };
  try {
    const pending = budgeted(h);
    await started;
    h.timer.advanceTime(99_000);
    const result = await pending;
    expect(result).toMatchObject({ success: false, completedCommands: 0, failedIndex: 0 });
    expect(result.error).toContain("99 command(s) not sent");
    expect(result.error).toContain("indeterminate");
    const capturedIme = "com.example.keyboard/.Ime";
    expect(priorIme).toBeNull();
    expect(result.error).toContain(`keyboard setIme ${capturedIme}`);
    expect(h.adb.getExecutedCommands()).not.toContain(`shell ime set ${capturedIme}`);
    expect(h.adb.getExecutedCommands()).not.toContain(`shell ime disable ${AUTO_MOBILE_IME_ID}`);
    await expect(withAndroidImeLock(h.device.deviceId, async () => true)).rejects.toThrow(
      "IME state is unknown",
    );
    // The mutex released even though quarantine was retained.
    expect(
      await withAndroidImeLock(h.device.deviceId, async () => true, undefined, {
        allowQuarantined: true,
      }),
    ).toBe(true);
    h.client.commitViaIme = commit;
    expect((await h.action.execute([type])).error).toContain("IME state is unknown");
    // Model verified explicit setIme recovery before clearing the quarantine.
    await h.adbFactory.create(h.device).execute(["shell", "ime", "set", capturedIme]);
    clearAndroidImeQuarantine(h.device.deviceId);
    expect((await h.action.execute([type])).success).toBe(true);
    expect(await withAndroidImeLock(h.device.deviceId, async () => true)).toBe(true);
  } finally {
    clearAndroidImeQuarantine(h.device.deviceId);
  }
});

test("budget expiry during final observation preserves acknowledged command success", async () => {
  const h = harness();
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const action = new SendKeys(h.device, h.adbFactory, {
    executor: h.executor,
    timer: h.timer,
    timestampProvider: { now: async () => 1 },
    observer: {
      execute: async (options) => {
        entered();
        if (!options?.signal) {
          throw new Error("No budget cancellation signal was supplied");
        }
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        options.signal.throwIfAborted();
        return observer.execute();
      },
    },
  });
  const pending = runWithTextRequestContext({ getDeadlineMs: () => 120_000 }, () =>
    action.execute([type]),
  );
  await started;
  h.timer.advanceTime(99_000);
  expect(await pending).toMatchObject({ success: true, completedCommands: 1 });
  expect((await pending).warning).toContain("before final observation completed");
  expect((await pending).failedIndex).toBeUndefined();
  expect(await withAndroidImeLock(h.device.deviceId, async () => true)).toBe(true);
});

test("a confirmed refusal at the budget boundary remains a failure rather than indeterminate", async () => {
  const h = harness();
  h.client.commitViaIme = async () => {
    h.timer.advanceTime(99_000);
    return { success: false, error: "Editor refused the commit" };
  };
  const result = await budgeted(h);
  expect(result).toMatchObject({ success: false, completedCommands: 0, failedIndex: 0 });
  expect(result.error).toBe("Editor refused the commit");
  expect(result.error).not.toContain("indeterminate");
  expect(result.warning).toContain("99 command(s) not sent");
  expect(result.commands).toHaveLength(1);
});

test.each(["continuous", "stopped"])("progress extension: %s", async (progress) => {
  const h = harness();
  let deadlineMs = 120_000;
  const result = await runWithTextRequestContext({ getDeadlineMs: () => deadlineMs }, () =>
    h.action.execute(commands, undefined, async (index) => {
      if (index === commands.length) {
        return;
      }
      // FakeTimer callbacks deliberately run without AsyncLocalStorage's request context.
      runOutsideRequestContext(() => h.timer.advanceTime(1350));
      if (progress === "continuous" || index < 20) {
        deadlineMs = Math.min(300_000, h.timer.now() + 120_000);
      }
    }),
  );
  if (progress === "continuous") {
    expect(result).toMatchObject({ success: true, completedCommands: 100 });
    expect(h.timer.now()).toBe(135_000);
    expect(h.committed).toHaveLength(100);
  } else {
    expect(result.success).toBe(false);
    expect(result.completedCommands).toBeGreaterThan(66);
    expect(result.completedCommands).toBeLessThan(100);
    expect(h.timer.now()).toBeGreaterThanOrEqual(deadlineMs - 21_000);
    expect(h.timer.now()).toBeLessThan(deadlineMs);
    expect(result.error).not.toContain("indeterminate");
    expect(result.retryable).toBe(false);
  }
  expect(h.timer.getPendingTimeoutCount()).toBe(0);
});

test("budget expiry during IME read-back counts acknowledged delivery without claiming verification", async () => {
  const h = harness();
  const readback = {
    execute: async () => {
      h.timer.advanceTime(99_000);
      return observer.execute();
    },
  };
  const action = new SendKeys(h.device, h.adbFactory, {
    executor: new DefaultSendKeysCommandExecutor(h.device, h.adbFactory, readback, {
      textClient: h.client,
      timer: h.timer,
    }),
    observer,
    timer: h.timer,
    timestampProvider: { now: async () => 1 },
  });
  const result = await runWithTextRequestContext({ getDeadlineMs: () => 120_000 }, () =>
    action.execute([type, type]),
  );
  expect(result).toMatchObject({
    success: false,
    completedCommands: 1,
    failedIndex: 1,
    retryable: false,
  });
  expect(result.commands).toHaveLength(1);
  expect(result.commands[0]).toMatchObject({ success: true });
  expect(result.warning).toContain("acknowledged but not verified");
  expect(result.error).toContain("1 command(s) not sent");
  expect(result.error).not.toContain("not acknowledged");
  expect(h.committed).toEqual(["x"]);
  expect(await withAndroidImeLock(h.device.deviceId, async () => true)).toBe(true);
});

test.each([true, false])(
  "unexpected errors retain their identity with deadline=%s",
  async (deadline) => {
    const h = harness();
    const failure = new AggregateError([new Error("original")], "original failure");
    const action = new SendKeys(h.device, h.adbFactory, {
      executor: h.executor,
      observer,
      timer: h.timer,
      focuser: {
        focus: async () => {
          throw failure;
        },
      },
    });
    const run = () => action.execute([type], { text: "field" });
    const pending = deadline
      ? runWithTextRequestContext({ getDeadlineMs: () => 120_000 }, run)
      : run();
    await expect(pending).rejects.toBe(failure);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  },
);
