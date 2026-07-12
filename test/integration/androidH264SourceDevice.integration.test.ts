import { beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AndroidH264Source } from "../../src/features/webrtc/AndroidH264Source";
import {
  H264AnnexBParser,
  NAL_TYPE_IDR,
  NAL_TYPE_PPS,
  NAL_TYPE_SPS,
  nalUnitType,
} from "../../src/features/webrtc/h264";
import type { BootedDevice } from "../../src/models";
import { defaultTimer } from "../../src/utils/SystemTimer";

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
const execFileAsync = promisify(execFile);
const RUN_INTEGRATION = process.env.AUTOMOBILE_ANDROID_H264_INTEGRATION === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const CAPTURE_MS = 3000;

/** Resolve the target device serial from env or the first booted device. */
async function resolveDeviceId(): Promise<string> {
  const explicit = process.env.AUTOMOBILE_ANDROID_H264_DEVICE_ID;
  if (explicit) {
    return explicit;
  }
  const { stdout } = await execFileAsync("adb", ["devices"]);
  const serial = stdout
    .split("\n")
    .slice(1)
    .map(line => line.trim())
    .filter(line => line.endsWith("\tdevice"))
    .map(line => line.split("\t")[0])[0];
  if (!serial) {
    throw new Error(`No booted Android device found in \`adb devices\`:\n${stdout}`);
  }
  return serial;
}

/** Count device-side `screenrecord` processes (to detect orphans after stop). */
async function countScreenrecordProcesses(deviceId: string): Promise<number> {
  const { stdout } = await execFileAsync("adb", ["-s", deviceId, "shell", "ps", "-A"]);
  return stdout.split("\n").filter(line => line.includes("screenrecord")).length;
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
    try {
      await execFileAsync("adb", ["version"]);
    } catch (error) {
      throw new Error(`adb is required for this integration test: ${String(error)}`);
    }
    deviceId = await resolveDeviceId();
  });

  function makeDevice(): BootedDevice {
    return { deviceId, platform: "android", name: deviceId } as BootedDevice;
  }

  async function capture(
    overrides: Partial<ConstructorParameters<typeof AndroidH264Source>[0]> = {},
    captureMs: number = CAPTURE_MS
  ): Promise<{ chunks: Buffer[]; errors: Error[]; source: AndroidH264Source }> {
    const chunks: Buffer[] = [];
    const errors: Error[] = [];
    const source = new AndroidH264Source({
      device: makeDevice(),
      onData: chunk => chunks.push(chunk),
      onError: error => errors.push(error),
      ...overrides,
    });
    await source.start();
    await defaultTimer.sleep(captureMs);
    await source.stop();
    // Let the killed `adb`/`screenrecord` processes wind down before assertions.
    await defaultTimer.sleep(500);
    return { chunks, errors, source };
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
    const { stdout } = await execFileAsync("adb", ["-s", deviceId, "shell", "wm", "size"]);
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
      5000
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
    const baseline = await countScreenrecordProcesses(deviceId);

    const { errors } = await capture();
    expect(errors).toEqual([]);

    // After stop + wind-down, the device-side screenrecord count must return to
    // (or below) the baseline — our session leaves nothing running. A leak would
    // show up as a count above baseline.
    const after = await countScreenrecordProcesses(deviceId);
    expect(after).toBeLessThanOrEqual(baseline);
  }, 30000);
});
