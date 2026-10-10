import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionReleasedDuringCallError } from "../../src/daemon/sessionReleasedDuringCall";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { sessionReleasedDuringCallPayload } from "../../src/server/deviceSessionResult";
import { executionTracker } from "../../src/server/executionTracker";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  androidDevice,
  createFakeDaemonState,
  createFakeDeviceManager,
  createFakeSession,
} from "./helpers/inputSocketHarness";

/**
 * #11381: an `input/*` frame cut because the daemon released its session mid-call must be answered
 * with the typed terminal refusal the MCP path gives (`session_ownership_lost`, not retryable,
 * `acquire_new_session`), not with whatever the interrupted device operation threw. Driven through
 * the real socket request path; only the device client is a fake.
 */

class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly responses: DaemonResponse[] = [];
  setTimeout(): this {
    return this;
  }
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    this.responses.push(JSON.parse(data) as DaemonResponse);
    callback?.();
    return true;
  }
  end(): this {
    return this.destroy();
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close", false);
    }
    return this;
  }
  send(request: DaemonRequest): void {
    this.emit("data", Buffer.from(`${JSON.stringify(request)}\n`));
  }
}

interface Internals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
}

const OWNER = "released-mid-input-session";

describe("input/* cut by a session release (#11381)", () => {
  let internals: Internals;
  let socket: FakeSocket;
  let tapEntered: PromiseWithResolvers<void>;
  let tapOutcome: PromiseWithResolvers<{ success: boolean }>;

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
    await Promise.all([...internals.activeRequestHandlers]);
    return socket.responses.find((frame) => frame.id === "tap");
  }

  beforeEach(() => {
    tapEntered = Promise.withResolvers<void>();
    tapOutcome = Promise.withResolvers<{ success: boolean }>();
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(
      () =>
        ({
          getScreenScaleMetadata: () => null,
          requestTapCoordinates: () => {
            tapEntered.resolve();
            return tapOutcome.promise;
          },
        }) as unknown as AndroidCtrlProxyClient,
    );
    const server = new UnixSocketServer(
      "unused",
      "http://localhost:0/mcp",
      createFakeDaemonState(
        new Map([[OWNER, createFakeSession(OWNER, androidDevice.deviceId, "android")]]),
      ),
      new FakeTimer(),
    );
    internals = server as unknown as Internals;
    internals.acceptingRequests = true;
    socket = new FakeSocket();
    internals.handleConnection(socket as unknown as Socket);
  });

  afterEach(() => {
    spyOn(AndroidCtrlProxyClient, "getInstance").mockRestore();
    PlatformDeviceManagerFactory.reset();
    socket.destroy();
  });

  test("the failure frame carries the typed terminal refusal", async () => {
    await startTap();
    const release = new SessionReleasedDuringCallError(OWNER, "cleanup-expired");
    expect(await executionTracker.cancelSessionUuidExecutions(OWNER, release)).toBe(1);

    const response = await failTapAndCollectResponse();

    expect(response).toMatchObject({
      success: false,
      error: release.message,
      code: "session_ownership_lost",
      retryable: false,
      nextAction: "acquire_new_session",
      details: { sessionUuid: OWNER, reason: "cleanup-expired" },
    });
    // The same refusal the MCP path builds from the same cancellation.
    const mcp = sessionReleasedDuringCallPayload(release)?.error;
    expect(response).toMatchObject({
      error: mcp?.message,
      code: mcp?.code,
      retryable: mcp?.retryable,
      nextAction: mcp?.nextAction,
      details: { sessionUuid: mcp?.sessionUuid, reason: mcp?.reason },
    });
  });

  test("a cancellation that is not a session release keeps the operation's own failure", async () => {
    await startTap();
    expect(await executionTracker.cancelSessionUuidExecutions(OWNER, "explicit-release")).toBe(1);

    const response = await failTapAndCollectResponse();

    expect(response).toMatchObject({ success: false, error: "The operation was aborted" });
    expect(response?.code).toBeUndefined();
    expect(response?.nextAction).toBeUndefined();
  });
});
