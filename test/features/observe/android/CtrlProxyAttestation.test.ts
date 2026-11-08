import { expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android/AndroidCtrlProxyClient";
import { EXPORT_ATTESTATION_MIN_CTRL_PROXY_VERSION } from "../../../../src/features/observe/android/CtrlProxyStorage";
import { CountingIdGenerator } from "../../../../src/utils/IdGenerator";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeInstalledAppsRepository } from "../../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

class RecordingSocket extends FakeWebSocket {
  frames: string[] = [];
  override send(data: string): void {
    super.send(data);
    this.frames.push(data);
  }
}
async function harness(supported = true) {
  const timer = new FakeTimer();
  const socket = new RecordingSocket("ws://fake", "none", 0, timer);
  const client = AndroidCtrlProxyClient.createForTesting(
    { deviceId: "attestation-test", platform: "android", name: "Android" },
    new FakeAdbExecutor(),
    {
      webSocketFactory: () => socket,
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      idGenerator: new CountingIdGenerator("attestation"),
    },
  );
  await Promise.resolve();
  timer.advanceTime(1);
  client.connectionTestHooks.socket = socket;
  client.connectionTestHooks.supportedCommands = new Set(supported ? ["export_attestation"] : []);
  client.ensureConnected = async () => true;
  return { client, timer, socket };
}
async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
  }
}

test("attestation command round-trips the correlated public chain", async () => {
  const { client, timer, socket } = await harness();
  const pending = client.exportAttestation();
  await flush();
  const frame = JSON.parse(socket.frames[0]);
  expect(frame.type).toBe("export_attestation");
  expect(Object.keys(frame).sort()).toEqual(["requestId", "type"]);
  await client.testHooks.handleWebSocketMessage(
    JSON.stringify({
      type: "attestation_chain",
      requestId: frame.requestId,
      timestamp: 1,
      certificateChainBase64: ["leaf", "root"],
    }),
  );
  expect(await pending).toEqual(["leaf", "root"]);
  expect(timer.getSleepHistory()).toEqual([]);
});
test("old CtrlProxy is refused before sending", async () => {
  const { client, socket } = await harness(false);
  const error = await client.exportAttestation().then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain("installed CtrlProxy is too old");
  expect(message).toContain(`CtrlProxy ${EXPORT_ATTESTATION_MIN_CTRL_PROXY_VERSION} or newer`);
  expect(socket.frames).toEqual([]);
});
test("deadline and Android errors reject without waiting in real time", async () => {
  const { client, timer, socket } = await harness();
  const pending = client.exportAttestation();
  await flush();
  timer.advanceTime(15000);
  await expect(pending).rejects.toThrow("timed out");
  const next = client.exportAttestation();
  await flush();
  const frame = JSON.parse(socket.frames.at(-1)!);
  await client.testHooks.handleWebSocketMessage(
    JSON.stringify({
      type: "error",
      requestId: frame.requestId,
      timestamp: 1,
      message: "Attestation unavailable",
      error: "Attestation unavailable",
    }),
  );
  await expect(next).rejects.toThrow();
  expect(timer.getSleepHistory()).toEqual([]);
});
test("malformed and incomplete wire payloads reject", async () => {
  for (const chain of [[], ["leaf"], "bad", [1, 2]]) {
    const { client, socket } = await harness();
    const pending = client.exportAttestation();
    await flush();
    const frame = JSON.parse(socket.frames[0]);
    await client.testHooks.handleWebSocketMessage(
      JSON.stringify({
        type: "attestation_chain",
        requestId: frame.requestId,
        timestamp: 1,
        certificateChainBase64: chain,
      }),
    );
    await expect(pending).rejects.toThrow();
  }
});
