import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";
import { executionTracker } from "../../src/daemon/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import {
  createFakeDaemonState,
  createFakeSession,
  createFakeDeviceManager,
} from "./helpers/inputSocketHarness";
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { screenshotPathProtection } from "../../src/features/observe/ScreenshotPathProtection";
import { TakeScreenshot } from "../../src/features/observe/TakeScreenshot";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../src/utils/logger";
import type { DaemonRequest } from "../../src/daemon/types";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";
import {
  harness,
  frame,
  holdDevice,
  runner,
  socketHarness,
  cancel,
  finishSockets,
  type Harness,
} from "../helpers/socketServerInputHoldHarness";
import { createIosTestClient } from "../helpers/iosCtrlProxyClientSpies";
import { createAndroidTestClient } from "../helpers/androidCtrlProxyClientSpies";

const variants = [
  "key android",
  "pressButton android back",
  "pressButton android volume_up",
  "pressButton ios",
  "tap android",
  "tap ios",
  "swipe android",
  "swipe ios",
] as const;
type Variant = (typeof variants)[number];
function variantPlatform(variant: Variant): "android" | "ios" {
  return variant.includes("android") ? "android" : "ios";
}
function inputFrame(variant: Variant, deviceId = "A"): DaemonRequest {
  const [route, platform, button] = variant.split(" ");
  return {
    id: deviceId,
    type: "mcp_request",
    method: `input/${route}`,
    timeoutMs: 1000,
    params: {
      platform,
      deviceId,
      ...(route === "key"
        ? { key: "enter" }
        : route === "pressButton"
          ? { button: button ?? "back" }
          : route === "tap"
            ? { x: 1, y: 2 }
            : { startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 300 }),
    },
  };
}
function runInput(handler: Harness, request: DaemonRequest, signal?: AbortSignal) {
  switch (request.method) {
    case "input/key":
      return handler.handleInputKey(request, undefined, { signal });
    case "input/pressButton":
      return handler.handleInputPressButton(request, undefined, { signal });
    case "input/tap":
      return handler.handleInputTap(request, undefined, { signal });
    default:
      return handler.handleInputSwipe(request, undefined, { signal });
  }
}
function transport(variant: Variant, first: ReturnType<typeof runner>, parked?: Promise<void>) {
  const android = createAndroidTestClient(holdDevice("android"));
  const ios = createIosTestClient(holdDevice("ios"));
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(android);
  spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(ios);
  spyOn(android, "getScreenScaleMetadata").mockReturnValue(null);
  spyOn(ios, "getScreenScaleMetadata").mockReturnValue(null);
  spyOn(ios, "requestHierarchySyncWithoutObservationStreamPush").mockResolvedValue({
    hierarchy: { updatedAt: 0, packageName: "fake.app", hierarchy: {} },
  });
  let attempts = 0;
  let sends = 0;
  const send = async (signal?: AbortSignal, dispatch?: () => void) => {
    const index = attempts++;
    if (index === 0) {
      await parked;
    }
    signal?.throwIfAborted();
    sends++;
    if (index === 0) {
      return first.send(signal, dispatch);
    }
    dispatch?.();
    return { success: true, totalTimeMs: 0, action: "runner" };
  };
  spyOn(android, "requestTapCoordinates").mockImplementation(
    ({ onDispatch: dispatch, signal: signal }) => send(signal, dispatch),
  );
  spyOn(android, "requestSwipe").mockImplementation(({ signal, onDispatch }) =>
    send(signal, onDispatch),
  );
  spyOn(ios, "requestTapCoordinates").mockImplementation(
    ({ signal: signal, onDispatch: dispatch }) => send(signal, dispatch),
  );
  spyOn(ios, "requestDrag").mockImplementation(({ signal, onDispatch }) =>
    send(signal, onDispatch),
  );
  spyOn(android, "requestGlobalAction").mockImplementation((_button, _timeout, _perf, options) =>
    send(options?.signal, options?.onDispatch),
  );
  spyOn(ios, "requestPressBack").mockImplementation((_timeout, _perf, _context, signal, dispatch) =>
    send(signal, dispatch),
  );
  const adb = new FakeAdbExecutor();
  spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
  spyOn(adb, "execute").mockImplementation(async (_args, options) => {
    const index = attempts++;
    if (index === 0) {
      await parked;
    }
    await options?.beforeDispatch?.(options.timeoutMs);
    options?.signal?.throwIfAborted();
    sends++;
    if (index === 0) {
      await first.send(options?.signal);
    }
    return createExecResult("", "");
  });
  return {
    android,
    ios,
    adb,
    get attempts() {
      return attempts;
    },
    get sends() {
      return sends;
    },
  };
}
const originalSetTimeout = defaultTimer.setTimeout;
const originalAdbCreate = defaultAdbClientFactory.create;
const originalAndroidGetInstance = AndroidCtrlProxyClient.getInstance;
const originalIosGetInstance = IOSCtrlProxyClient.getInstance;
let trackerTimer: FakeTimer;
beforeEach(() => {
  trackerTimer = new FakeTimer();
  spyOn(defaultTimer, "now").mockImplementation(() => trackerTimer.now());
  spyOn(defaultTimer, "setTimeout").mockImplementation(trackerTimer.setTimeout.bind(trackerTimer));
  spyOn(defaultTimer, "clearTimeout").mockImplementation(
    trackerTimer.clearTimeout.bind(trackerTimer),
  );
  spyOn(screenshotPathProtection, "start").mockImplementation(() => {});
  spyOn(screenshotPathProtection, "sweepOnce").mockResolvedValue(undefined);
  spyOn(TakeScreenshot, "getCacheDir").mockReturnValue("scratch/hold-lane/screenshots");
});
afterEach(() => {
  expect(trackerTimer.getPendingTimeoutCount()).toBe(0);
  expect(executionTracker.getActiveExecutionCount()).toBe(0);
  PlatformDeviceManagerFactory.reset();
  mock.restore();
  expect(defaultTimer.setTimeout).toBe(originalSetTimeout);
  expect(defaultAdbClientFactory.create).toBe(originalAdbCreate);
  expect(AndroidCtrlProxyClient.getInstance).toBe(originalAndroidGetInstance);
  expect(IOSCtrlProxyClient.getInstance).toBe(originalIosGetInstance);
  AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
  IOSCtrlProxyClient.clearInstanceRegistryForTesting();
  expect(AndroidCtrlProxyClient.getExistingInstance("A")).toBeNull();
  expect(IOSCtrlProxyClient.getExistingInstance("A")).toBeNull();
});
test.each(
  variants.flatMap((variant) =>
    ["reply", "error", "deadline"].map((end) => [variant, end] as const),
  ),
)("%s holds dispatched cancellation until %s", async (variant, end) => {
  const { handler, timer, stamps } = harness();
  const first = runner(end === "deadline");
  const fake = transport(variant, first);
  const owner = new AbortController();
  let answered = false;
  const a = runInput(handler, inputFrame(variant), owner.signal).finally(() => {
    answered = true;
  });
  void a.catch(() => {});
  await drainUntil(() => first.dispatched, { description: "first dispatch" });
  timer.advanceTime(200);
  const b = runInput(handler, { ...inputFrame(variant), id: "B", timeoutMs: 2000 });
  owner.abort(new Error("owner cancelled"));
  const other = runInput(handler, inputFrame(variant, "other"));
  await other;
  await drainMicrotasks(100);
  try {
    expect(answered).toBe(false);
    expect(fake.sends).toBe(2);
    expect(stamps.filter((id) => id === "A")).toEqual(["A"]);
    if (end === "deadline") {
      timer.advanceTime(799);
      await drainMicrotasks(100);
      expect(answered).toBe(false);
      timer.advanceTime(1);
    } else if (end === "error") {
      first.fail();
    } else {
      first.reply();
    }
    const failure = await a.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("Expected an indeterminate Error");
    }
    expect(failure.message.split("outcome is indeterminate")).toHaveLength(2);
    expect(failure.message.split("Do not retry automatically")).toHaveLength(2);
    expect(failure).toMatchObject({ requestDispatched: true });
    await b;
  } finally {
    first.reply();
    await Promise.allSettled([a, b, other]);
  }
  await drainMicrotasks(100);
  expect(handler.forwardTails.size).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});
