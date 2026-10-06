import { expect, spyOn, test } from "bun:test";
import {
  SendKeys,
  DefaultSendKeysCommandExecutor,
  type SendKeysCommand,
  type TextActionResult,
} from "../../../src/features/action/SendKeys";
import {
  clearAndroidImeQuarantine,
  withAndroidImeLock,
} from "../../../src/features/action/androidImeLock";
import { AndroidImeCatalog, imeCapabilities } from "../../../src/features/action/AndroidImeCatalog";
import { runWithTextRequestContext } from "../../../src/features/action/textTransportTimeout";
import { getAbortSignal, runWithAbortSignal } from "../../../src/utils/AbortContext";
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
  return runWithTextRequestContext({ getDeadlineMs: () => h.timer.now() + 120_000 }, () =>
    h.action.execute(list),
  );
}

test("budget exhaustion between commands reports delivered and not-sent counts and releases IME lock", async () => {
  const h = harness();
  const result = await runWithTextRequestContext(
    { getDeadlineMs: () => h.timer.now() + 120_000 },
    () =>
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
  expect(h.committed).toEqual([]);
  expect((await h.action.execute([type])).success).toBe(true);
});

test.each(["safe", "AutoMobile", "unreadable", "disabled", "different", "subtype"])(
  "lost cancellation recovery: %s readback",
  async (state) => {
    const h = harness();
    let prior: string | null = null;
    const commit = h.client.commitViaIme;
    h.client.commitViaIme = async (_text, priorIme) => {
      prior = priorIme;
      return { success: false, partialApplication: true, sessionUnsafe: true };
    };
    let restoreMocks = () => {};
    try {
      expect((await h.action.execute([type])).success).toBe(false);
      h.client.commitViaIme = commit;
      if (state === "safe") {
        // Reuse the captured prior component, rather than inventing device output.
        await h.adbFactory.create(h.device).execute(["shell", "ime", "set", String(prior)]);
      } else if (["disabled", "different", "subtype"].includes(state)) {
        const imeId = String(prior);
        const list = spyOn(AndroidImeCatalog.prototype, "list").mockResolvedValue({
          activeImeId: state === "different" ? null : imeId,
          installed: [
            {
              id: imeId,
              enabled: state !== "disabled",
              active: true,
              capabilities: imeCapabilities(imeId),
            },
          ],
        });
        const subtype = spyOn(AndroidImeCatalog.prototype, "readSubtype").mockResolvedValue({
          id: 42,
        });
        restoreMocks = () => {
          list.mockRestore();
          subtype.mockRestore();
        };
      } else if (state === "unreadable") {
        h.adb.execute = async () => {
          throw new Error("read unavailable");
        };
      }
      const next = await h.action.execute([type]);
      expect(next.success).toBe(state === "safe");
      if (state !== "safe") {
        expect(next.error).toContain("IME state is unknown");
        await expect(withAndroidImeLock(h.device.deviceId, async () => true)).rejects.toThrow(
          "IME state is unknown",
        );
      } else {
        expect(await withAndroidImeLock(h.device.deviceId, async () => true)).toBe(true);
      }
    } finally {
      restoreMocks();
      clearAndroidImeQuarantine(h.device.deviceId);
    }
  },
);

test("without request context, the existing caller-controlled behaviour is preserved", async () => {
  const h = harness();
  const commit = h.client.commitViaIme;
  h.client.commitViaIme = async (...args) => {
    h.timer.advanceTime(1500);
    return commit(...args);
  };
  expect(await h.action.execute(commands)).toMatchObject({ success: true, completedCommands: 100 });
});

test("budget cancellation with lost acknowledgement self-heals only after the device restores the captured IME", async () => {
  const h = harness();
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const commit = h.client.commitViaIme;
  h.client.commitViaIme = async (_text, prior, signal) => {
    entered();
    if (!signal) {
      return { success: false, error: "No budget cancellation signal was supplied" };
    }
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    // Simulate the existing device-side restoration after the host loses cancel-ack.
    await h.adbFactory.create(h.device).execute(["shell", "ime", "set", String(prior)]);
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
    // The mutex released even though quarantine was retained.
    expect(
      await withAndroidImeLock(h.device.deviceId, async () => true, undefined, {
        allowQuarantined: true,
      }),
    ).toBe(true);
    h.client.commitViaIme = commit;
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
