import { describe, expect, test } from "bun:test";
import { BootConcurrencyGate } from "../../src/features/iosSimFleet/BootConcurrencyGate";
import type { TeardownDeviceArgs } from "../../src/features/deviceLifecycle/deviceLifecycleCore";
import { ActionableError } from "../../src/models/ActionableError";
import {
  createLifecycleHandlers,
  IOS_DELETE_CONCURRENCY,
  SIMCTL_TIMEOUT_RETRY_AFTER_MS,
  typedTeardownRefusal,
} from "../../src/server/deviceToolsLifecycle";
import { SimctlCommandTimeoutError } from "../../src/utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import { FakeTimer } from "../fakes/FakeTimer";

// #15308: 31 deleteDevice calls at once, 0.2 s apart, left 16 `daemon_stalled` and 9 non-retryable
// "Failed to kill ios device: SimctlCommandTimeoutError ... simctl list devices --json".

const args = (stableId: string, platform: "ios" | "android" = "ios"): TeardownDeviceArgs => ({
  target: { platform, isVirtual: true, stableId },
  mode: "destroy",
  verifyAbsence: true,
  timeoutMs: 60_000,
});

type Failure = { retryable?: boolean; retryAfterMs?: number; code?: string; reason?: string };

function failureOf(response: { content: Array<{ text: string }> } | undefined): Failure {
  return (JSON.parse(response!.content[0]!.text) as { failure: Failure }).failure;
}

describe("deleteDevice: a simctl timeout is a retryable failure (#15308)", () => {
  const timeout = new SimctlCommandTimeoutError(
    "Command timed out after 10000ms: xcrun simctl list devices --json",
  );

  test("the wrapped kill failure keeps its cause and is typed retryable with a wait hint", () => {
    const wrapped = new ActionableError(`Failed to kill ios device: ${timeout}`, {
      cause: timeout,
    });

    const failure = failureOf(typedTeardownRefusal(args("UDID-1"), wrapped, undefined, "stop"));

    expect(failure).toMatchObject({
      code: "operation_failed",
      retryable: true,
      retryAfterMs: SIMCTL_TIMEOUT_RETRY_AFTER_MS,
      reason: "simctl_timeout",
    });
  });

  test("a bare timeout from any phase is retryable too", () => {
    expect(failureOf(typedTeardownRefusal(args("UDID-1"), timeout)).retryable).toBe(true);
  });

  test("an unrelated failure is still not typed", () => {
    expect(typedTeardownRefusal(args("UDID-1"), new Error("boom"))).toBeUndefined();
  });
});

describe("deleteDevice: iOS deletes are bounded and queue the rest (#15308)", () => {
  function harness(gate: BootConcurrencyGate, android = false) {
    const timer = new FakeTimer();
    let running = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const service = {
      teardown: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => releases.push(resolve));
        running -= 1;
        return { content: [{ type: "text", text: "{}" }] };
      },
    };
    const { executeDeleteDevice } = createLifecycleHandlers({ iosDeleteGate: gate });
    const run = (id: string, signal?: AbortSignal) =>
      executeDeleteDevice(
        args(id, android ? "android" : "ios"),
        { timer } as never,
        signal,
        service as never,
      );
    return {
      run,
      peak: () => peak,
      running: () => running,
      finishOne: async () => {
        releases.shift()?.();
        await tick();
      },
    };
  }

  async function tick(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
  }

  test("31 simultaneous deletes never run more than the limit at once and all complete", async () => {
    const h = harness(new BootConcurrencyGate(IOS_DELETE_CONCURRENCY));
    const all = Array.from({ length: 31 }, (_, i) => h.run(`UDID-${i}`));
    await tick();
    expect(h.running()).toBe(IOS_DELETE_CONCURRENCY);

    for (let finished = 0; finished < 31; finished++) {
      await h.finishOne();
      expect(h.running()).toBeLessThanOrEqual(IOS_DELETE_CONCURRENCY);
    }
    await Promise.all(all);
    expect(h.peak()).toBe(IOS_DELETE_CONCURRENCY);
  });

  test("a queued caller that gives up leaves the queue with a cancelled result", async () => {
    const h = harness(new BootConcurrencyGate(1));
    const first = h.run("UDID-A");
    await tick();
    const controller = new AbortController();
    const queued = h.run("UDID-B", controller.signal);
    await tick();

    controller.abort(new Error("caller gave up"));
    const result = await queued;
    expect(failureOf(result as never).code).toBe("operation_cancelled");

    await h.finishOne();
    await first;
    expect(h.running()).toBe(0);
  });

  test("android deletes are not queued behind the iOS limit", async () => {
    const h = harness(new BootConcurrencyGate(1), true);
    const runs = [h.run("avd-1"), h.run("avd-2"), h.run("avd-3")];
    await tick();
    expect(h.running()).toBe(3);
    for (let i = 0; i < 3; i++) {
      await h.finishOne();
    }
    await Promise.all(runs);
  });
});
