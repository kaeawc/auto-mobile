import {
  createHarnessServer,
  type UnixSocketServerHarness,
} from "./helpers/UnixSocketServerHarness";
import { ResourceUpdatedBroadcaster } from "../../src/daemon/listChangedBroadcast";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import type { Socket } from "node:net";
import * as net from "node:net";
import * as securePermissions from "../../src/utils/filesystem/securePermissions";
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { executionTracker } from "../../src/daemon/executionTracker";
import { daemonSessionToolBindingStore } from "../../src/server/daemonSessionToolBindingStore";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import {
  getToolCallRecorder,
  getToolCallRecordingStatus,
  resetToolCallRecordingState,
  startToolCallRecording,
} from "../../src/daemon/toolCallRecordingManager";
import { daemonNotificationFrameSchema } from "../helpers/wireMessageSchemas";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";

class RpcSocket extends FakeSocket {
  setTimeout(_ms: number): this {
    return this;
  }
}

/** A socket server and one registered socket, for driving a disconnect by hand. */
function connectedSocketFixture(socketSessionId: string): {
  internals: UnixSocketServerHarness;
  socket: Socket;
  readiness: FakeDeviceReadiness;
} {
  const readiness = new FakeDeviceReadiness();
  const server = createHarnessServer("/fake/socket", undefined, new FakeTimer(), undefined, {
    clearConnectionDevicePin: (id) => readiness.clearConnectionDevicePin(id),
  });
  const internals = server;
  const socket = new RpcSocket();
  internals.state.clientSockets.set(socketSessionId, socket);
  return { internals, socket, readiness };
}