test.each([...variants])(
  "%s cancels before dispatch without sending or stamping",
  async (variant) => {
    const { handler, timer, stamps } = harness();
    const first = runner();
    const parked = Promise.withResolvers<void>();
    const fake = transport(variant, first, parked.promise);
    const owner = new AbortController();
    const a = runInput(handler, inputFrame(variant), owner.signal);
    void a.catch(() => {});
    await drainUntil(() => fake.attempts === 1, { description: "parked before send" });
    owner.abort(new Error("before dispatch cancelled"));
    await expect(a).rejects.toThrow("before dispatch cancelled");
    await runInput(handler, inputFrame(variant));
    expect(stamps).toEqual(["A"]);
    expect(fake.sends).toBe(1);
    parked.resolve();
    await drainMicrotasks(100);
    expect(fake.sends).toBe(1);
    expect(first.dispatched).toBe(false);
    expect(handler.forwardTails.size).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  },
);
// daemon/cancelRequest is explicit cancellation; destroying a socket is the other owner abort.
test.each(
  variants.flatMap((variant) =>
    ["reply", "error", "deadline"].map((end) => [variant, end] as const),
  ),
)(
  "%s writes one indeterminate response after runner %s and immediate cancel ack",
  async (variant, end) => {
    const f = socketHarness();
    const first = runner(end === "deadline");
    transport(variant, first);
    f.socket.send(inputFrame(variant));
    await drainUntil(() => first.dispatched, { description: "wire dispatch" });
    cancel(f.socket, "A");
    await drainUntil(() => f.socket.responses.some((r) => r.id === "cancel"), {
      description: "cancel ack",
    });
    await drainMicrotasks(100);
    try {
      expect(f.socket.responses.find((r) => r.id === "A")).toBeUndefined();
    } finally {
      if (end === "deadline") {
        f.timer.advanceTime(1000);
      } else if (end === "error") {
        first.fail();
      } else {
        first.reply();
      }
    }
    await drainUntil(() => f.socket.responses.some((r) => r.id === "A"), {
      description: "indeterminate answer",
    });
    const response = f.socket.responses.find((r) => r.id === "A");
    expect(response?.success).toBe(false);
    expect(response?.error?.split("outcome is indeterminate")).toHaveLength(2);
    expect(response?.error?.split("Do not retry automatically")).toHaveLength(2);
    first.reply();
    await finishSockets(f);
  },
);
test.each(["tap android", "key android"] as const)(
  "%s socket close holds the other socket's same-device input without writing to destroyed socket",
  async (variant) => {
    const f = socketHarness();
    const first = runner();
    const fake = transport(variant, first);
    f.socket.send(inputFrame(variant));
    await drainUntil(() => first.dispatched, { description: "dispatch" });
    f.socket.destroy();
    f.other.send({ ...inputFrame(variant), id: "B" });
    await drainMicrotasks(100);
    try {
      expect(fake.sends).toBe(1);
      expect(f.socket.responses).toEqual([]);
    } finally {
      first.reply();
    }
    await drainUntil(() => f.other.responses.some((r) => r.id === "B"), {
      description: "other socket response",
    });
    expect(f.socket.responses).toEqual([]);
    await finishSockets(f);
  },
);

