import { createTestUnixSocketServer } from "../helpers/createTestUnixSocketServer";
import {
  ResourceUpdatedBroadcaster,
  type ResourceUpdateTargets,
} from "../../src/server/listChangedBroadcast";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import type { Socket } from "node:net";
import * as net from "node:net";
import * as securePermissions from "../../src/utils/filesystem/securePermissions";
import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import type { DaemonRequest, DaemonResponse, DaemonNotification } from "../../src/daemon/types";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { executionTracker } from "../../src/server/executionTracker";
import { daemonSessionToolBindingStore } from "../../src/server/daemonSessionToolBindingStore";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import {
  getToolCallRecorder,
  getToolCallRecordingStatus,
  resetToolCallRecordingState,
  startToolCallRecording,
} from "../../src/server/toolCallRecordingManager";

interface ServerInternals {
  resourceSubscriptions: Map<string, Set<string>>;
  notificationSubscribers: Set<string>;
  broadcastResourceUpdated(resolve: ResourceUpdateTargets): void;

  handleLocalSocketRequest(request: DaemonRequest): Promise<unknown>;
  acceptingRequests: boolean;
  clientSockets: Map<string, Socket>;
  releaseSocketSession(sessionId: string, socket: Socket): void;
  handleConnection(socket: Socket): void;
  handleRequest(
    sessionId: string,
    socket: Socket,
    request: DaemonRequest,
    receivedAtMs: number,
  ): Promise<DaemonResponse>;
}

class RpcSocket extends FakeSocket {
  setTimeout(_ms: number): this {
    return this;
  }
}

/** A socket server and one registered socket, for driving a disconnect by hand. */
function connectedSocketFixture(socketSessionId: string): {
  internals: ServerInternals;
  socket: Socket;
} {
  const server = createTestUnixSocketServer(
    "/fake/socket",
    "http://127.0.0.1:1/mcp",
    undefined,
    new FakeTimer(),
  );
  const internals = server as unknown as ServerInternals;
  const socket = new RpcSocket() as unknown as Socket;
  internals.clientSockets.set(socketSessionId, socket);
  return { internals, socket };
}

