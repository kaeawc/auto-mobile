import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { AndroidPrototypeTransport } from "../../../../src/features/prototype/androidPrototypeTransport";
import {
  type PrototypeMediaFileOpener,
  uploadPrototypeMediaAsset,
} from "../../../../src/features/prototype/prototypeMediaUpload";
import { ActionableError } from "../../../../src/models/ActionableError";
import { PortManager } from "../../../../src/utils/PortManager";
import { logger } from "../../../../src/utils/logger";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeInstalledAppsRepository } from "../../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

const clients: AndroidCtrlProxyClient[] = [];
const MEDIA_COMMANDS = [
  "full_command_set_v1",
  "request_id_echo_v1",
  "put_prototype_asset_begin",
  "put_prototype_asset_chunk",
  "put_prototype_asset_commit",
  "put_prototype_asset_abort",
];

async function harness(commands: string[] = MEDIA_COMMANDS) {
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  const timer = new FakeTimer();
  const socket = new FakeWebSocket("ws://fake", "none", 0, timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "media-test", platform: "android", name: "Android" },
    new FakeAdbExecutor(),
    {
      webSocketFactory: () => socket,
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
    },
  );
  clients.push(client);
  await Promise.resolve();
  client.connectionTestHooks.socket = socket;
  spyOn(client, "ensureConnected").mockResolvedValue(true);
  const receive = (frame: object) => client.testHooks.handleWebSocketMessage(JSON.stringify(frame));
  await receive({ type: "connected", supportedCommands: commands });
  const frames: Array<Record<string, unknown>> = [];
  spyOn(socket, "send").mockImplementation((data) => {
    frames.push(JSON.parse(String(data)));
  });
  return { client, timer, receive, frames };
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  PortManager.setPortAvailabilityCheckerForTesting(null);
});

/** Bounded microtask drain: lets the request reach the socket without wall-clock waits. */
async function flush() {
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve();
  }
}

const begin = {
  type: "put_prototype_asset_begin" as const,
  id: "clip",
  mimeType: "video/mp4" as const,
  size: 24,
  sha256: "a".repeat(64),
};

