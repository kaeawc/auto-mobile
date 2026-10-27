import { createExecResult } from "../../../src/utils/execResult";
import type { ExecResult } from "../../../src/models";
import { afterEach, beforeEach, mock, describe, expect, spyOn, test } from "bun:test";
import {
  executeAndroidInputText,
  INPUT_TEXT_CONSUME_MARGIN_MS,
  INPUT_TEXT_HOST_WAIT_PER_CHAR_MS,
  INPUT_TEXT_CONSUME_PER_CHAR_MS,
  INPUT_TEXT_SETTLEMENT_BASE_MS,
  INPUT_TEXT_SETTLEMENT_PER_CHAR_MS,
} from "../../../src/utils/android-cmdline-tools/AndroidInputText";
import { buildAndroidInputTextCommand } from "../../../src/utils/android-cmdline-tools/asciiKeyEvents";
import { runWithAbortSignal } from "../../../src/utils/AbortContext";
import { logger } from "../../../src/utils/logger";
import {
  AdbClient,
  AdbCommandTimeoutError,
} from "../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { defaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeGuestInputAdb } from "../../fakes/FakeGuestInputAdb";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";

const drainMs = (chars: number) =>
  chars * INPUT_TEXT_CONSUME_PER_CHAR_MS + INPUT_TEXT_CONSUME_MARGIN_MS;

