import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import {
  MAX_PROTOTYPE_ASSET_BYTES,
  MAX_PROTOTYPE_ASSET_ID_LENGTH,
} from "../../../../src/features/prototype/prototypeAssets";
import { ActionableError } from "../../../../src/models/ActionableError";
import { PortManager } from "../../../../src/utils/PortManager";
import { logger } from "../../../../src/utils/logger";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeInstalledAppsRepository } from "../../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

const clients: AndroidCtrlProxyClient[] = [];
const ASSET_COMMANDS = [
  "full_command_set_v1",
  "request_id_echo_v1",
  "put_prototype_asset",
  "remove_prototype_asset",
];

async function harness(commands: string[] | null = ASSET_COMMANDS) {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const socket = new FakeWebSocket("ws://fake", "none", 0, timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "asset-test", platform: "android", name: "Android", isEmulator: true },
    new FakeAdbExecutor(),
    () => socket,
    timer,
    new FakeInstalledAppsRepository(),
  );
  clients.push(client);
  await Promise.resolve();
  client["ws"] = socket as unknown as WebSocket;
  spyOn(client, "ensureConnected").mockResolvedValue(true);
  const receive = (frame: object) => client["handleWebSocketMessage"](JSON.stringify(frame));
  if (commands !== null) {
    await receive({ type: "connected", supportedCommands: commands });
  }
  return { client, socket, timer, receive };
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  PortManager.setPortAvailabilityCheckerForTesting(null);
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const pngBase64 = Buffer.from(png).toString("base64");
const asset = { id: "hero", mimeType: "image/png" as const, bytes: png };

/** Records frames written to the socket without answering them. */
function captureSend(socket: FakeWebSocket) {
  const frames: Array<Record<string, unknown>> = [];
  const send = spyOn(socket, "send").mockImplementation((data) => {
    frames.push(JSON.parse(String(data)));
  });
  return { frames, send };
}

function answer(
  receive: (frame: object) => Promise<unknown>,
  frame: Record<string, unknown>,
  reply: { success: boolean; error?: string | null },
) {
  return receive({ type: "prototype_result", timestamp: 42, requestId: frame.requestId, ...reply });
}

/** Bounded microtask drain: lets the request reach the socket without wall-clock waits. */
async function flush() {
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve();
  }
}