test("socket close before held-input dispatch is an expected debug event; other failures still log errors", async () => {
  const f = socketHarness();
  const first = runner();
  const parked = Promise.withResolvers<void>();
  spyOn(f.client, "requestSetText").mockImplementation(async (_text, options) => {
    await parked.promise;
    options?.abortSignal?.throwIfAborted();
    return first.send(options?.abortSignal, options?.onDispatch);
  });
  const errors = spyOn(logger, "error").mockImplementation(() => {});
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  f.socket.send(frame("android"));
  await drainMicrotasks(100);
  errors.mockClear();
  f.socket.destroy();
  await drainMicrotasks(100);
  try {
    expect(
      errors.mock.calls.filter((call) => String(call[0]).includes("Error processing request A")),
    ).toEqual([]);
    expect(debug.mock.calls.some((call) => String(call[0]).includes("A"))).toBe(true);
  } finally {
    parked.resolve();
    await finishSockets(f);
  }
  const next = socketHarness();
  next.socket.send({
    id: "bad",
    type: "mcp_request",
    method: "input/key",
    params: { platform: "invalid", key: "enter" },
  });
  await drainMicrotasks(100);
  expect(errors.mock.calls.length).toBeGreaterThan(0);
  await finishSockets(next);
});

test.each([false, true])(
  "android home stops before verification/fallback after dispatched cancellation (success=%s)",
  async (success) => {
    const { handler, timer } = harness();
    const first = Promise.withResolvers<{
      success: boolean;
      action: string;
      totalTimeMs: number;
    }>();
    let sent = false;
    const fake = transport("pressButton android back", runner());
    spyOn(fake.android, "requestGlobalAction").mockImplementation(
      (_button, _timeout, _perf, options) => {
        options?.signal?.throwIfAborted();
        options?.onDispatch?.();
        sent = true;
        return first.promise;
      },
    );
    const owner = new AbortController();
    const a = handler.handleInputPressButton(
      {
        ...inputFrame("pressButton android back"),
        params: { platform: "android", deviceId: "A", button: "home" },
      },
      undefined,
      { signal: owner.signal },
    );
    void a.catch(() => {});
    await drainUntil(() => sent, { description: "home global action" });
    owner.abort(new Error("cancel home"));
    first.resolve({ success, action: "home", totalTimeMs: 0 });
    await expect(a).rejects.toThrow("outcome is indeterminate");
    expect(fake.adb.execute).not.toHaveBeenCalled();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  },
);

