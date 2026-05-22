import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AwaitIdle } from "../../../src/features/observe/AwaitIdle";
import {
  RunHealthRecorder,
  __resetActiveRecorderForTests,
  clearActiveRecorder,
  setActiveRecorder,
} from "../../../src/features/diagnostics/RunHealthRecorder";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { BootedDevice } from "../../../src/models";

/**
 * Regression coverage for the AwaitIdle catch path → `recordAwaitIdle("error", ...)`.
 *
 * The polling loop in `waitForUiStabilityWithState` is wrapped in try/catch so
 * unexpected throws (abort signals, ADB blow-ups) don't crash the caller.
 * Pre-fix, those throws were silently bucketed as "timeout" — inflating
 * `timeoutRate`. Now the catch sets `errored=true` and the outcome is
 * recorded distinctly as "error" so operators can tell aborts from genuine
 * stability timeouts.
 *
 * We force the catch by passing an already-aborted signal, which makes the
 * first `throwIfAborted(signal)` call inside the loop throw.
 */

const fakeDevice: BootedDevice = {
  name: "Test Device",
  deviceId: "emulator-5554",
  platform: "android",
};


describe("AwaitIdle records 'error' outcome distinctly from 'timeout'", function() {

  let recorder: RunHealthRecorder;


  beforeEach(function() {
    __resetActiveRecorderForTests();
    recorder = new RunHealthRecorder({
      sessionId: "awaitidle-error-test",
      timer: new FakeTimer(),
    });
    setActiveRecorder(recorder);
  });


  afterEach(function() {
    clearActiveRecorder(recorder);
    __resetActiveRecorderForTests();
  });


  test("aborted signal inside the polling loop records 'error', not 'timeout'", async function() {
    const fakeAdb = new FakeAdbExecutor();
    const timer = new FakeTimer();
    const awaitIdle = new AwaitIdle(fakeDevice, fakeAdb, timer);

    const controller = new AbortController();
    controller.abort();

    await awaitIdle.waitForUiStabilityWithState(
      "com.example.app",
      5000,
      {
        startTime: timer.now(),
        lastNonIdleTime: timer.now(),
        prevMissedVsync: null,
        prevSlowUiThread: null,
        prevFrameDeadlineMissed: null,
        prevTotalFrames: null,
        firstGfxInfoLog: true,
      },
      undefined,
      controller.signal
    );

    const summary = recorder.finalize();
    expect(summary.awaitIdle.calls).toBe(1);
    expect(summary.awaitIdle.errors).toBe(1);
    expect(summary.awaitIdle.timeouts).toBe(0);
    expect(summary.awaitIdle.errorRate).toBe(1);
    expect(summary.awaitIdle.timeoutRate).toBe(0);
  });
});
