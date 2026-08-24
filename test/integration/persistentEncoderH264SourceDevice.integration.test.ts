import { beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PersistentEncoderH264Source } from "../../src/features/webrtc/PersistentEncoderH264Source";
import { resolveVideoServerJarPath } from "../../src/features/webrtc/videoServerJar";
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
 * On-device verification (issue #3776) that the persistent on-device encoder
 * source produces a continuous Annex-B H.264 stream — replacing the ~175s
 * `screenrecord` segment-rotation seam. Uses the REAL default spawner, adb
 * factory, and socket connector against a connected Android device and the built
 * `automobile-video.jar`.
 *
 * Opt-in: set `AUTOMOBILE_PERSISTENT_ENCODER_INTEGRATION=1` (and optionally
 * `AUTOMOBILE_VIDEO_SERVER_JAR=<path>` / `AUTOMOBILE_ANDROID_H264_DEVICE_ID`).
 */
const execFileAsync = promisify(execFile);
const RUN_INTEGRATION = process.env.AUTOMOBILE_PERSISTENT_ENCODER_INTEGRATION === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;
const CAPTURE_MS = 3000;

async function resolveDeviceId(): Promise<string> {
  const explicit = process.env.AUTOMOBILE_ANDROID_H264_DEVICE_ID;
  if (explicit) {
    return explicit;
  }
  const { stdout } = await execFileAsync("adb", ["devices"]);
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

async function countAppProcesses(deviceId: string): Promise<number> {
  const { stdout } = await execFileAsync("adb", ["-s", deviceId, "shell", "ps", "-A"]);
  return stdout.split("\n").filter((line) => line.includes("automobile.video")).length;
}

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

describeIntegration("PersistentEncoderH264Source on-device capture (#3776)", () => {
  let deviceId: string;
  let jarPath: string;

  beforeAll(async () => {
    await execFileAsync("adb", ["version"]);
    deviceId = await resolveDeviceId();
    const resolved = resolveVideoServerJarPath();
    if (!resolved) {
      throw new Error(
        "automobile-video.jar not found. Build it with `./gradlew :video-server:d8Dex` " +
          "or set AUTOMOBILE_VIDEO_SERVER_JAR.",
      );
    }
    jarPath = resolved;
  });

  function makeDevice(): BootedDevice {
    return { deviceId, platform: "android", name: deviceId } as BootedDevice;
  }

  async function capture(
    overrides: Record<string, unknown> = {},
  ): Promise<{ chunks: Buffer[]; errors: Error[] }> {
    const chunks: Buffer[] = [];
    const errors: Error[] = [];
    const source = new PersistentEncoderH264Source({
      device: makeDevice(),
      onData: (chunk) => chunks.push(chunk),
      onError: (error) => errors.push(error),
      jarPath,
      quality: "low",
      ...overrides,
    });
    await source.start();
    await defaultTimer.sleep(CAPTURE_MS);
    await source.stop();
    await defaultTimer.sleep(500);
    return { chunks, errors };
  }

  test("captures a continuous Annex-B stream with SPS, PPS, and an IDR", async () => {
    const { chunks, errors } = await capture();
    expect(errors).toEqual([]);
    const counts = nalTypeCounts(chunks);
    expect(counts.get(NAL_TYPE_SPS) ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts.get(NAL_TYPE_PPS) ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts.get(NAL_TYPE_IDR) ?? 0).toBeGreaterThanOrEqual(1);
  }, 40000);

  test("accepts --bit-rate and --size overrides and still produces frames", async () => {
    const { chunks, errors } = await capture({
      bitrateBps: 1_500_000,
      size: { width: 480, height: 1040 },
    });
    expect(errors).toEqual([]);
    const counts = nalTypeCounts(chunks);
    expect(counts.get(NAL_TYPE_SPS) ?? 0).toBeGreaterThanOrEqual(1);
    expect(counts.get(NAL_TYPE_IDR) ?? 0).toBeGreaterThanOrEqual(1);
  }, 40000);

  test("stop leaves no orphaned video-server process on the device", async () => {
    const baseline = await countAppProcesses(deviceId);
    const { errors } = await capture();
    expect(errors).toEqual([]);
    const after = await countAppProcesses(deviceId);
    expect(after).toBeLessThanOrEqual(baseline);
  }, 40000);
});
