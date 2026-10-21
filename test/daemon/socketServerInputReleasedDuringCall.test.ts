import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { sessionReleasedDuringCallPayload } from "../../src/daemon/deviceSessionResult";
import { executionTracker } from "../../src/daemon/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
  createFakeSession,
} from "./helpers/inputSocketHarness";
import { spyOnAndroidClientInstance } from "../helpers/androidCtrlProxyClientSpies";
import {
  createHarnessServer,
  type UnixSocketServerHarness,
} from "./helpers/UnixSocketServerHarness";
import { NonThrowingFakeSocket as FakeSocket } from "../fakes/FakeNetServer";

/**
 * #11381: an `input/*` frame cut because the daemon released its session mid-call must be answered
 * with the typed terminal refusal the MCP path gives (`session_ownership_lost`, not retryable,
 * `acquire_new_session`), not with whatever the interrupted device operation threw. Driven through
 * the real socket request path; only the device client is a fake.
 */

type TapResult = Awaited<ReturnType<AndroidCtrlProxyClient["requestTapCoordinates"]>>;

const OWNER = "released-mid-input-session";

describe("input/* cut by a session release (#11381)", () => {
  let server: UnixSocketServerHarness;
  let socket: FakeSocket;
  let tapEntered: PromiseWithResolvers<void>;
  let tapOutcome: PromiseWithResolvers<TapResult>;

  const tapFrame: DaemonRequest = {
    id: "tap",
    type: "mcp_request",
    method: "input/tap",
    params: {
      platform: "android",
      deviceId: androidDevice.deviceId,
      x: 1,
      y: 2,
      sessionUuid: OWNER,
    },
  };

  /** Send the tap and wait until it is running on the (fake) device. */
  async function startTap(): Promise<void> {
    socket.send(tapFrame);
    await tapEntered.promise;
  }

  /** The interrupted device operation fails the way an aborted transport does. */
  async function failTapAndCollectResponse(): Promise<DaemonResponse | undefined> {
    tapOutcome.reject(new Error("The operation was aborted"));
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await Promise.all([...server.state.activeRequestHandlers]);
    return socket.responses.find((frame) => frame.id === "tap");
  }

  function setUp(): void {
    tapEntered = Promise.withResolvers<void>();
    tapOutcome = Promise.withResolvers<TapResult>();
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    spyOnAndroidClientInstance(androidDevice, {
      getScreenScaleMetadata: () => null,
      requestTapCoordinates: (
        ...args: Parameters<AndroidCtrlProxyClient["requestTapCoordinates"]>
      ) => {
        args[0].onDispatch?.();
        tapEntered.resolve();
        return tapOutcome.promise;
      },
    });
    server = createHarnessServer(
      "unused",
      createFakeDaemonState(
        new Map([[OWNER, createFakeSession(OWNER, androidDevice.deviceId, "android")]]),
      ),
      new FakeTimer(),
    );
    server.allowRequests();
    socket = new FakeSocket();
    server.connect(socket);
  }

  function tearDown(): void {
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    socket.destroy();
  }

  // CI's per-test time excludes only beforeAll: the first run through the daemon request path
  // (JIT, lazy module state) is paid here once, with the same release-then-fail sequence the
  // first test drives, instead of inside that timed test.
  beforeAll(async () => {
    setUp();
    try {
      await startTap();
      await executionTracker.cancelSessionUuidExecutions(
        OWNER,
        new SessionReleasedDuringCallError(OWNER, "cleanup-expired"),
      );
      await failTapAndCollectResponse();
    } finally {
      tearDown();
    }
  });

  beforeEach(setUp);
  afterEach(tearDown);

  test("the failure frame carries the typed terminal refusal", async () => {
    await startTap();
    const release = new SessionReleasedDuringCallError(OWNER, "cleanup-expired");
    expect(await executionTracker.cancelSessionUuidExecutions(OWNER, release)).toBe(1);

    const response = await failTapAndCollectResponse();

    expect({ ...response }).toMatchObject({
      success: false,
      error: expect.stringContaining(release.message),
      code: "session_ownership_lost",
      retryable: false,
      nextAction: "acquire_new_session",
      details: { sessionUuid: OWNER, reason: "cleanup-expired", idle: true },
    });
    // The same refusal the MCP path builds from the same cancellation.
    const mcp = sessionReleasedDuringCallPayload(release)?.error;
    expect({ ...response }).toMatchObject({
      error: expect.stringContaining(mcp!.message),
      code: mcp?.code,
      retryable: mcp?.retryable,
      nextAction: mcp?.nextAction,
      details: { sessionUuid: mcp?.sessionUuid, reason: mcp?.reason, idle: true },
    });
  });

  test("a dispatched cancellation that is not a session release reports indeterminate delivery", async () => {
    await startTap();
    expect(await executionTracker.cancelSessionUuidExecutions(OWNER, "explicit-release")).toBe(1);

    const response = await failTapAndCollectResponse();

    expect({ ...response }).toMatchObject({
      success: false,
      error: expect.stringContaining("Tap outcome is indeterminate"),
    });
    expect(response?.code).toBeUndefined();
    expect(response?.nextAction).toBeUndefined();
  });
});