describe("CtrlProxy prototype media upload messages", () => {
  test("a message is sent with exactly its wire fields and a success reply resolves", async () => {
    const { client, receive, frames } = await harness();
    const pending = client.requestPrototypeMediaMessage(begin);
    await flush();
    expect(frames).toHaveLength(1);
    expect(Object.keys(frames[0]).sort()).toEqual(
      ["id", "mimeType", "requestId", "sha256", "size", "type"].sort(),
    );
    expect(frames[0]).toMatchObject(begin);
    await receive({ type: "prototype_result", requestId: frames[0].requestId, success: true });
    expect(await pending).toEqual({ success: true });
  });

  test("a refusal carries the device's rejection code", async () => {
    const { client, receive, frames } = await harness();
    const pending = client.requestPrototypeMediaMessage({
      type: "put_prototype_asset_commit",
      id: "clip",
    });
    await flush();
    await receive({
      type: "prototype_result",
      requestId: frames[0].requestId,
      success: false,
      error: "Media bytes do not match the declared sha256.",
      mediaCode: "sha256_mismatch",
    });
    expect(await pending).toEqual({
      success: false,
      code: "sha256_mismatch",
      error: "Media bytes do not match the declared sha256.",
    });
  });

  test("an unknown rejection code is dropped, not trusted", async () => {
    const { client, receive, frames } = await harness();
    const pending = client.requestPrototypeMediaMessage({
      type: "put_prototype_asset_abort",
      id: "clip",
    });
    await flush();
    await receive({
      type: "prototype_result",
      requestId: frames[0].requestId,
      success: false,
      error: "nope",
      mediaCode: "future_code",
    });
    expect(await pending).toEqual({ success: false, error: "nope" });
  });

  test("a sent message that is never answered throws, so the uploader aborts", async () => {
    const { client, timer, frames } = await harness();
    const pending = client.requestPrototypeMediaMessage(begin, { timeoutMs: 50 });
    await flush();
    expect(frames).toHaveLength(1);
    timer.advanceTime(50);
    await expect(pending).rejects.toThrow(
      "put_prototype_asset_begin for media asset 'clip' was sent but not answered (timed out after 50ms).",
    );
    expect(client.connectionTestHooks.requestManager.getPendingCount()).toBe(0);
  });

  test("an abort before dispatch sends nothing and resolves a plain failure", async () => {
    const { client, frames } = await harness();
    const controller = new AbortController();
    controller.abort();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await client.requestPrototypeMediaMessage(begin, {
        abortSignal: controller.signal,
      });
      expect(result.success).toBe(false);
    } finally {
      warn.mockRestore();
    }
    expect(frames).toHaveLength(0);
  });

  test("not connected resolves a failure without sending", async () => {
    const { client, frames } = await harness();
    spyOn(client, "ensureConnected").mockResolvedValue(false);
    expect(await client.requestPrototypeMediaMessage(begin)).toEqual({
      success: false,
      error: "Not connected",
    });
    expect(frames).toHaveLength(0);
  });

  test("an older CtrlProxy without media requests is refused before sending", async () => {
    const { client, frames } = await harness(["full_command_set_v1", "put_prototype_asset"]);
    await expect(client.requestPrototypeMediaMessage(begin)).rejects.toBeInstanceOf(
      ActionableError,
    );
    await expect(client.requestPrototypeMediaMessage(begin)).rejects.toThrow(
      "put_prototype_asset_begin: this CtrlProxy build does not support prototype media assets",
    );
    expect(frames).toHaveLength(0);
  });

  test("the uploader streams begin, chunks and commit through the Android transport", async () => {
    const { client, receive, frames } = await harness();
    const mp4 = new Uint8Array([
      0,
      0,
      0,
      0x18,
      ...Buffer.from("ftypisom"),
      ...new Array(30).fill(5),
    ]);
    const opener: PrototypeMediaFileOpener = {
      open: async () => ({
        size: mp4.length,
        read: async (offset, length) => mp4.slice(offset, offset + length),
        close: async () => {},
      }),
    };
    const transport = new AndroidPrototypeTransport(client);
    const upload = uploadPrototypeMediaAsset(
      transport,
      { id: "clip", path: "/clips/intro.mp4" },
      { opener, chunkBytes: 16 },
    );
    for (let answered = 0; answered < 5; answered++) {
      await flush();
      expect(frames).toHaveLength(answered + 1);
      await receive({
        type: "prototype_result",
        requestId: frames[answered].requestId,
        success: true,
      });
    }
    expect(await upload).toEqual({ success: true, id: "clip", mimeType: "video/mp4", bytes: 42 });
    expect(frames.map((frame) => [frame.type, frame.offset])).toEqual([
      ["put_prototype_asset_begin", undefined],
      ["put_prototype_asset_chunk", 0],
      ["put_prototype_asset_chunk", 16],
      ["put_prototype_asset_chunk", 32],
      ["put_prototype_asset_commit", undefined],
    ]);
    expect(frames[0].sha256).toBe(createHash("sha256").update(mp4).digest("hex"));
    const sent = Buffer.concat(
      frames.slice(1, 4).map((frame) => Buffer.from(String(frame.dataBase64), "base64")),
    );
    expect([...sent]).toEqual([...mp4]);
  });
});

describe("AndroidPrototypeTransport media messages", () => {
  test("forward to the CtrlProxy client", async () => {
    const proxy = new FakeCtrlProxy();
    proxy.setPrototypeMediaReply((message) =>
      message.type === "put_prototype_asset_commit"
        ? { success: false, code: "truncated", error: "Received 0 of 24 bytes." }
        : { success: true },
    );
    const transport = new AndroidPrototypeTransport(proxy);
    expect(await transport.sendPrototypeMediaMessage(begin)).toEqual({ success: true });
    expect(
      await transport.sendPrototypeMediaMessage({ type: "put_prototype_asset_commit", id: "clip" }),
    ).toEqual({ success: false, code: "truncated", error: "Received 0 of 24 bytes." });
    expect(proxy.getPrototypeMediaHistory().map((message) => message.type)).toEqual([
      "put_prototype_asset_begin",
      "put_prototype_asset_commit",
    ]);
  });
});