describe("daemon socket transport lifecycle", () => {
  afterEach(() => resetToolCallRecordingState());

  test("socket disconnect clears only the released connection's device pin", () => {
    const { internals, socket, readiness } = connectedSocketFixture("pin-socket");
    const clearPin = spyOn(readiness, "clearConnectionDevicePin");
    try {
      internals.releaseSocket("pin-socket", new RpcSocket());
      expect(clearPin).not.toHaveBeenCalled();
      internals.releaseSocket("pin-socket", socket);
      expect(clearPin).toHaveBeenCalledTimes(1);
      expect(clearPin).toHaveBeenCalledWith("pin-socket");
    } finally {
      clearPin.mockRestore();
    }
  });

  test("ide/status advertises structured session-not-found errors", async () => {
    const server = createHarnessServer("/fake/socket", undefined, new FakeTimer());
    const internals = server;
    await expect(
      internals.dispatchLocalRequest({
        id: "status-1",
        type: "daemon_request",
        method: "ide/status",
        params: {},
      }),
    ).resolves.toMatchObject({ structuredSessionNotFound: true });
  });

  test("codes a missing socket session without changing its message", async () => {
    const timer = new FakeTimer();
    const server = createHarnessServer("/fake/socket", undefined, timer);
    const internals = server;
    await expect(
      internals.dispatchRequest(
        "missing",
        new RpcSocket(),
        {
          id: "request-1",
          type: "mcp_request",
          method: "tools/list",
          params: {},
        },
        timer.now(),
      ),
    ).resolves.toEqual({
      id: "request-1",
      type: "mcp_response",
      success: false,
      error: "Session not found",
      code: DAEMON_SESSION_NOT_FOUND_CODE,
    });
  });

  for (const event of ["close", "error"]) {
    test(`socket ${event} drops only that socket's recording`, () => {
      const timer = new FakeTimer();
      const server = createHarnessServer(
        "/fake/socket",
        undefined,
        timer,
        null,
        {},
        new CountingIdGenerator("recording-socket"),
      );
      const internals = server;
      internals.allowRequests();
      const socket = new RpcSocket();
      internals.connect(socket);
      startToolCallRecording({ connectionId: "recording-socket-1", timer });
      startToolCallRecording({ connectionId: "other-socket", timer });
      socket.emit(event, event === "error" ? new Error("fake disconnect") : false);
      expect(getToolCallRecorder({ connectionId: "recording-socket-1" })).toBeNull();
      expect(getToolCallRecordingStatus({ connectionId: "recording-socket-1", timer })).toBeNull();
      expect(getToolCallRecorder({ connectionId: "other-socket" })?.isRecording()).toBe(true);
    });
  }

  test("a stale socket release preserves the newer incarnation's recording", () => {
    const timer = new FakeTimer();
    const server = createHarnessServer("/fake/socket", undefined, timer);
    const internals = server;
    const oldSocket = new RpcSocket();
    const newSocket = new RpcSocket();
    internals.state.clientSockets.set("reused-id", newSocket);
    startToolCallRecording({ connectionId: "reused-id", timer });
    internals.releaseSocket("reused-id", oldSocket);
    expect(getToolCallRecorder({ connectionId: "reused-id" })?.isRecording()).toBe(true);
    internals.releaseSocket("reused-id", newSocket);
    expect(getToolCallRecorder({ connectionId: "reused-id" })).toBeNull();
  });

  test("socket disconnect cancels the executions keyed by its session id", async () => {
    const { internals, socket } = connectedSocketFixture("cancel-socket");
    const execution = executionTracker.startExecution("observe", "cancel-socket");
    try {
      internals.releaseSocket("cancel-socket", socket);
      await Promise.all([...internals.state.activeRequestHandlers]);
      expect(execution.abortController.signal.aborted).toBe(true);
    } finally {
      executionTracker.endExecution(execution.id);
    }
  });

  test("socket disconnect forgets the session-tool bindings keyed by its session id", async () => {
    const { internals, socket } = connectedSocketFixture("forget-socket");
    const store = daemonSessionToolBindingStore();
    const baseline = store.keyCount;
    store.bind("forget-socket", "device-session-a");
    store.bindToolSelectionProfile("forget-socket", "profile-a");
    try {
      expect(store.keyCount).toBe(baseline + 1);
      internals.releaseSocket("forget-socket", socket);
      await Promise.all([...internals.state.activeRequestHandlers]);
      expect(store.keyCount).toBe(baseline);
      expect(store.boundSessionUuid("forget-socket")).toBeUndefined();
    } finally {
      store.forget("forget-socket");
    }
  });

  test("a late binding written by an abort-ignoring handler after disconnect never leaves a live binding (#13053, #13346)", async () => {
    const { internals, socket } = connectedSocketFixture("late-socket");
    const store = daemonSessionToolBindingStore();
    const execution = executionTracker.startExecution("observe", "late-socket");
    try {
      internals.releaseSocket("late-socket", socket);
      await Promise.all([...internals.state.activeRequestHandlers]);
      expect(execution.abortController.signal.aborted).toBe(true);
      // The handler ignored the abort and records its acquisition after the socket is gone.
      // The forget() tombstone from teardown (#13346) refuses it outright.
      store.bind("late-socket", "device-session-late");
      expect(store.boundSessionUuid("late-socket")).toBeUndefined();

      executionTracker.endExecution(execution.id);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(store.boundSessionUuid("late-socket")).toBeUndefined();
    } finally {
      executionTracker.endExecution(execution.id);
      store.forget("late-socket");
    }
  });

  test("daemon RPC reader preserves UTF-8 split across socket events", async () => {
    const server = createHarnessServer("/fake/socket", undefined, new FakeTimer());
    const internals = server;
    const socket = new RpcSocket();
    const requests: DaemonRequest[] = [];
    internals.allowRequests();
    internals.requestHandler = async (_sessionId, _socket, request) => {
      requests.push(request);
      return { id: request.id, type: "mcp_response", success: true, result: "ok" };
    };
    internals.connect(socket);
    const frame = Buffer.from(
      JSON.stringify({
        id: "1",
        type: "daemon_request",
        method: "tools/list",
        params: { text: "日" },
      }) + "\n",
    );
    const split = frame.indexOf(Buffer.from("日")) + 1;
    socket.emit("data", frame.subarray(0, split));
    socket.emit("data", frame.subarray(split));
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.params).toEqual({ text: "日" });
  });
});

