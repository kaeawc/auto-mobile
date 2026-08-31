import { beforeAll, describe, expect, test } from "bun:test";
import { AndroidH264Source } from "../../src/features/webrtc/AndroidH264Source";
import {
  H264AnnexBParser,
  NAL_TYPE_IDR,
  NAL_TYPE_PPS,
  NAL_TYPE_SPS,
  nalUnitType,
} from "../../src/features/webrtc/h264";
import type { BootedDevice } from "../../src/models";
import { DefaultHostCommandExecutor } from "../../src/utils/HostCommandExecutor";
import {
  ADB_INTEGRATION_COMMAND_TIMEOUT_MS,
  createAdbIntegrationCommandRunner,
  type AdbIntegrationCommandRunner,
  waitForAdbCondition,
} from "./adbIntegrationCommandRunner";
import { createH264CaptureReadiness } from "./h264CaptureReadiness";

/**
 * On-device verification of the ONE seam the unit tests structurally cannot
 * cover (issue #3775): the real `adb exec-out screenrecord --output-format=h264`
 * capture command and its segment-rotation lifecycle. The unit suite injects a
 * fake spawner, so arg formatting, exit-code semantics, and rotation timing are
 * validated against a *fake* process — never against `adb` and a real encoder.
 *
 * These tests use the REAL default spawner and adb factory against a connected
 * Android emulator/device. They are opt-in: set
 * `AUTOMOBILE_ANDROID_H264_INTEGRATION=1` (and optionally
 * `AUTOMOBILE_ANDROID_H264_DEVICE_ID=<serial>`) to run them.
 */
const RUN_INTEGRATION = process.env.AUTOMOBILE_ANDROID_H264_INTEGRATION === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;
// The two sequential setup queries must each be killed by their own child-process
// deadline. This hook budget is only a final backstop if a future setup step stalls.
const ADB_SETUP_HOOK_TIMEOUT_MS = ADB_INTEGRATION_COMMAND_TIMEOUT_MS * 2 + 1000;
const adb = createAdbIntegrationCommandRunner(new DefaultHostCommandExecutor());

/** Resolve the target device serial from env or the first booted device. */
async function resolveDeviceId(adbRunner: AdbIntegrationCommandRunner): Promise<string> {
  const explicit = process.env.AUTOMOBILE_ANDROID_H264_DEVICE_ID;
  if (explicit) {
    return explicit;
  }
  const { stdout } = await adbRunner.run(["devices"], "discovering an Android device");
  const serial = stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.endsWith("\tdevice"))
    .map((line) => line.split("\t")[0])[0];
  if (!serial) {
    throw new Error(`No booted Android device found in \`adb devices\`:\n${stdout}`);
  }
  return serial;
}

/** Count device-side `screenrecord` processes (to detect orphans after stop). */
async function countScreenrecordProcesses(
  adbRunner: AdbIntegrationCommandRunner,
  deviceId: string,
): Promise<number> {
  const { stdout } = await adbRunner.run(
    ["-s", deviceId, "shell", "ps", "-A"],
    "checking for screenrecord processes",
  );
  return stdout.split("\n").filter((line) => line.includes("screenrecord")).length;
}

