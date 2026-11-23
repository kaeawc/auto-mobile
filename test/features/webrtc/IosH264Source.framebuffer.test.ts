import { describe, expect, test } from "bun:test";
import type { CaptureTarget } from "../../../src/features/screen-stream";
import { IosH264Source, resolveEncodeSettings } from "../../../src/features/webrtc/IosH264Source";
import {
  FAKE_HELPER_PATH,
  FakeFrameCaptureHelper,
  IOS_DEVICE,
  IOS_SIMULATOR,
  encodedRecord,
  fakeHelperPathExists,
  flush,
  successfulCommandRunner,
} from "../../helpers/iosH264SourceHarness";

function framebufferHarness(
  overrides: Partial<ConstructorParameters<typeof IosH264Source>[0]> = {},
) {
  const helpers: FakeFrameCaptureHelper[] = [];
  const targets: CaptureTarget[] = [];
  const errors: Error[] = [];
  const source = new IosH264Source({
    device: IOS_SIMULATOR,
    helperPath: FAKE_HELPER_PATH,
    helperPathExists: fakeHelperPathExists,
    onData: () => {},
    onError: (error) => errors.push(error),
    createHelper: (options) => {
      targets.push(options.target);
      const helper = new FakeFrameCaptureHelper();
      helpers.push(helper);
      return helper;
    },
    simulatorWindowResolver: async () => 42,
    commandRunner: successfulCommandRunner,
    simulatorFramebufferCapture: true,
    ...overrides,
  });
  return { source, helpers, targets, errors };
}

describe("IosH264Source Simulator framebuffer capture (#19015)", () => {
  test("captures the booted Simulator's framebuffer by UDID before any window lookup", async () => {
    let windowLookups = 0;
    const { source, helpers, targets } = framebufferHarness({
      simulatorWindowResolver: async () => {
        windowLookups++;
        return 42;
      },
    });

    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      kind: "simulatorFramebuffer",
      udid: IOS_SIMULATOR.deviceId,
    });
    expect(windowLookups).toBe(0);
    await source.stop();
  });

  test("falls back to the window path when the helper cannot start framebuffer capture", async () => {
    const { source, helpers, targets, errors } = framebufferHarness();

    const started = source.start();
    await flush();
    // An older helper rejects --simulator-udid and exits before any record.
    helpers[0].emitExit(2);
    await flush();
    await flush();
    helpers[1].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;

    expect(targets.map((target) => target.kind)).toEqual(["simulatorFramebuffer", "simulator"]);
    expect(targets[1]).toMatchObject({ windowID: 42 });
    expect(helpers[0].stopped).toBe(true);
    expect(errors).toEqual([]);
    await source.stop();
  });

  test("keeps the window path for audio, which framebuffer capture cannot carry", async () => {
    const { source, helpers, targets } = framebufferHarness({ audioEnabled: true });

    const started = source.start();
    await flush();
    helpers[0].emit("audio", Buffer.alloc(2));
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;

    expect(targets.map((target) => target.kind)).toEqual(["simulator"]);
    await source.stop();
  });

  test("never targets a physical device's framebuffer", async () => {
    const { source, helpers, targets } = framebufferHarness({ device: IOS_DEVICE });

    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;

    expect(targets.map((target) => target.kind)).toEqual(["device"]);
    await source.stop();
  });

  test("uses the Simulator bits-per-pixel budget for framebuffer encodes", () => {
    expect(
      resolveEncodeSettings({ device: IOS_SIMULATOR, onData: () => {} }, "simulatorFramebuffer"),
    ).toEqual({ codec: "h264", bitrate: { kind: "bitsPerPixel", bpp: 0.1 } });
  });
});
