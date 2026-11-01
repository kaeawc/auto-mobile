import { describe, expect, test } from "bun:test";
import {
  requestSdkAction,
  requestSdkObservation,
} from "../../../../src/features/observe/ios/CtrlProxySdkObservation";
import { decodeCtrlProxyMessage } from "../../../../src/features/observe/ios/decodeCtrlProxyMessage";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const observation = {
  bundleId: "com.example.app",
  captureIdentity: 41,
  orientation: "portrait",
  coordinateSpace: "screen",
  bounds: { left: 0, top: 0, right: 390, bottom: 844 },
  root: {
    id: "submit",
    role: "button",
    label: "Submit",
    bounds: { left: 10, top: 10, right: 90, bottom: 40 },
    enabled: true,
    visible: true,
    focused: false,
    children: [],
  },
  capabilities: [],
};

describe("SDK observation bridge commands (#5159)", () => {
  test("requestSdkObservation relays the bridge snapshot through the wire and delegate", async () => {
    const harness = createIosDelegateHarness();
    const pending = requestSdkObservation(harness.context);
    await flush();
    expect(harness.sentMessages[0].type).toBe("request_sdk_observation");
    const decoded = decodeCtrlProxyMessage({
      type: "sdk_observation_result",
      requestId: harness.lastRequestId() ?? undefined,
      success: true,
      available: true,
      observation,
      totalTimeMs: 3,
    });
    harness.resolveLast(decoded?.result);
    expect(await pending).toEqual({
      success: true,
      available: true,
      observation,
      totalTimeMs: 3,
    });
  });

  test("requestSdkAction sends the action as one JSON string and returns the bridge result", async () => {
    const harness = createIosDelegateHarness();
    const pending = requestSdkAction(harness.context, {
      tap: { observationIdentity: 41, elementId: "submit" },
    });
    await flush();
    expect(harness.sentMessages[0]).toMatchObject({
      type: "request_sdk_action",
      actionJson: '{"tap":{"observationIdentity":41,"elementId":"submit"}}',
    });
    const decoded = decodeCtrlProxyMessage({
      type: "sdk_action_result",
      requestId: harness.lastRequestId() ?? undefined,
      success: true,
      available: true,
      result: { status: "accepted", durationMs: 4, nextObservationIdentity: 42 },
      totalTimeMs: 6,
    });
    harness.resolveLast(decoded?.result);
    expect(await pending).toMatchObject({
      success: true,
      result: { status: "accepted", nextObservationIdentity: 42 },
    });
  });

  test.each([undefined, 12000, 13000])(
    "action budget %s is forwarded on the wire",
    async (timeoutMs) => {
      const harness = createIosDelegateHarness();
      const pending = requestSdkAction(
        harness.context,
        {
          longPress: { observationIdentity: 41, elementId: "submit", durationMs: 10000 },
        },
        { timeoutMs },
      );
      await flush();
      expect(harness.sentMessages[0].timeoutMs).toBe(timeoutMs);
      harness.resolveLast({ success: true, available: true, totalTimeMs: 0 });
      await pending;
    },
  );

  test("a bridge rejection decodes as a result, not a failure", () => {
    const decoded = decodeCtrlProxyMessage({
      type: "sdk_action_result",
      requestId: "act-1",
      success: false,
      available: true,
      result: { status: "rejected", reason: "stale_observation", durationMs: 0 },
      error: "stale_observation",
      totalTimeMs: 2,
    });
    expect(decoded?.result).toEqual({
      success: false,
      available: true,
      result: { status: "rejected", reason: "stale_observation", durationMs: 0 },
      error: "stale_observation",
      totalTimeMs: 2,
    });
  });

  test("runner failure codes stay typed; an unknown one reads as bad_reply", () => {
    const unavailable = decodeCtrlProxyMessage({
      type: "sdk_observation_result",
      requestId: "obs-1",
      success: false,
      available: false,
      failure: "bridge_unavailable",
      error: "no bridge",
    });
    expect(decoded(unavailable)).toMatchObject({ available: false, failure: "bridge_unavailable" });
    const future = decodeCtrlProxyMessage({
      type: "sdk_action_result",
      requestId: "act-1",
      success: false,
      available: true,
      failure: "future_failure",
    });
    expect(decoded(future)).toMatchObject({ failure: "bad_reply" });
  });

  test("a malformed relayed observation is a bad_reply failure, never a partial snapshot", () => {
    const result = decodeCtrlProxyMessage({
      type: "sdk_observation_result",
      requestId: "obs-1",
      success: true,
      available: true,
      observation: { captureIdentity: "41" },
    });
    expect(decoded(result)).toMatchObject({
      success: false,
      failure: "bad_reply",
      observation: undefined,
    });
  });
});

function decoded(message: ReturnType<typeof decodeCtrlProxyMessage>): unknown {
  return message?.result;
}