describe("daemon socket resource subscription routing", () => {
  test("start registers resource updates and close removes the broadcaster listener", async () => {
    const listener = new net.Server();
    const listen = spyOn(listener, "listen").mockImplementation((_path, callback) => {
      if (typeof callback === "function") {
        callback();
      }
      return listener;
    });
    const close = spyOn(listener, "close").mockImplementation((callback) => {
      callback?.();
      return listener;
    });
    const create = spyOn(net, "createServer").mockImplementation((onConnection) => {
      if (typeof onConnection === "function") {
        listener.on("connection", onConnection);
      }
      return listener;
    });
    const mkdir = spyOn(securePermissions, "ensureSecureDir").mockResolvedValue();
    const chmod = spyOn(securePermissions, "secureFile").mockResolvedValue();
    const timer = new FakeTimer();
    const server = createHarnessServer(
      "/fake/resource-lifecycle/socket",
      undefined,
      timer,
      null,
      {},
      new CountingIdGenerator("started-resource"),
      { bindLock: { acquire: () => true, release: () => {} } },
    );
    const internals = server;
    const socket = new RpcSocket();
    const uri = "automobile:started-resource";
    let resolutions = 0;
    const emit = () =>
      ResourceUpdatedBroadcaster.emit((subscriptions) => {
        resolutions++;
        return subscriptions.has(uri) ? [uri] : [];
      });
    try {
      await server.start();
      listener.emit("connection", socket);
      expect(
        await internals.dispatchRequest(
          "started-resource-1",
          socket,
          { id: "subscribe", type: "mcp_request", method: "resources/subscribe", params: { uri } },
          timer.now(),
        ),
      ).toMatchObject({ success: true, result: {} });
      emit();
      expect(socket.getWrittenMessages(daemonNotificationFrameSchema)).toEqual([
        { type: "daemon_notification", method: "notifications/resources/updated", uri },
      ]);
      expect(resolutions).toBe(1);
      await server.close();
      // Repopulate the routing state so clearing it on close cannot mask a leaked listener.
      internals.state.clientSockets.set("started-resource-1", socket);
      internals.state.resourceSubscriptions.set("started-resource-1", new Set([uri]));
      emit();
      expect(resolutions).toBe(1);
      expect(socket.getWrittenMessages()).toHaveLength(1);
    } finally {
      await server.close();
      create.mockRestore();
      listen.mockRestore();
      close.mockRestore();
      mkdir.mockRestore();
      chmod.mockRestore();
    }
  });

  test("accepts an unknown subscription URI without sending updates for registered resources", async () => {
    const timer = new FakeTimer();
    const server = createHarnessServer(
      "/fake/socket",
      undefined,
      timer,
      null,
      {},
      new CountingIdGenerator("unknown-resource"),
    );
    const internals = server;
    internals.allowRequests();
    const socket = new RpcSocket();
    internals.connect(socket);
    const stop = ResourceUpdatedBroadcaster.subscribe((resolve) =>
      internals.broadcastResourceUpdated(resolve),
    );
    ResourceRegistry.registerTemplate("automobile:known-resource", "Known", {
      description: "Known",
      mimeType: "text/plain",
      handler: async () => ({ uri: "automobile:known-resource", text: "value" }),
    });
    try {
      expect(
        await internals.dispatchRequest(
          "unknown-resource-1",
          socket,
          {
            id: "unknown",
            type: "mcp_request",
            method: "resources/subscribe",
            params: { uri: "unknown" },
          },
          timer.now(),
        ),
      ).toMatchObject({ success: true, result: {} });
      expect(internals.state.resourceSubscriptions.get("unknown-resource-1")).toEqual(
        new Set(["unknown"]),
      );
      await ResourceRegistry.notifyResourceUpdated("automobile:known-resource");
      await ResourceRegistry.notifyResourceUpdated("unknown");
      expect(socket.getWrittenMessages()).toEqual([]);
    } finally {
      stop();
      socket.destroy();
      ResourceRegistry.clearResources();
    }
  });

  test("routes registered updates to exact socket subscriptions, preserves pages and cleans disconnects", async () => {
    const timer = new FakeTimer();
    const server = createHarnessServer(
      "/fake/socket",
      undefined,
      timer,
      null,
      {},
      new CountingIdGenerator("resource-socket"),
    );
    const internals = server;
    internals.allowRequests();
    const first = new RpcSocket();
    const second = new RpcSocket();
    const third = new RpcSocket();
    internals.connect(first);
    internals.connect(second);
    internals.connect(third);
    const canonical = "automobile:socket/one?appId=x";
    const page = `${canonical}&limit=10&offset=0`;
    ResourceRegistry.registerTemplate("automobile:socket/{id}{?appId,limit,offset}", "Socket", {
      description: "Socket",
      mimeType: "text/plain",
      handler: async () => ({ uri: canonical, text: "value" }),
      paginationParams: ["limit", "offset"],
    });
    const stop = ResourceUpdatedBroadcaster.subscribe((resolve) =>
      internals.broadcastResourceUpdated(resolve),
    );
    const request = (sessionId: string, socket: RpcSocket, method: string, uri: string) =>
      internals.dispatchRequest(
        sessionId,
        socket,
        { id: method, type: "mcp_request", method, params: { uri } },
        timer.now(),
      );
    try {
      expect(await request("resource-socket-1", first, "resources/subscribe", page)).toMatchObject({
        success: true,
        result: {},
      });
      expect(
        await request(
          "resource-socket-2",
          second,
          "resources/subscribe",
          "automobile:socket/two?appId=x",
        ),
      ).toMatchObject({ success: true, result: {} });
      expect(
        await request("resource-socket-3", third, "resources/unsubscribe", canonical),
      ).toMatchObject({ success: true, result: {} });
      await ResourceRegistry.notifyResourceUpdated(canonical);
      expect(first.getWrittenMessages(daemonNotificationFrameSchema)).toEqual([
        { type: "daemon_notification", method: "notifications/resources/updated", uri: page },
      ]);
      expect(second.getWrittenMessages()).toEqual([]);
      expect(third.getWrittenMessages()).toEqual([]);
      await ResourceRegistry.notifyResourceUpdated("automobile:socket/two?appId=x");
      expect(second.getWrittenMessages(daemonNotificationFrameSchema)[0]?.uri).toBe(
        "automobile:socket/two?appId=x",
      );
      expect(
        await request("resource-socket-1", first, "resources/unsubscribe", page),
      ).toMatchObject({ success: true, result: {} });
      await ResourceRegistry.notifyResourceUpdated(canonical);
      expect(first.getWrittenMessages()).toHaveLength(1);
      expect(internals.state.resourceSubscriptions.has("resource-socket-1")).toBe(false);
      internals.state.notificationSubscribers.add("resource-socket-2");
      second.emit("close");
      expect(internals.state.resourceSubscriptions.size).toBe(0);
      expect(internals.state.notificationSubscribers.size).toBe(0);
      await ResourceRegistry.notifyResourceUpdated("automobile:socket/two?appId=x");
      expect(second.getWrittenMessages()).toHaveLength(1);
    } finally {
      stop();
      first.emit("close");
      second.emit("close");
      third.emit("close");
      ResourceRegistry.clearResources();
    }
  });

  test("rejects a malformed subscription instead of retaining it", async () => {
    const timer = new FakeTimer();
    const server = createHarnessServer(
      "/fake/socket",
      undefined,
      timer,
      null,
      {},
      new CountingIdGenerator("invalid-resource"),
    );
    const internals = server;
    const socket = new RpcSocket();
    internals.allowRequests();
    internals.connect(socket);
    try {
      expect(
        await internals.dispatchRequest(
          "invalid-resource-1",
          socket,
          { id: "invalid", type: "mcp_request", method: "resources/subscribe", params: {} },
          timer.now(),
        ),
      ).toMatchObject({ success: false, error: "Resource subscription requires params.uri" });
      expect(internals.state.resourceSubscriptions.size).toBe(0);
    } finally {
      socket.emit("close");
    }
  });
});