describe("tracked Android input text", () => {
  const settlementMs = INPUT_TEXT_SETTLEMENT_BASE_MS + 5 * INPUT_TEXT_SETTLEMENT_PER_CHAR_MS;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    mock.restore();
  });

  function start(
    chunks?: string[],
    apiLevel: number | null = 30,
    textLength = 5,
    timeoutMs?: number,
  ) {
    const adb = new FakeGuestInputAdb();
    adb.setAndroidApiLevel(apiLevel);
    if (chunks) {
      adb.stdoutChunks = chunks;
    }
    const timer = new FakeTimer();
    const controller = new AbortController();
    const error = new Error("original cancellation");
    let settled = false;
    const result = executeAndroidInputText(adb, timer, buildAndroidInputTextCommand("a b'$"), {
      apiLevel,
      textLength,
      timeoutMs,
      noRetry: false,
      signal: controller.signal,
      logLabel: "shell input <password key event>",
    });
    const outcome = result.then(
      (value) => {
        settled = true;
        return value;
      },
      (failure: unknown) => {
        settled = true;
        return failure;
      },
    );
    const abort = () => {
      controller.abort(error);
      adb.host.reject(error);
    };
    // API 31+: a request cancel must not reach the host adb client (killing it kills `cmd`).
    const cancel = () => controller.abort(error);
    return {
      adb,
      timer,
      controller,
      error,
      result,
      outcome,
      abort,
      cancel,
      settled: () => settled,
    };
  }

  test.each([31, 34, null])(
    "API %s cancel keeps the host client attached and settles when typing completes",
    async (apiLevel) => {
      const h = start(undefined, apiLevel);
      h.adb.setTypingDuration(h.timer, 150);
      await h.adb.entered.promise;
      // The host adb client is the only handle on the binder client: it must not see the abort.
      const hostSignal = h.adb.dispatchOptions[0].signal;
      expect(hostSignal).not.toBe(h.controller.signal);
      h.cancel();
      await drainMicrotasks(50);
      expect(h.settled()).toBe(false);
      expect(h.adb.isTyping()).toBe(true);
      expect(hostSignal?.aborted).toBe(false);
      h.timer.advanceTime(149);
      await drainMicrotasks(50);
      expect(h.settled()).toBe(false);
      h.timer.advanceTime(1);
      await drainMicrotasks(50);
      // Host exit is not "typing done": the drain wait follows it.
      expect(h.settled()).toBe(false);
      h.timer.advanceTime(5 * INPUT_TEXT_CONSUME_PER_CHAR_MS + INPUT_TEXT_CONSUME_MARGIN_MS);
      expect(await h.outcome).toBe(h.error);
      expect(h.adb.isTyping()).toBe(false);
      expect(h.adb.cleanupCalls).toEqual([]);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("API 31+ cancel holds past host exit until the app has consumed the events (#12599)", async () => {
    const h = start(undefined, 34);
    // The host cmd client exits at 150 ms; the app is still consuming until 400 ms.
    h.adb.setTypingDuration(h.timer, 400, 150);
    await h.adb.entered.promise;
    h.cancel();
    h.timer.advanceTime(150);
    await drainMicrotasks(50);
    expect(h.settled()).toBe(false);
    const settleMs = 5 * INPUT_TEXT_CONSUME_PER_CHAR_MS + INPUT_TEXT_CONSUME_MARGIN_MS;
    h.timer.advanceTime(settleMs - 1);
    await drainMicrotasks(50);
    expect(h.settled()).toBe(false);
    h.timer.advanceTime(1);
    expect(await h.outcome).toBe(h.error);
    expect(h.adb.isTyping()).toBe(false);
  });

  test("API 31+ success paces the call to the app's consumption rate", async () => {
    const h = start(undefined, 34, 32);
    h.adb.setTypingDuration(h.timer, 100);
    await h.adb.entered.promise;
    h.timer.advanceTime(100);
    await drainMicrotasks(50);
    const paceMs = 32 * INPUT_TEXT_CONSUME_PER_CHAR_MS;
    h.timer.advanceTime(paceMs - 100 - 1);
    await drainMicrotasks(50);
    expect(h.settled()).toBe(false);
    h.timer.advanceTime(1);
    expect(await h.result).toMatchObject({ stdout: "", stderr: "" });
  });

  test("API 31+ cancel while pacing still settles before rethrowing", async () => {
    const h = start(undefined, 34, 32);
    h.adb.setTypingDuration(h.timer, 100);
    await h.adb.entered.promise;
    h.timer.advanceTime(100);
    await drainMicrotasks(50);
    h.cancel();
    await drainMicrotasks(50);
    const settleMs = 32 * INPUT_TEXT_CONSUME_PER_CHAR_MS + INPUT_TEXT_CONSUME_MARGIN_MS;
    h.timer.advanceTime(settleMs - 1);
    await drainMicrotasks(50);
    expect(h.settled()).toBe(false);
    h.timer.advanceTime(1);
    expect(await h.outcome).toBe(h.error);
  });

  test("API 31+ command timeout also waits for the host and keeps the timeout error type", async () => {
    const h = start(undefined, 34, 5, 1000);
    h.adb.setTypingDuration(h.timer, 2000);
    await h.adb.entered.promise;
    // Never the adb client's 15 s default: that would kill `cmd` while it is still typing.
    expect(h.adb.dispatchOptions[0].timeoutMs).toBe(
      1000 + 3000 + 5 * INPUT_TEXT_HOST_WAIT_PER_CHAR_MS,
    );
    h.timer.advanceTime(1000);
    await drainMicrotasks(50);
    expect(h.settled()).toBe(false);
    h.timer.advanceTime(1000);
    await drainMicrotasks(50);
    h.timer.advanceTime(drainMs(5));
    expect(await h.outcome).toBeInstanceOf(AdbCommandTimeoutError);
  });

  test("API 31+ cancel before the guest starts aborts the host so it cannot type late", async () => {
    const h = start([], 34);
    await h.adb.entered.promise;
    h.cancel();
    expect(await h.outcome).toBe(h.error);
    expect(h.adb.dispatchOptions[0].signal?.aborted).toBe(true);
  });

  test("API 31+ stuck host is aborted once the hold expires", async () => {
    const h = start(undefined, 34);
    await h.adb.entered.promise;
    h.cancel();
    await drainMicrotasks(50);
    const hostSignal = h.adb.dispatchOptions[0].signal;
    expect(hostSignal?.aborted).toBe(false);
    h.timer.advanceTime(3000 + 5 * INPUT_TEXT_HOST_WAIT_PER_CHAR_MS);
    await drainMicrotasks(50);
    expect(hostSignal?.aborted).toBe(true);
    h.timer.advanceTime(drainMs(5));
    expect(await h.outcome).toBe(h.error);
  });

  test("API 31+ dispatch runs outside the ambient request signal", async () => {
    const request = new AbortController();
    const adb = new FakeGuestInputAdb();
    adb.setAndroidApiLevel(34);
    const timer = new FakeTimer();
    const done = runWithAbortSignal(request.signal, () =>
      executeAndroidInputText(adb, timer, buildAndroidInputTextCommand("abc"), {
        apiLevel: 34,
        textLength: 3,
      }),
    );
    await adb.entered.promise;
    expect(adb.ambientSignals).toEqual([undefined]);
    adb.host.resolve(createExecResult("", ""));
    await drainMicrotasks(50);
    timer.advanceTime(3 * INPUT_TEXT_CONSUME_PER_CHAR_MS);
    await done;
  });

  test("API 31+ host failure on its own is rethrown without a settlement wait", async () => {
    const h = start(undefined, 34);
    await h.adb.entered.promise;
    const failure = new Error("adb transport died");
    h.adb.host.reject(failure);
    expect(await h.outcome).toBe(failure);
    expect(h.adb.cleanupCalls).toEqual([]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("API 31+ pre-aborted signal never dispatches", async () => {
    const adb = new FakeGuestInputAdb();
    const reason = new Error("already cancelled");
    const controller = new AbortController();
    controller.abort(reason);
    const failure = await executeAndroidInputText(
      adb,
      new FakeTimer(),
      buildAndroidInputTextCommand("abc"),
      { apiLevel: 34, textLength: 3, signal: controller.signal },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBe(reason);
    expect(adb.getExecutedArgv()).toEqual([]);
  });

  test.each(["throw", "timeout"])("pre-31 kill is retried after probe %s", async (failure) => {
    const h = start();
    h.adb.cleanupError =
      failure === "timeout"
        ? new AdbCommandTimeoutError("probe timeout")
        : new Error("probe failed");
    await h.adb.entered.promise;
    h.abort();
    await drainUntil(() => h.timer.getPendingSleepCount() > 0, { description: "failed probe" });
    h.timer.advanceTime(75);
    await drainUntil(() => h.adb.cleanupCalls.length === 2, { description: "retry probe" });
    expect(h.adb.cleanupCalls[1].args[1]).toContain("kill 4242");
    await drainUntil(() => h.timer.getPendingSleepCount() > 0, { description: "failed retry" });
    h.adb.cleanupError = undefined;
    h.timer.advanceTime(75);
    await drainUntil(() => h.adb.cleanupCalls.length === 3, { description: "successful retry" });
    expect(h.adb.cleanupCalls[2].args[1]).toContain("kill 4242");
    await drainUntil(() => h.timer.getPendingSleepCount() > 0, { description: "successful probe" });
    h.adb.guest = "gone";
    h.timer.advanceTime(75);
    expect(await h.outcome).toBe(h.error);
    expect(h.adb.cleanupCalls[3].args[1]).not.toContain("kill ");
  });

  test.each([
    [1, 3000 + INPUT_TEXT_HOST_WAIT_PER_CHAR_MS],
    [1000, 3000 + 1000 * INPUT_TEXT_HOST_WAIT_PER_CHAR_MS],
    [100000, 60000],
  ])("API 31+ length %s gets a %sms host wait deadline", async (length, cap) => {
    const h = start(undefined, 34, length);
    await h.adb.entered.promise;
    h.cancel();
    await drainMicrotasks(50);
    expect(h.timer.getPendingTimeouts()).toContain(cap);
    h.timer.advanceTime(cap - 1);
    await drainMicrotasks(20);
    expect(h.settled()).toBe(false);
    h.timer.advanceTime(1);
    await drainMicrotasks(50);
    h.timer.advanceTime(drainMs(length));
    expect(await h.outcome).toBe(h.error);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`after ${cap}ms`), expect.any(Error));
  });

  test.each([
    [1, 3004],
    [1000, 7000],
    [100000, 30000],
  ])("pre-31 length %s gets a %sms settlement deadline", async (length, cap) => {
    const h = start(undefined, 30, length);
    await h.adb.entered.promise;
    h.abort();
    await drainUntil(() => h.timer.getPendingSleepCount() > 0, { description: "scaled deadline" });
    expect(h.timer.getPendingTimeouts()).toContain(cap);
    h.timer.advanceTime(cap - 1);
    await drainMicrotasks(20);
    expect(h.settled()).toBe(false);
    h.timer.advanceTime(1);
    expect(await h.outcome).toBe(h.error);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`after ${cap}ms`), expect.any(Error));
  });

  test("a probe rejecting after deadline is debug-logged and preserves cancellation", async () => {
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const h = start();
    const probe = Promise.withResolvers<ExecResult>();
    h.adb.cleanupResult = probe.promise;
    try {
      await h.adb.entered.promise;
      h.abort();
      await drainUntil(() => h.adb.cleanupCalls.length > 0, { description: "pending probe" });
      h.timer.advanceTime(settlementMs);
      expect(await h.outcome).toBe(h.error);
      const lateError = new Error("probe aborted");
      probe.reject(lateError);
      await drainUntil(() => debug.mock.calls.length > 0, { description: "late probe log" });
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining("after settlement deadline"),
        lateError,
      );
      expect(h.adb.cleanupCalls).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("deadline expired"),
        expect.any(Error),
      );
    } finally {
      debug.mockRestore();
    }
  });

  test.each([30, 31, 34])("API %s selects its dispatch on the host", async (apiLevel) => {
    const h = start(undefined, apiLevel);
    await h.adb.entered.promise;
    h.adb.host.resolve(createExecResult("", ""));
    await drainMicrotasks(50);
    h.timer.advanceTime(5 * INPUT_TEXT_CONSUME_PER_CHAR_MS);
    await h.result;
    const quoted = buildAndroidInputTextCommand("a b'$").slice("shell ".length);
    expect(h.adb.getExecutedArgv()).toEqual([
      ["shell", `echo $$; exec ${apiLevel >= 31 ? "cmd " : ""}${quoted}`],
    ]);
  });

  test("guest outlives host abort and holds follow-up until it exits", async () => {
    const h = start();
    await h.adb.entered.promise;
    h.abort();
    let followUp = false;
    const next = h.outcome.then(() => {
      followUp = true;
    });
    await drainUntil(() => h.timer.getPendingSleepCount() > 0, { description: "guest poll" });
    expect(h.settled()).toBe(false);
    expect(followUp).toBe(false);
    h.timer.advanceTime(75);
    await drainMicrotasks(20);
    expect(h.settled()).toBe(false);
    h.adb.guest = "gone";
    h.timer.advanceTime(75);
    expect(await h.outcome).toBe(h.error);
    await next;
    expect(followUp).toBe(true);
    expect(h.adb.cleanupCalls.filter(({ args }) => args[1].includes("kill 4242"))).toHaveLength(1);
    for (const { args, options } of h.adb.cleanupCalls) {
      expect(args).toHaveLength(2);
      expect(args[1]).toContain("[ -r /proc/4242/cmdline ]");
      expect(args[1]).toContain("tr '\\0' ' '");
      expect(args[1]).toContain('case "$cmdline" in');
      expect(args[1]).not.toMatch(/pkill|killall|pidof|\/proc\/(?!4242)/);
      expect(args[1]).not.toContain("*input text*");
      expect(options.signal?.aborted).toBe(false);
      expect(options.noRetry).toBe(true);
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeLessThanOrEqual(500);
    }
  });

  test("never-exiting guest is bounded and preserves the original error", async () => {
    const h = start();
    await h.adb.entered.promise;
    h.abort();
    await drainUntil(() => h.timer.getPendingSleepCount() > 0, { description: "guest poll" });
    h.timer.advanceTime(settlementMs - 1);
    await drainMicrotasks(20);
    expect(h.settled()).toBe(false);
    h.timer.advanceTime(1);
    expect(await h.outcome).toBe(h.error);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deadline"), expect.any(Error));
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each(["recycled", "gone"] as const)(
    "%s PID counts as gone without polling",
    async (guest) => {
      const h = start();
      h.adb.guest = guest;
      await h.adb.entered.promise;
      h.abort();
      expect(await h.outcome).toBe(h.error);
      expect(h.adb.cleanupCalls).toHaveLength(1);
      const script = h.adb.cleanupCalls[0].args[1];
      expect(script.indexOf('case "$cmdline" in')).toBeLessThan(script.indexOf("kill 4242"));
      expect(script).toContain("/system/bin/cmd input text ");
      expect(script).not.toMatch(/(?:in |\|)\*\) kill/);
    },
  );

  test.each([
    [],
    ["invalid\n4242\n"],
    ["0\n"],
    ["9".repeat(100)],
    ["0".repeat(32) + "1"],
    ["4242"],
    ["9999999999999999999\n"],
  ])("missing or invalid first PID line %j uses host settlement and warns", async (...chunks) => {
    const h = start(chunks);
    await h.adb.entered.promise;
    expect(h.adb.dispatchOptions[0].waitForProcessSettlementAfterAbort).toBe(true);
    h.abort();
    expect(await h.outcome).toBe(h.error);
    expect(h.adb.cleanupCalls).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("PID"));
  });

  test("success costs no guard round trip and keeps result, quoting and redaction", async () => {
    const h = start();
    await h.adb.entered.promise;
    const result = createExecResult("4242\n", "");
    h.adb.host.resolve(result);
    expect(await h.result).toBe(result);
    expect(h.adb.cleanupCalls).toEqual([]);
    const argv = h.adb.getExecutedArgv()[0];
    expect(argv).toHaveLength(2);
    expect(argv[1]).toContain("echo $$;");
    expect(argv[1]).toContain("a%sb");
    const quoted = buildAndroidInputTextCommand("a b'$").slice("shell ".length);
    expect(argv[1]).toBe(`echo $$; exec ${quoted}`);
    expect(h.adb.dispatchOptions[0].logLabel).toBe("shell input <password key event>");
    expect(h.adb.dispatchOptions[0].noRetry).toBe(true);
  });

  test.each([false, true])(
    "cleanup failure/hang=%s cannot replace the dispatch error or exceed deadline",
    async (hangs) => {
      const h = start();
      h.adb.cleanupHangs = hangs;
      h.adb.cleanupError = new Error("cleanup failed");
      await h.adb.entered.promise;
      // Failure without an aborted signal must also clean up.
      h.adb.host.reject(h.error);
      await drainUntil(() => h.adb.cleanupCalls.length > 0, { description: "guard" });
      h.timer.advanceTime(settlementMs);
      expect(await h.outcome).toBe(h.error);
      expect(warn).toHaveBeenCalled();
    },
  );

  test("a host timeout without request cancellation also holds for guest settlement", async () => {
    const h = start();
    const timeout = new AdbCommandTimeoutError("original text timeout");
    await h.adb.entered.promise;
    h.adb.host.reject(timeout);
    await drainUntil(() => h.timer.getPendingSleepCount() > 0, { description: "timeout cleanup" });
    expect(h.controller.signal.aborted).toBe(false);
    expect(h.settled()).toBe(false);
    h.adb.guest = "gone";
    h.timer.advanceTime(75);
    expect(await h.outcome).toBe(timeout);
  });

  test("password dispatch keeps the wrapper and payload out of real AdbClient logs/errors", async () => {
    const timer = new FakeTimer();
    const spies = [
      spyOn(logger, "debug").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    const secret = "private-payload'$";
    const adb = new AdbClient(
      null,
      async (_file: string, args: string[]) => {
        throw Object.assign(new Error(`Command failed: adb ${args.join(" ")}`), {
          cmd: args.join(" "),
        });
      },
      { retryExecutor: defaultRetryExecutor, timer },
    );
    try {
      const result = await executeAndroidInputText(
        adb,
        timer,
        buildAndroidInputTextCommand(secret),
        {
          apiLevel: 34,
          textLength: secret.length,
          logLabel: "shell input <password key event>",
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(Error);
      const failure = result as Error & { cmd?: string };
      const surfaced = [
        failure.message,
        failure.stack,
        failure.cmd,
        JSON.stringify([...spies, warn].map((spy) => spy.mock.calls)),
      ].join("\n");
      expect(surfaced).not.toContain("private-payload");
      expect(surfaced).not.toContain("echo $$");
      expect(surfaced).toContain("shell input <password key event>");
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  test("the shared fake emits configured stdout even when its host command fails", async () => {
    const adb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const error = new Error("host failed");
    adb.setCommandStdoutChunks("echo $$", ["4242\n"]);
    adb.setCommandError("echo $$", error);
    expect(
      await executeAndroidInputText(adb, timer, buildAndroidInputTextCommand("abc"), {
        apiLevel: 30,
        textLength: 3,
      }).then(
        () => undefined,
        (failure: unknown) => failure,
      ),
    ).toBe(error);
    expect(adb.getExecutedArgv()).toHaveLength(2);
    expect(adb.getExecutedArgv()[1][1]).toContain("/proc/4242/cmdline");
  });
});
