import { afterEach, expect, test } from "bun:test";
import { createDeviceCaptureRegistry } from "../../src/features/webrtc/deviceCaptureRegistry";
import type {
  H264CaptureSourceOptions,
  H264CaptureSourceTelemetry,
} from "../../src/features/webrtc/H264CaptureSource";
import type { WebRtcPublisher } from "../../src/features/webrtc/WebRtcPublisher";
import {
  getWebRtcStreamDescriptor,
  resetWebRtcStreamManager,
  setWebRtcStreamManagerDependencies,
  startWebRtcStream,
  stopWebRtcStream,
} from "../../src/server/webrtcStreamManager";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
const device = { deviceId: "telemetry-device", platform: "ios", name: "iPhone" } as BootedDevice;
const counters: H264CaptureSourceTelemetry = {
  lastEncodedFrameTimestampUs: 10,
  lastIdrTimestampUs: 11,
  idrRequestCount: 12,
  idrCompletionCount: 13,
  encodedAccessUnitCount: 14,
};
afterEach(() => resetWebRtcStreamManager());
function install(telemetry?: H264CaptureSourceTelemetry) {
  const registry = createDeviceCaptureRegistry();
  const chunks: Buffer[] = [];
  const failures: Error[] = [];
  const options: H264CaptureSourceOptions[] = [];
  setWebRtcStreamManagerDependencies({
    captureRegistry: registry,
    timer: new FakeTimer(),
    resolveVideoJar: async () => null,
    now: () => new Date("2026-10-05T00:00:00Z"),
    createSource: (value) => {
      options.push(value);
      return {
        start: async () => {},
        stop: async () => {},
        ...(telemetry ? { getTelemetry: () => telemetry } : {}),
      };
    },
    createPublisher: (config) =>
      ({
        start: async () => {},
        stop: async () => {},
        notifySourceFailed: (error: Error) => failures.push(error),
        writeH264Chunk: (chunk: Buffer) => chunks.push(chunk),
        primeH264ParameterSets: () => {},
        getDescriptor: () => ({
          streamId: config.streamId,
          state: "idle",
          iceServers: [],
          readiness: { ...counters },
        }),
      }) as unknown as WebRtcPublisher,
  });
  return { registry, chunks, failures, options };
}
for (const precise of [false, true]) {
  test(`single consumer preserves publisher counters or forwards precise telemetry (precise=${precise})`, async () => {
    const exact = { ...counters, encodedAccessUnitCount: 99 };
    install(precise ? exact : undefined);
    const stream = await startWebRtcStream({
      device,
      overrides: { whipEndpoint: "https://example.test/whip" },
    });
    expect(getWebRtcStreamDescriptor(stream.streamId)!.readiness.encodedAccessUnitCount).toBe(
      precise ? 99 : 14,
    );
    expect(getWebRtcStreamDescriptor(stream.streamId)!.readiness.idrRequestCount).toBe(12);
    await stopWebRtcStream(stream.streamId);
  });
}
test("manager replay feeds publisher without first-media evidence", async () => {
  const h = install();
  const stream = await startWebRtcStream({
    device,
    overrides: { whipEndpoint: "https://example.test/whip" },
  });
  const sps = Buffer.from([0, 0, 0, 1, 7, 11]),
    pps = Buffer.from([0, 0, 0, 1, 8, 12]);
  h.options[0].onReplayData?.(sps);
  h.options[0].onReplayData?.(pps);
  expect(h.chunks).toEqual([sps, pps]);
  expect(getWebRtcStreamDescriptor(stream.streamId)!.telemetry.firstMediaFrame).toBeUndefined();
  h.options[0].onData(Buffer.from([0, 0, 0, 1, 5, 128]));
  expect(getWebRtcStreamDescriptor(stream.streamId)!.telemetry.firstMediaFrame).toBe(
    "2026-10-05T00:00:00.000Z",
  );
  await stopWebRtcStream(stream.streamId);
});
test("stale shared peer preserves manager fatal-source handling", async () => {
  const h = install();
  const owner = h.registry.acquire({
    device,
    options: { device, onData: () => {}, fps: 15, bitrateBps: 1000000, onFrameMetrics: () => {} },
    create: () => ({ start: async () => {}, stop: async () => {}, stopStale: async () => {} }),
  });
  await owner.start();
  const stream = await startWebRtcStream({
    device,
    overrides: { whipEndpoint: "https://example.test/whip", bitrateKbps: 1000 },
  });
  expect(h.options).toHaveLength(0);
  await owner.stopStale!(true);
  expect(h.failures).toHaveLength(1);
  const descriptor = getWebRtcStreamDescriptor(stream.streamId)!;
  expect(descriptor.readiness.captureSourceState).toBe("failed");
  expect(descriptor.lifecycleState).toBe("degraded");
  await stopWebRtcStream(stream.streamId);
});
