/**
 * Issue #6222 P1 reopen (fuQ88 review): `setUIStateHandler` must resolve both
 * the frozen transport-deadline snapshot AND a LIVE getter backed by
 * `liveDeadlineRegistry`, and pass both through to `SetUIState.execute()` --
 * the live getter (when present) is what lets `execute()` see a
 * progress-driven extension the frozen snapshot alone can never reflect.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  resetSetUIStateFactory,
  setSetUIStateFactory,
  setUIStateHandler,
} from "../../src/server/formTools";
import {
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
} from "../../src/daemon/constants";
import {
  registerLiveDeadline,
  unregisterLiveDeadline,
} from "../../src/daemon/liveDeadlineRegistry";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import type { BootedDevice } from "../../src/models";
import type { SetUIStateArgs } from "../../src/server/formTools";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 8",
  platform: "android",
};

const baseArgs = {
  fields: [{ selector: { elementId: "firstName" }, value: "Grace" }],
} as unknown as SetUIStateArgs;

describe("setUIStateHandler transport-deadline wiring (issue #6222 P1 reopen)", () => {
  afterEach(() => {
    resetSetUIStateFactory();
  });

  test("passes both the frozen transportDeadlineMs snapshot and a live getter through to execute()", async () => {
    const executionStartTime = 1_000;
    const remainingMs = 10_000;
    const liveKey = "test-live-key-1";
    const deadline = new ProgressExtendableDeadline(executionStartTime, remainingMs);
    registerLiveDeadline(liveKey, deadline);

    let capturedTransportDeadlineMs: number | undefined;
    let capturedGetLiveTransportDeadlineMs: (() => number | undefined) | undefined;
    setSetUIStateFactory(() => ({
      execute: async (
        _options,
        _progress,
        _signal,
        transportDeadlineMs,
        getLiveTransportDeadlineMs,
      ) => {
        capturedTransportDeadlineMs = transportDeadlineMs;
        capturedGetLiveTransportDeadlineMs = getLiveTransportDeadlineMs;
        return { success: true, fields: [], totalAttempts: 0 };
      },
    }));

    const argsWithInternalParams = {
      ...baseArgs,
      [INTERNAL_EXECUTION_START_TIME_PARAM]: executionStartTime,
      [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: remainingMs,
      [INTERNAL_LIVE_DEADLINE_KEY_PARAM]: liveKey,
    } as unknown as SetUIStateArgs;

    await setUIStateHandler(androidDevice, argsWithInternalParams);

    expect(capturedTransportDeadlineMs).toBe(executionStartTime + remainingMs);
    expect(capturedGetLiveTransportDeadlineMs).toBeDefined();
    // The live getter reads the registry LIVE -- proof it is not just a
    // second copy of the frozen snapshot.
    expect(capturedGetLiveTransportDeadlineMs?.()).toBe(deadline.value);
    deadline.extendOnProgress(executionStartTime + 5_000, 300_000);
    expect(capturedGetLiveTransportDeadlineMs?.()).toBe(deadline.value);
    expect(capturedGetLiveTransportDeadlineMs?.()).toBeGreaterThan(
      executionStartTime + remainingMs,
    );

    unregisterLiveDeadline(liveKey);
  });

  test("resolves no live getter when no live-deadline key is present (direct/non-daemon call)", async () => {
    let capturedGetLiveTransportDeadlineMs: (() => number | undefined) | undefined = () => 0;
    setSetUIStateFactory(() => ({
      execute: async (
        _options,
        _progress,
        _signal,
        _transportDeadlineMs,
        getLiveTransportDeadlineMs,
      ) => {
        capturedGetLiveTransportDeadlineMs = getLiveTransportDeadlineMs;
        return { success: true, fields: [], totalAttempts: 0 };
      },
    }));

    await setUIStateHandler(androidDevice, baseArgs);

    expect(capturedGetLiveTransportDeadlineMs).toBeUndefined();
  });

  test("the live getter reads undefined once the registry entry is gone (call already settled)", async () => {
    const liveKey = "test-live-key-2";
    // Never registered -- models a call whose deadline already expired.
    let capturedGetLiveTransportDeadlineMs: (() => number | undefined) | undefined;
    setSetUIStateFactory(() => ({
      execute: async (
        _options,
        _progress,
        _signal,
        _transportDeadlineMs,
        getLiveTransportDeadlineMs,
      ) => {
        capturedGetLiveTransportDeadlineMs = getLiveTransportDeadlineMs;
        return { success: true, fields: [], totalAttempts: 0 };
      },
    }));

    const argsWithLiveKeyOnly = {
      ...baseArgs,
      [INTERNAL_LIVE_DEADLINE_KEY_PARAM]: liveKey,
    } as unknown as SetUIStateArgs;

    await setUIStateHandler(androidDevice, argsWithLiveKeyOnly);

    expect(capturedGetLiveTransportDeadlineMs).toBeDefined();
    expect(capturedGetLiveTransportDeadlineMs?.()).toBeUndefined();
  });

  test("prefers the anchored __mcpRequestDeadlineMs over recomputing startTime + remainingMs (issue #6222 review, PRRT_kwDOP-GF5M6fuyts)", async () => {
    // Simulate dispatch/admission delay between when the daemon captured the
    // remaining budget (executionStartTime here is the LATER, post-dispatch
    // timestamp `INTERNAL_EXECUTION_START_TIME_PARAM` carries) and when it
    // actually captured `remainingMs` moments earlier -- the anchored
    // deadline must win regardless of that gap.
    const anchoredDeadlineMs = 5_000;
    const executionStartTime = 4_000; // recorded AFTER a dispatch delay
    const remainingMs = 10_000; // captured BEFORE that delay

    let capturedTransportDeadlineMs: number | undefined;
    setSetUIStateFactory(() => ({
      execute: async (_options, _progress, _signal, transportDeadlineMs) => {
        capturedTransportDeadlineMs = transportDeadlineMs;
        return { success: true, fields: [], totalAttempts: 0 };
      },
    }));

    const argsWithBothParams = {
      ...baseArgs,
      [INTERNAL_EXECUTION_START_TIME_PARAM]: executionStartTime,
      [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: remainingMs,
      [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: anchoredDeadlineMs,
    } as unknown as SetUIStateArgs;

    await setUIStateHandler(androidDevice, argsWithBothParams);

    // Naively recomputing from startTime + remainingMs would yield 14_000 --
    // LATER than the daemon's real outer abort. The anchored value must win.
    expect(capturedTransportDeadlineMs).toBe(anchoredDeadlineMs);
    expect(capturedTransportDeadlineMs).not.toBe(executionStartTime + remainingMs);
  });

  test("falls back to startTime + remainingMs when no anchored deadline is present (older daemon build)", async () => {
    const executionStartTime = 1_000;
    const remainingMs = 10_000;

    let capturedTransportDeadlineMs: number | undefined;
    setSetUIStateFactory(() => ({
      execute: async (_options, _progress, _signal, transportDeadlineMs) => {
        capturedTransportDeadlineMs = transportDeadlineMs;
        return { success: true, fields: [], totalAttempts: 0 };
      },
    }));

    const argsWithLegacyParamsOnly = {
      ...baseArgs,
      [INTERNAL_EXECUTION_START_TIME_PARAM]: executionStartTime,
      [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: remainingMs,
    } as unknown as SetUIStateArgs;

    await setUIStateHandler(androidDevice, argsWithLegacyParamsOnly);

    expect(capturedTransportDeadlineMs).toBe(executionStartTime + remainingMs);
  });
});