describe("CtrlProxy prototype assets", () => {
  test("put sends base64 in one text frame and a success reply is acknowledged", async () => {
    const { client, socket, receive } = await harness();
    const { frames } = captureSend(socket);
    const dispatches: number[] = [];
    const pending = client.requestPutPrototypeAsset(asset, {
      onDispatch: () => dispatches.push(1),
    });
    await flush();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "put_prototype_asset",
      id: "hero",
      mimeType: "image/png",
      dataBase64: pngBase64,
    });
    expect(Object.keys(frames[0]).sort()).toEqual(
      ["dataBase64", "id", "mimeType", "requestId", "type"].sort(),
    );
    expect(dispatches).toEqual([1]);
    await answer(receive, frames[0], { success: true, error: null });
    expect(await pending).toMatchObject({
      success: true,
      dispatched: true,
      acknowledged: true,
      requestId: frames[0].requestId,
    });
    expect(client["requestManager"].getPendingCount()).toBe(0);
  });

  test("put encodes only the view's bytes, not the pool behind it", async () => {
    const { client, socket, receive } = await harness();
    const { frames } = captureSend(socket);
    const pool = new Uint8Array(64).fill(7);
    pool.set(png, 10);
    const pending = client.requestPutPrototypeAsset({
      ...asset,
      bytes: pool.subarray(10, 10 + png.length),
    });
    await flush();
    expect(frames[0].dataBase64).toBe(pngBase64);
    await answer(receive, frames[0], { success: true });
    await pending;
  });

  test("remove sends the id and is acknowledged", async () => {
    const { client, socket, receive } = await harness();
    const { frames } = captureSend(socket);
    const pending = client.requestRemovePrototypeAsset("hero");
    await flush();
    expect(frames[0]).toMatchObject({ type: "remove_prototype_asset", id: "hero" });
    expect(Object.keys(frames[0]).sort()).toEqual(["id", "requestId", "type"]);
    await answer(receive, frames[0], { success: true });
    expect(await pending).toMatchObject({ success: true, dispatched: true, acknowledged: true });
  });

  test("a device refusal is a plain failure, not indeterminate", async () => {
    const { client, socket, receive } = await harness();
    const { frames } = captureSend(socket);
    const pending = client.requestPutPrototypeAsset(asset);
    await flush();
    await answer(receive, frames[0], { success: false, error: "Prototype asset storage full" });
    const result = await pending;
    expect(result).toMatchObject({
      success: false,
      error: "Prototype asset storage full",
      dispatched: true,
      acknowledged: true,
    });
    expect(result.error).not.toContain("indeterminate");
  });

  test("a correlated protocol error frame is also a plain acknowledged failure", async () => {
    const { client, socket, receive } = await harness();
    const { frames } = captureSend(socket);
    const pending = client.requestRemovePrototypeAsset("hero");
    await flush();
    await receive({
      type: "error",
      requestId: frames[0].requestId,
      error: "Malformed request: id",
    });
    expect(await pending).toMatchObject({
      success: false,
      error: "Malformed request: id",
      dispatched: true,
      acknowledged: true,
    });
  });

  test("a dispatched request with no reply is indeterminate after the timeout", async () => {
    const { client, socket, timer } = await harness();
    const { frames } = captureSend(socket);
    const pending = client.requestPutPrototypeAsset(asset, { timeoutMs: 50 });
    await flush();
    expect(frames).toHaveLength(1);
    timer.advanceTime(50);
    const result = await pending;
    expect(result).toMatchObject({ success: false, dispatched: true, acknowledged: false });
    expect(result.error).toContain("Upload of prototype asset 'hero' outcome is indeterminate");
    expect(result.error).toContain("timed out after 50ms");
    expect(client["requestManager"].getPendingCount()).toBe(0);
  });

  test("abort after dispatch is indeterminate and clears the waiter", async () => {
    const { client, socket } = await harness();
    const { frames } = captureSend(socket);
    const controller = new AbortController();
    const pending = client.requestRemovePrototypeAsset("hero", { abortSignal: controller.signal });
    await flush();
    expect(frames).toHaveLength(1);
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ success: false, dispatched: true, acknowledged: false });
    expect(result.error).toContain("Removal of prototype asset 'hero' outcome is indeterminate");
    expect(client["requestManager"].getPendingCount()).toBe(0);
  });

  test("abort before dispatch sends nothing and is not indeterminate", async () => {
    const { client, socket } = await harness();
    const { frames, send } = captureSend(socket);
    const controller = new AbortController();
    controller.abort();
    const result = await client.requestPutPrototypeAsset(asset, { abortSignal: controller.signal });
    expect(result).toMatchObject({ success: false, dispatched: false, acknowledged: false });
    expect(result.error).not.toContain("indeterminate");
    expect(frames).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });

  test("not connected is an undispatched failure", async () => {
    const { client, socket } = await harness();
    spyOn(client, "ensureConnected").mockResolvedValue(false);
    const send = spyOn(socket, "send");
    expect(await client.requestPutPrototypeAsset(asset)).toEqual({
      success: false,
      error: "Not connected",
      totalTimeMs: 0,
      dispatched: false,
      acknowledged: false,
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("a connection failure is an undispatched failure rather than a throw", async () => {
    const { client } = await harness();
    spyOn(client, "ensureConnected").mockRejectedValue(new Error("adb forward failed"));
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await client.requestRemovePrototypeAsset("hero")).toMatchObject({
        success: false,
        dispatched: false,
        acknowledged: false,
      });
    } finally {
      warn.mockRestore();
    }
  });

  test.each([
    { label: "no handshake commands", commands: [] as string[] },
    {
      label: "full set without asset requests",
      commands: ["full_command_set_v1", "show_prototype", "dismiss_prototype"],
    },
  ])("older device ($label) is never sent an asset request", async ({ commands }) => {
    const { client, socket } = await harness(commands);
    const send = spyOn(socket, "send");
    await expect(client.requestPutPrototypeAsset(asset)).rejects.toBeInstanceOf(ActionableError);
    await expect(client.requestPutPrototypeAsset(asset)).rejects.toThrow(
      "this CtrlProxy build does not support prototype assets",
    );
    await expect(client.requestRemovePrototypeAsset("hero")).rejects.toThrow(
      "remove_prototype_asset",
    );
    expect(send).not.toHaveBeenCalled();
  });

  test("a device that advertises only put still refuses remove before sending", async () => {
    const { client, socket } = await harness(["full_command_set_v1", "put_prototype_asset"]);
    const send = spyOn(socket, "send");
    await expect(client.requestRemovePrototypeAsset("hero")).rejects.toThrow(
      "remove_prototype_asset",
    );
    expect(send).not.toHaveBeenCalled();
  });

  test.each([
    { label: "unsupported MIME type", change: { mimeType: "image/gif" as "image/png" } },
    { label: "uppercase MIME type", change: { mimeType: "IMAGE/PNG" as "image/png" } },
    { label: "empty bytes", change: { bytes: new Uint8Array(0) } },
    { label: "oversized bytes", change: { bytes: new Uint8Array(MAX_PROTOTYPE_ASSET_BYTES + 1) } },
    { label: "empty id", change: { id: "" } },
    { label: "overlong id", change: { id: "x".repeat(MAX_PROTOTYPE_ASSET_ID_LENGTH + 1) } },
  ])("invalid upload ($label) throws before dispatch", async ({ change }) => {
    const { client, socket } = await harness();
    const send = spyOn(socket, "send");
    await expect(client.requestPutPrototypeAsset({ ...asset, ...change })).rejects.toBeInstanceOf(
      ActionableError,
    );
    await expect(client.requestPutPrototypeAsset({ ...asset, ...change })).rejects.toThrow(
      "Invalid prototype asset",
    );
    expect(send).not.toHaveBeenCalled();
  });

  test("an asset exactly at the per-asset limit is accepted", async () => {
    const { client, socket, receive } = await harness();
    const { frames } = captureSend(socket);
    const pending = client.requestPutPrototypeAsset({
      ...asset,
      bytes: new Uint8Array(MAX_PROTOTYPE_ASSET_BYTES),
    });
    await flush();
    expect(frames).toHaveLength(1);
    await answer(receive, frames[0], { success: true });
    expect(await pending).toMatchObject({ success: true });
  });

  test("invalid remove id throws before dispatch", async () => {
    const { client, socket } = await harness();
    const send = spyOn(socket, "send");
    await expect(client.requestRemovePrototypeAsset("")).rejects.toBeInstanceOf(ActionableError);
    expect(send).not.toHaveBeenCalled();
  });

  test("asset bytes never reach the log, even on failure", async () => {
    const { client, socket, timer } = await harness();
    captureSend(socket);
    const logged: string[] = [];
    const spies = (["debug", "info", "warn", "error"] as const).map((level) =>
      spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(" "));
      }),
    );
    try {
      const pending = client.requestPutPrototypeAsset(asset, { timeoutMs: 50 });
      await flush();
      timer.advanceTime(50);
      await pending;
      const controller = new AbortController();
      controller.abort();
      await client.requestPutPrototypeAsset(asset, { abortSignal: controller.signal });
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
    expect(logged.some((line) => line.includes(pngBase64))).toBe(false);
  });

  test("an old device that rejects the command keeps the device cause", async () => {
    const { client, socket, receive } = await harness(null);
    const { frames } = captureSend(socket);
    const pending = client.requestPutPrototypeAsset(asset);
    await flush();
    await receive({
      type: "error",
      requestId: frames[0].requestId,
      error: "Unknown command type: put_prototype_asset",
    });
    expect(await pending).toMatchObject({
      success: false,
      error: "Unknown command type: put_prototype_asset",
      acknowledged: true,
    });
    await expect(client.requestPutPrototypeAsset(asset)).rejects.toThrow("put_prototype_asset");
  });

  test("fake records asset calls and returns the configured result", async () => {
    const fake = new FakeCtrlProxy(new FakeTimer());
    expect(await fake.requestPutPrototypeAsset(asset, { timeoutMs: 9 })).toEqual({
      success: true,
      dispatched: true,
      acknowledged: true,
    });
    const refusal = { success: false, error: "full", dispatched: true, acknowledged: true };
    fake.setPrototypeAssetResult(refusal);
    expect(await fake.requestRemovePrototypeAsset("hero")).toEqual(refusal);
    expect(fake.getPrototypeAssetHistory()).toEqual([
      { method: "put", asset, options: { timeoutMs: 9 } },
      { method: "remove", id: "hero", options: undefined },
    ]);
  });
});