// These use the real tracker and session admission, not the stamp-only queue harness.
test.each(
  variants.flatMap((variant) =>
    ["before", "after"].flatMap((phase) =>
      ["tracker", "owner"].map((source) => [variant, phase, source] as const),
    ),
  ),
)("%s cancellation %s dispatch via %s drains only when safe", async (variant, phase, source) => {
  const platform = variantPlatform(variant);
  const sessionId = "dispatch-hold-session";
  const f = socketHarness(
    createFakeDaemonState(new Map([[sessionId, createFakeSession(sessionId, "A", platform)]])),
  );
  const first = runner();
  const parked = Promise.withResolvers<void>();
  const fake = transport(variant, first, phase === "before" ? parked.promise : undefined);
  const stamp = spyOn(executionTracker, "markSessionAdmitted");
  f.socket.send({
    ...inputFrame(variant),
    params: { ...inputFrame(variant).params, sessionUuid: sessionId },
  });
  await drainUntil(() => (phase === "before" ? fake.attempts === 1 : first.dispatched), {
    description: "tracker operation",
  });
  expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(true);
  expect(stamp.mock.calls).toHaveLength(phase === "before" ? 0 : 1);
  if (source === "owner") {
    cancel(f.socket, "A");
    await drainUntil(() => f.socket.responses.some((r) => r.id === "cancel"), {
      description: "owner cancel ack",
    });
  } else {
    expect(await executionTracker.cancelDeviceSessionExecutions(sessionId, "test recovery")).toBe(
      1,
    );
  }
  let drained = false;
  const drain = executionTracker
    .waitForDeviceSessionExecutionsToEnd(sessionId, 1000)
    .then((result) => {
      drained = result;
      return result;
    });
  await drainMicrotasks(100);
  try {
    expect(drained).toBe(phase === "before");
  } finally {
    if (phase === "after") {
      first.reply();
    }
  }
  expect(await drain).toBe(true);
  await drainUntil(() => f.socket.responses.some((r) => r.id === "A"), {
    description: "tracker failure response",
  });
  expect(f.socket.responses.find((r) => r.id === "A")?.success).toBe(false);
  if (phase === "after") {
    expect(f.socket.responses.find((r) => r.id === "A")?.error).toContain("indeterminate");
  }
  parked.resolve();
  await drainMicrotasks(100);
  expect(fake.sends).toBe(phase === "before" ? 0 : 1);
  expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(false);
  await finishSockets(f);
});

test("gestureMove needs no extra hold: no signal reaches its atomic frame; stroke lift handles cancellation", async () => {
  const f = socketHarness();
  const pending = Promise.withResolvers<{ success: boolean; totalTimeMs: number }>();
  let sent = false;
  spyOn(f.client, "requestGestureMove").mockImplementation(() => {
    sent = true;
    return pending.promise;
  });
  spyOn(f.client, "requestSetText").mockImplementation(async (_text, options) => {
    options?.onDispatch?.();
    return { success: true, totalTimeMs: 0 };
  });
  f.socket.send({
    id: "stroke",
    type: "mcp_request",
    method: "input/gestureMove",
    params: { platform: "android", deviceId: "A", gestureId: "stroke", x: 1, y: 2 },
  });
  await drainUntil(() => sent, { description: "stroke move dispatch" });
  cancel(f.socket, "stroke");
  f.other.send(frame("android"));
  await drainMicrotasks(100);
  try {
    expect(f.client.requestSetText).not.toHaveBeenCalled();
  } finally {
    pending.resolve({ success: true, totalTimeMs: 0 });
  }
  await drainUntil(() => f.other.responses.some((r) => r.id === "A"), {
    description: "input after stroke ack",
  });
  await finishSockets(f);
});

