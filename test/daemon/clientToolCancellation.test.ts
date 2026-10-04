import { describe, expect, spyOn, test } from "bun:test";
import { DaemonClient } from "../../src/daemon/client";
import type { DaemonRequest } from "../../src/daemon/types";
import { DAEMON_CANCEL_REQUEST_METHOD } from "../../src/daemon/constants";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

function setup() {
  const timer = new FakeTimer();
  const socket = new FakeSocket();
  const client = new DaemonClient("/fake/socket", 1000, timer, {}, null, new FakeIdGenerator());
  client.attachSocketForTesting(socket);
  const respond = (id: string) =>
    client.simulateIncomingDataForTesting(
      Buffer.from(
        JSON.stringify({ id, type: "mcp_response", success: true, result: { ok: true } }) + "\n",
      ),
    );
  return { client, socket, timer, respond };
}

describe("DaemonClient tool cancellation", () => {
  test("readResource abort sends one mapped cancel frame and preserves a no-signal sibling", async () => {
    const { client, socket, timer, respond } = setup();
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const cancelled = client
      .readResource(
        "automobile:devices/booted",
        { sessionUuid: "session-a" },
        { signal: controller.signal },
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const sibling = client.readResource("automobile:devices/booted");
    const [first, second] = socket.getWrittenMessages<DaemonRequest>();
    try {
      expect(first).toMatchObject({
        method: "resources/read",
        params: { uri: "automobile:devices/booted", sessionUuid: "session-a" },
      });
      controller.abort(new Error("cancel daemon resource read"));
      expect(client.hasPendingRequestForTesting(first.id)).toBe(false);
      expect(await cancelled).toBe(controller.signal.reason);
      const frames = socket.getWrittenMessages<DaemonRequest>();
      expect(frames).toHaveLength(3);
      expect(frames[2]).toMatchObject({
        method: DAEMON_CANCEL_REQUEST_METHOD,
        params: { requestId: first.id },
      });
      expect(socket.destroyed).toBe(false);
      expect(client.hasPendingRequestForTesting(second.id)).toBe(true);
      respond(first.id);
      respond(frames[2].id);
      respond(second.id);
      expect(await sibling).toEqual({ ok: true });
      timer.advanceTime(120_000);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(socket.getWrittenMessages()).toHaveLength(3);
      expect(remove).toHaveBeenCalled();
    } finally {
      respond(first.id);
      respond(second.id);
      await cancelled;
      await sibling;
      remove.mockRestore();
      await client.close();
    }
  });

  test("an already aborted resource read does not connect or write", async () => {
    const { client, socket, timer } = setup();
    const controller = new AbortController();
    controller.abort(new Error("resource already cancelled"));
    try {
      await expect(
        client.readResource("automobile:devices/booted", {}, { signal: controller.signal }),
      ).rejects.toThrow("resource already cancelled");
      expect(socket.getWrittenMessages()).toHaveLength(0);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("a completed resource read sends no cancel frame when aborted", async () => {
    const { client, socket, timer, respond } = setup();
    const controller = new AbortController();
    const result = client.readResource(
      "automobile:devices/booted",
      {},
      { signal: controller.signal },
    );
    try {
      respond(socket.getWrittenMessages<DaemonRequest>()[0].id);
      controller.abort();
      expect(await result).toEqual({ ok: true });
      expect(socket.getWrittenMessages()).toHaveLength(1);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("aborts only the mapped request, sends one frame, and ignores late answers", async () => {
    const { client, socket, timer, respond } = setup();
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const cancelled = client.callTool("tapOn", {}, undefined, undefined, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    const sibling = client.callTool("tapOn", {});
    const [first, second] = socket.getWrittenMessages<DaemonRequest>();
    controller.abort(new Error("client cancelled"));
    expect(await cancelled).toEqual(controller.signal.reason);
    const frames = socket.getWrittenMessages<DaemonRequest>();
    expect(frames).toHaveLength(3);
    expect(frames[2]).toMatchObject({
      method: DAEMON_CANCEL_REQUEST_METHOD,
      params: { requestId: first.id },
    });
    expect(client.hasPendingRequestForTesting(first.id)).toBe(false);
    expect(client.hasPendingRequestForTesting(second.id)).toBe(true);
    respond(first.id);
    respond(frames[2].id);
    respond(second.id);
    expect(await sibling).toEqual({ ok: true });
    timer.advanceTime(120_000);
    expect(socket.getWrittenMessages()).toHaveLength(3);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(remove).toHaveBeenCalled();
    remove.mockRestore();
    await client.close();
  });

  test("an abort after the response, even before promise cleanup, sends no cancel", async () => {
    const { client, socket, respond } = setup();
    const controller = new AbortController();
    const result = client.callTool("tapOn", {}, undefined, undefined, controller.signal);
    respond(socket.getWrittenMessages<DaemonRequest>()[0].id);
    controller.abort();
    expect(await result).toEqual({ ok: true });
    expect(socket.getWrittenMessages()).toHaveLength(1);
    await client.close();
  });

  test("an already aborted call does not connect or write", async () => {
    const { client, socket, timer } = setup();
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(
      client.callTool("tapOn", {}, undefined, undefined, controller.signal),
    ).rejects.toThrow("already cancelled");
    expect(socket.getWrittenMessages()).toHaveLength(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    await client.close();
  });

  test("abort during connection stops waiting and prevents a later write", async () => {
    const { client, socket } = setup();
    await client.close();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const nextSocket = new FakeSocket();
    client.connect = async () => {
      started.resolve();
      await gate.promise;
      client.attachSocketForTesting(nextSocket);
    };
    const controller = new AbortController();
    const result = client.callTool("tapOn", {}, undefined, undefined, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await started.promise;
    controller.abort(new Error("cancel during connect"));
    expect(await result).toEqual(controller.signal.reason);
    gate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(nextSocket.getWrittenMessages()).toHaveLength(0);
    expect(socket.destroyed).toBe(true);
    await client.close();
  });
});
