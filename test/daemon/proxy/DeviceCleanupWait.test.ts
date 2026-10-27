import { describe, expect, test } from "bun:test";
import {
  DEVICE_CLEANUP_WAIT_BUDGET_MS,
  DeviceCleanupWait,
  type DeviceCleanupWaitPort,
} from "../../../src/daemon/proxy/DeviceCleanupWait";
import type { ForwardedToolCall } from "../../../src/daemon/proxy/ToolCallForwarder";
import { FakeTimer } from "../../fakes/FakeTimer";
import { readDeviceCleanupInProgressRefusal } from "../../../src/daemon/deviceSessionResult";

const ok: ForwardedToolCall = { result: { content: [{ type: "text", text: "{}" }] } };

function refusal(retryAfterMs: number): ForwardedToolCall {
  const payload = {
    success: false,
    code: "device_cleanup_in_progress",
    retryAfterMs,
    error: "cleanup",
  };
  return {
    result: {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    },
  };
}

function setup(replies: ForwardedToolCall[], opts: { budgetMs?: number } = {}) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const state = { closing: false, reforwards: 0 };
  const port: DeviceCleanupWaitPort = {
    isClosing: () => state.closing,
    readCleanupRefusal: readDeviceCleanupInProgressRefusal,
    reforward: async () => {
      state.reforwards += 1;
      return replies.shift() ?? ok;
    },
  };
  const wait = new DeviceCleanupWait({ timer, budgetMs: opts.budgetMs });
  return { timer, state, port, wait };
}

describe("DeviceCleanupWait", () => {
  test("keeps the 150 s budget contract", () => {
    expect(DEVICE_CLEANUP_WAIT_BUDGET_MS).toBe(150_000);
  });

  test("returns a non-refusal untouched without reforwarding", async () => {
    const { wait, port, state } = setup([]);
    expect(await wait.waitOut(ok, "startDevice", port, undefined)).toBe(ok);
    expect(state.reforwards).toBe(0);
  });

  test("reforwards on a bounded poll until the cleanup settles", async () => {
    const { wait, port, state, timer } = setup([refusal(1_000), ok]);
    const out = await wait.waitOut(refusal(1_000), "startDevice", port, undefined);
    expect(out).toBe(ok);
    expect(state.reforwards).toBe(2);
    expect(timer.now()).toBeGreaterThanOrEqual(250);
  });

  test("returns the last refusal once the budget runs out", async () => {
    const last = refusal(1_000);
    const { wait, port, state } = setup([refusal(1_000), last], { budgetMs: 600 });
    const out = await wait.waitOut(refusal(1_000), "startDevice", port, undefined);
    expect(out).toBe(last);
    expect(state.reforwards).toBe(2);
  });

  test("stops polling when the proxy is closing", async () => {
    const { wait, port, state } = setup([]);
    state.closing = true;
    const first = refusal(1_000);
    expect(await wait.waitOut(first, "startDevice", port, undefined)).toBe(first);
    expect(state.reforwards).toBe(0);
  });
});