describe("daemon socket transport lifecycle", () => {
  afterEach(() => resetToolCallRecordingState());

  test("ide/status advertises structured session-not-found errors", async () => {
    const server = createTestUnixSocketServer(
      "/fake/socket",
      "http://127.0.0.1:1/mcp",
      undefined,
      new FakeTimer(),
    );
    const internals = server as unknown as ServerInternals;
    await expect(
      internals.handleLocalSocketRequest({
        id: "status-1",
        type: "daemon_request",
        method: "ide/status",
        params: {},
      }),
    ).resolves.toMatchObject({ structuredSessionNotFound: true });
  });

  test("codes a missing socket session without changing its message", async () => {
    const timer = new FakeTimer();
    const server = createTestUnixSocketServer(
      "/fake/socket",
      "http://127.0.0.1:1/mcp",
      undefined,
      timer,
    );
    const internals = server as unknown as ServerInternals;
    await expect(
      internals.handleRequest(
        "missing",
        new RpcSocket() as unknown as Socket,
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
      const server = createTestUnixSocketServer(
        "/fake/socket",
        "http://127.0.0.1:1/mcp",
        undefined,
        timer,
        null,
        {},
        new CountingIdGenerator("recording-socket"),
      );
      const internals = server as unknown as ServerInternals;
      internals.acceptingRequests = true;
      const socket = new RpcSocket();
      internals.handleConnection(socket as unknown as Socket);
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
    const server = createTestUnixSocketServer(
      "/fake/socket",
      "http://127.0.0.1:1/mcp",
      undefined,
      timer,
    );
    const internals = server as unknown as ServerInternals;
    const oldSocket = new RpcSocket() as unknown as Socket;
    const newSocket = new RpcSocket() as unknown as Socket;
    internals.clientSockets.set("reused-id", newSocket);
    startToolCallRecording({ connectionId: "reused-id", timer });
    internals.releaseSocketSession("reused-id", oldSocket);
    expect(getToolCallRecorder({ connectionId: "reused-id" })?.isRecording()).toBe(true);
    internals.releaseSocketSession("reused-id", newSocket);
    expect(getToolCallRecorder({ connectionId: "reused-id" })).toBeNull();
  });

  test("socket disconnect cancels the executions keyed by its session id", async () => {
    const { internals, socket } = connectedSocketFixture("cancel-socket");
    const execution = executionTracker.startExecution("observe", "cancel-socket");
    try {
      internals.releaseSocketSession("cancel-socket", socket);
      await Promise.all([...internals.activeRequestHandlers]);
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
      internals.releaseSocketSession("forget-socket", socket);
      await Promise.all([...internals.activeRequestHandlers]);
      expect(store.keyCount).toBe(baseline);
      expect(store.boundSessionUuid("forget-socket")).toBeUndefined();
    } finally {
      store.forget("forget-socket");
    }
  });

  test("a late binding written by an abort-ignoring handler after disconnect is forgotten when it ends (#13053)", async () => {
    const { internals, socket } = connectedSocketFixture("late-socket");
    const store = daemonSessionToolBindingStore();
    const execution = executionTracker.startExecution("observe", "late-socket");
    try {
      internals.releaseSocketSession("late-socket", socket);
      await Promise.all([...internals.activeRequestHandlers]);
      expect(execution.abortController.signal.aborted).toBe(true);
      // The handler ignored the abort and records its acquisition after the socket is gone.
      store.bind("late-socket", "device-session-late");
      expect(store.boundSessionUuid("late-socket")).toBe("device-session-late");

      executionTracker.endExecution(execution.id);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(store.boundSessionUuid("late-socket")).toBeUndefined();
    } finally {
      executionTracker.endExecution(execution.id);
      store.forget("late-socket");
    }
  });

  test("daemon RPC reader preserves UTF-8 split across socket events", async () => {
    const server = createTestUnixSocketServer(
      "/fake/socket",
      "http://127.0.0.1:1/mcp",
      undefined,
      new FakeTimer(),
    );
    const internals = server as unknown as ServerInternals;
    const socket = new RpcSocket();
    const requests: DaemonRequest[] = [];
    internals.acceptingRequests = true;
    internals.handleRequest = async (_sessionId, _socket, request) => {
      requests.push(request);
      return { id: request.id, type: "mcp_response", success: true, result: "ok" };
    };
    internals.handleConnection(socket as unknown as Socket);
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
    const server = createTestUnixSocketServer(
      "/fake/resource-lifecycle/socket",
      "http://127.0.0.1:1/mcp",
      undefined,
      timer,
      null,
      {},
      new CountingIdGenerator("started-resource"),
      { bindLock: { acquire: () => true, release: () => {} } },
    );
    const internals = server as unknown as ServerInternals;
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
        await internals.handleRequest(
          "started-resource-1",
          socket as unknown as Socket,
          { id: "subscribe", type: "mcp_request", method: "resources/subscribe", params: { uri } },
          timer.now(),
        ),
      ).toMatchObject({ success: true, result: {} });
      emit();
      expect(socket.getWrittenMessages<DaemonNotification>()).toEqual([
        { type: "daemon_notification", method: "notifications/resources/updated", uri },
      ]);
      expect(resolutions).toBe(1);
      await server.close();
      // Repopulate the routing state so clearing it on close cannot mask a leaked listener.
      internals.clientSockets.set("started-resource-1", socket as unknown as Socket);
      internals.resourceSubscriptions.set("started-resource-1", new Set([uri]));
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
    const server = createTestUnixSocketServer(
      "/fake/socket",
      "http://127.0.0.1:1/mcp",
      undefined,
      timer,
      null,
      {},
      new CountingIdGenerator("unknown-resource"),
    );
    const internals = server as unknown as ServerInternals;
    internals.acceptingRequests = true;
    const socket = new RpcSocket();
    internals.handleConnection(socket as unknown as Socket);
    const stop = ResourceUpdatedBroadcaster.subscribe((resolve) =>
      internals.broadcastResourceUpdated(resolve),
    );
    ResourceRegistry.registerTemplate(
      "automobile:known-resource",
      "Known",
      "Known",
      "text/plain",
      async () => ({ uri: "automobile:known-resource", text: "value" }),
    );
    try {
      expect(
        await internals.handleRequest(
          "unknown-resource-1",
          socket as unknown as Socket,
          {
            id: "unknown",
            type: "mcp_request",
            method: "resources/subscribe",
            params: { uri: "unknown" },
          },
          timer.now(),
        ),
      ).toMatchObject({ success: true, result: {} });
      expect(internals.resourceSubscriptions.get("unknown-resource-1")).toEqual(
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
    const server = createTestUnixSocketServer(
      "/fake/socket",
      "http://127.0.0.1:1/mcp",
      undefined,
      timer,
      null,
      {},
      new CountingIdGenerator("resource-socket"),
    );
    const internals = server as unknown as ServerInternals;
    internals.acceptingRequests = true;
    const first = new RpcSocket();
    const second = new RpcSocket();
    const third = new RpcSocket();
    internals.handleConnection(first as unknown as Socket);
    internals.handleConnection(second as unknown as Socket);
    internals.handleConnection(third as unknown as Socket);
    const canonical = "automobile:socket/one?appId=x";
    const page = `${canonical}&limit=10&offset=0`;
    ResourceRegistry.registerTemplate(
      "automobile:socket/{id}{?appId,limit,offset}",
      "Socket",
      "Socket",
      "text/plain",
      async () => ({ uri: canonical, text: "value" }),
      ["limit", "offset"],
    );
    const stop = ResourceUpdatedBroadcaster.subscribe((resolve) =>
      internals.broadcastResourceUpdated(resolve),
    );
    const request = (sessionId: string, socket: RpcSocket, method: string, uri: string) =>
      internals.handleRequest(
        sessionId,
        socket as unknown as Socket,
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
      expect(first.getWrittenMessages<DaemonNotification>()).toEqual([
        { type: "daemon_notification", method: "notifications/resources/updated", uri: page },
      ]);
      expect(second.getWrittenMessages()).toEqual([]);
      expect(third.getWrittenMessages()).toEqual([]);
      await ResourceRegistry.notifyResourceUpdated("automobile:socket/two?appId=x");
      expect(second.getWrittenMessages<DaemonNotification>()[0]?.uri).toBe(
        "automobile:socket/two?appId=x",
      );
      expect(
        await request("resource-socket-1", first, "resources/unsubscribe", page),
      ).toMatchObject({ success: true, result: {} });
      await ResourceRegistry.notifyResourceUpdated(canonical);
      expect(first.getWrittenMessages()).toHaveLength(1);
      expect(internals.resourceSubscriptions.has("resource-socket-1")).toBe(false);
      internals.notificationSubscribers.add("resource-socket-2");
      second.emit("close");
      expect(internals.resourceSubscriptions.size).toBe(0);
      expect(internals.notificationSubscribers.size).toBe(0);
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
    const server = createTestUnixSocketServer(
      "/fake/socket",
      "http://127.0.0.1:1/mcp",
      undefined,
      timer,
      null,
      {},
      new CountingIdGenerator("invalid-resource"),
    );
    const internals = server as unknown as ServerInternals;
    const socket = new RpcSocket();
    internals.acceptingRequests = true;
    internals.handleConnection(socket as unknown as Socket);
    try {
      expect(
        await internals.handleRequest(
          "invalid-resource-1",
          socket as unknown as Socket,
          { id: "invalid", type: "mcp_request", method: "resources/subscribe", params: {} },
          timer.now(),
        ),
      ).toMatchObject({ success: false, error: "Resource subscription requires params.uri" });
      expect(internals.resourceSubscriptions.size).toBe(0);
    } finally {
      socket.emit("close");
    }
  });
});
