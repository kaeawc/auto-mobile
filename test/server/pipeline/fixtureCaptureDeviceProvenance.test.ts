import { describe, expect, test } from "bun:test";
import type { BootedDevice, DeviceInfo } from "../../../src/models";
import {
  invokeResolvedDeviceHandler,
  type AdmittedImageReads,
} from "../../../src/server/pipeline/deviceCallDispatch";
import type { ToolCallCapture } from "../../../src/utils/fixtureCapture/fixtureCaptureFormat";
import type { FixtureCaptureWriter } from "../../../src/utils/fixtureCapture/FixtureCaptureWriter";
import { runWithFixtureCapture } from "../../../src/utils/fixtureCapture/fixtureCaptureScope";
import {
  buildPromotion,
  parseCapture,
  parseFixtureDestination,
} from "../../../scripts/fixtures/promote-capture";
import { FakeTimer } from "../../fakes/FakeTimer";

class FakeCaptureWriter implements FixtureCaptureWriter {
  readonly captures: ToolCallCapture[] = [];
  async write(capture: ToolCallCapture): Promise<void> {
    this.captures.push(capture);
  }
}

// The sparse shape a session-routed call resolves (#18896): no OS, model or runtime facts.
const SESSION_DEVICE: BootedDevice = {
  platform: "android",
  deviceId: "emulator-5582",
  name: "mt-fold",
  formFactor: "foldable",
};

const ADMITTED_IMAGE: DeviceInfo = {
  name: "mt-fold",
  platform: "android",
  isRunning: true,
  apiLevel: 36,
  osVersion: "16",
  model: "sdk_gphone64_arm64",
  deviceType: "pixel_fold",
  runtimeId: "system-images;android-36;google_apis;arm64-v8a",
};

function poolWith(image: DeviceInfo | undefined): AdmittedImageReads {
  return {
    getDevice: (deviceId) =>
      deviceId === SESSION_DEVICE.deviceId ? { androidImage: image } : null,
  };
}

async function captureSessionCall(pool: AdmittedImageReads): Promise<ToolCallCapture> {
  const writer = new FakeCaptureWriter();
  const timer = new FakeTimer();
  timer.setCurrentTime(Date.UTC(2026, 10, 20, 12, 0, 0));
  const deps = {
    writer,
    timer,
    sourceIdentity: async () => ({
      automobileVersion: "0.0.96+gabc1234",
      sourceTreeState: "clean" as const,
    }),
  };
  const args = { degrees: 90 };
  await runWithFixtureCapture("rotate", deps, () =>
    invokeResolvedDeviceHandler({
      target: {
        args,
        baseSessionUuid: "session-1",
        device: SESSION_DEVICE,
        internalCall: false,
        sessionUuid: "session-1",
        shouldResolveDevice: true,
      },
      name: "rotate",
      args,
      handler: async () => ({ content: [] }),
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      navigationRecorder: { record: () => undefined },
      mutationRecording: { beforeToolCall: async () => {} },
      isResponseFailure: () => false,
      devicePool: pool,
    }),
  );
  expect(writer.captures).toHaveLength(1);
  return writer.captures[0]!;
}

function promote(capture: ToolCallCapture) {
  return buildPromotion({
    capture: parseCapture(
      JSON.stringify(capture.provenance),
      JSON.stringify([
        {
          index: 0,
          argv: ["adb", "shell", "wm", "size"],
          exitCode: 0,
          durationMs: 1,
          stdout: "Physical size: 1080x2092\n",
          stderr: "",
        },
      ]),
    ),
    commandIndex: 0,
    stream: "stdout",
    destination: parseFixtureDestination("test/fixtures/android-window/foldable/wm-size.txt"),
    homeDir: "/home/dev",
  });
}

describe("fixture capture provenance for a session-routed Android call", () => {
  test("records the pool's admitted OS, model and runtime facts, and promote accepts it", async () => {
    const capture = await captureSessionCall(poolWith(ADMITTED_IMAGE));
    expect(capture.provenance.device).toEqual({
      platform: "android",
      deviceId: "emulator-5582",
      name: "mt-fold",
      formFactor: "foldable",
      apiLevel: 36,
      osVersion: "16",
      model: "sdk_gphone64_arm64",
      deviceType: "pixel_fold",
      runtimeId: "system-images;android-36;google_apis;arm64-v8a",
    });
    expect(promote(capture).provenance.device).toEqual({
      platform: "android",
      formFactor: "foldable",
      model: "sdk_gphone64_arm64",
      deviceType: "pixel_fold",
      osVersion: "16",
      apiLevel: 36,
      runtimeId: "system-images;android-36;google_apis;arm64-v8a",
    });
  });

  test("keeps the resolved device's own facts ahead of the admitted image", async () => {
    const pool: AdmittedImageReads = {
      getDevice: () => ({ androidImage: { ...ADMITTED_IMAGE, formFactor: "phone", apiLevel: 35 } }),
    };
    const capture = await captureSessionCall(pool);
    expect(capture.provenance.device?.formFactor).toBe("foldable");
    expect(capture.provenance.device?.apiLevel).toBe(35);
  });

  test("ignores an admitted image of another platform", async () => {
    const capture = await captureSessionCall(poolWith({ ...ADMITTED_IMAGE, platform: "ios" }));
    expect(capture.provenance.device).toEqual(SESSION_DEVICE);
    expect(() => promote(capture)).toThrow("reports no OS version or API level");
  });

  test("without a pooled image the sparse device is recorded and promote still refuses", async () => {
    const capture = await captureSessionCall(poolWith(undefined));
    expect(capture.provenance.device).toEqual(SESSION_DEVICE);
    expect(() => promote(capture)).toThrow("reports no OS version or API level");
  });
});