test("ide/setKeyValue needs no input hold: separate tracked execution, atomic write, no abort listener after send", async () => {
  const sessionId = "ide-hold-session";
  const f = socketHarness(
    createFakeDaemonState(new Map([[sessionId, createFakeSession(sessionId, "A", "android")]])),
  );
  PlatformDeviceManagerFactory.setInstance(
    createFakeDeviceManager([{ deviceId: "A", name: "Fake", platform: "android" }]),
  );
  const pending = Promise.withResolvers<void>();
  let sent = false;
  const write = spyOn(f.client, "setPreference").mockImplementation(
    (_app, _file, _entry, options) => {
      if (typeof options === "object") {
        options.onDispatch?.();
      }
      sent = true;
      return pending.promise;
    },
  );
  f.socket.send({
    id: "write",
    type: "mcp_request",
    method: "ide/setKeyValue",
    params: {
      platform: "android",
      deviceId: "A",
      appId: "com.test",
      fileName: "settings",
      key: "key",
      value: "value",
      type: "STRING",
      sessionUuid: sessionId,
    },
  });
  await drainUntil(() => sent, { description: "IDE write send" });
  cancel(f.socket, "write");
  await drainMicrotasks(100);
  try {
    expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(true);
    expect(f.server.forwardTails.has("device:A")).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    pending.resolve();
  }
  await drainUntil(() => !executionTracker.hasActiveSessionUuidExecutions(sessionId), {
    description: "IDE write drain",
  });
  expect(write).toHaveBeenCalledTimes(1);
  await finishSockets(f);
});

test("a global-action transport budget does not shorten the cancelled frame's remaining hold", async () => {
  const { handler, timer } = harness();
  const first = runner(true);
  transport("pressButton android back", first);
  const owner = new AbortController();
  let answered = false;
  const a = runInput(
    handler,
    { ...inputFrame("pressButton android back"), timeoutMs: 5000 },
    owner.signal,
  ).finally(() => {
    answered = true;
  });
  void a.catch(() => {});
  await drainUntil(() => first.dispatched, { description: "global action" });
  timer.advanceTime(200);
  owner.abort(new Error("cancel global action"));
  timer.advanceTime(3000);
  await drainMicrotasks(100);
  expect(answered).toBe(false);
  timer.advanceTime(1800);
  await expect(a).rejects.toThrow("outcome is indeterminate");
  first.reply();
  await drainMicrotasks(100);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test.each([...variants])(
  "%s session release has a generic capitalized dispatched note and no append count",
  async (variant) => {
    const platform = variantPlatform(variant);
    const sessionId = "released-hold-session";
    const f = socketHarness(
      createFakeDaemonState(new Map([[sessionId, createFakeSession(sessionId, "A", platform)]])),
    );
    const first = runner();
    transport(variant, first);
    f.socket.send({
      ...inputFrame(variant),
      params: { ...inputFrame(variant).params, sessionUuid: sessionId },
    });
    await drainUntil(() => first.dispatched, { description: "release dispatch" });
    const release = new SessionReleasedDuringCallError(sessionId, "cleanup-expired");
    expect(await executionTracker.cancelSessionUuidExecutions(sessionId, release)).toBe(1);
    await drainMicrotasks(100);
    try {
      expect(executionTracker.hasActiveSessionUuidExecutions(sessionId)).toBe(true);
    } finally {
      first.reply();
    }
    await drainUntil(() => f.socket.responses.some((r) => r.id === "A"), {
      description: "release answer",
    });
    const response = f.socket.responses.find((r) => r.id === "A")!;
    expect({ ...response }).toMatchObject({
      success: false,
      code: "session_ownership_lost",
      error: expect.stringContaining(
        ". Cancellation arrived after the request had been dispatched; its outcome is indeterminate.",
      ),
    });
    expect(response.error).not.toContain("the text request");
    expect("charsSent" in response).toBe(false);
    expect(release.message).not.toContain("indeterminate");
    await finishSockets(f);
  },
);