/** Split an accumulated Annex-B buffer into NAL-type counts. */
function nalTypeCounts(chunks: Buffer[]): Map<number, number> {
  const parser = new H264AnnexBParser();
  const counts = new Map<number, number>();
  const tally = (nals: Buffer[]): void => {
    for (const nal of nals) {
      const type = nalUnitType(nal);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  };
  for (const chunk of chunks) {
    tally(parser.push(chunk));
  }
  tally(parser.flush());
  return counts;
}

describeIntegration("AndroidH264Source on-device capture (#3775)", () => {
  let deviceId: string;

  beforeAll(async () => {
    await adb.run(["version"], "checking ADB availability");
    deviceId = await resolveDeviceId(adb);
  }, ADB_SETUP_HOOK_TIMEOUT_MS);

  function makeDevice(): BootedDevice {
    return { deviceId, platform: "android", name: deviceId } as BootedDevice;
  }

  async function capture(
    overrides: Partial<ConstructorParameters<typeof AndroidH264Source>[0]> = {},
    minimumSpsCount: number = 1,
  ): Promise<{ chunks: Buffer[]; errors: Error[]; source: AndroidH264Source }> {
    const captureReadiness = createH264CaptureReadiness(minimumSpsCount);
    const errors: Error[] = [];
    const source = new AndroidH264Source({
      device: makeDevice(),
      onData: captureReadiness.onData,
      onError: (error) => {
        errors.push(error);
        captureReadiness.onError(error);
      },
      ...overrides,
    });
    await source.start();
    try {
      await captureReadiness.wait();
    } finally {
      await source.stop();
    }
    return { chunks: captureReadiness.chunks, errors, source };
  }

  test("captures a real Annex-B stream with SPS, PPS, and an IDR key frame", async () => {
    const { chunks, errors } = await capture();

    expect(errors).toEqual([]);
    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    expect(totalBytes).toBeGreaterThan(0);

    const counts = nalTypeCounts(chunks);
    expect(counts.get(NAL_TYPE_SPS) ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts.get(NAL_TYPE_PPS) ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts.get(NAL_TYPE_IDR) ?? 0).toBeGreaterThanOrEqual(1);

    // At least one coded slice (VCL NAL types 1-5) must be present.
    let vclCount = 0;
    for (const [type, count] of counts) {
      if (type >= 1 && type <= 5) {
        vclCount += count;
      }
    }
    expect(vclCount).toBeGreaterThanOrEqual(1);
  }, 30000);

  test("accepts device --bit-rate and --size overrides and still produces frames", async () => {
    // Use the device's native resolution so `--size` is always a supported value
    // while still exercising the `--size WxH` argument path end-to-end.
    const { stdout } = await adb.run(
      ["-s", deviceId, "shell", "wm", "size"],
      "reading display size",
    );
    const match = stdout.match(/(\d+)x(\d+)/);
    if (!match) {
      throw new Error(`Could not parse \`wm size\`: ${stdout}`);
    }
    const width = Number(match[1]);
    const height = Number(match[2]);

    const { chunks, errors } = await capture({
      bitrateBps: 2_000_000,
      size: { width, height },
    });

    expect(errors).toEqual([]);
    const counts = nalTypeCounts(chunks);
    expect(counts.get(NAL_TYPE_SPS) ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts.get(NAL_TYPE_IDR) ?? 0).toBeGreaterThanOrEqual(1);
  }, 30000);

  test("rotates segments cleanly, re-emitting fresh SPS/PPS per segment", async () => {
    // Force fast rotation: cap each segment at 2s and rotate at 1.5s.
    const { chunks, errors, source } = await capture(
      { segmentTimeLimitSeconds: 2, segmentRotateMs: 1500 },
      2,
    );

    expect(errors).toEqual([]);
    // ~5s of capture at a 1.5s rotate cadence must cross at least one boundary.
    expect(source.segmentsStarted).toBeGreaterThanOrEqual(2);

    // Each fresh segment re-emits its own SPS/PPS + IDR, so with >=2 segments we
    // must observe more than one SPS across the concatenated stream.
    const counts = nalTypeCounts(chunks);
    expect(counts.get(NAL_TYPE_SPS) ?? 0).toBeGreaterThanOrEqual(2);
    expect(counts.get(NAL_TYPE_IDR) ?? 0).toBeGreaterThanOrEqual(2);
  }, 30000);

  test("stop leaves no orphaned screenrecord process on the device", async () => {
    const baseline = await countScreenrecordProcesses(adb, deviceId);

    const { errors } = await capture();
    expect(errors).toEqual([]);

    // After stop + wind-down, the device-side screenrecord count must return to
    // (or below) the baseline — our session leaves nothing running. A leak would
    // show up as a count above baseline.
    await waitForAdbCondition(
      async () => (await countScreenrecordProcesses(adb, deviceId)) <= baseline,
      "screenrecord process did not exit after stop",
    );
  }, 30000);
});
