import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FfmpegVideoProcessingBackend } from "../../../src/features/video/FfmpegVideoProcessingBackend";
import type { VideoCaptureConfig } from "../../../src/features/video/VideoRecorderService";
import type { BootedDevice } from "../../../src/models";

async function runCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr}`));
      }
    });
  });
}

function config(outputPath: string): VideoCaptureConfig {
  return {
    recordingId: "test-recording",
    outputDirectory: path.dirname(outputPath),
    outputPath,
    fileName: path.basename(outputPath),
    startedAt: new Date().toISOString(),
    qualityPreset: "low",
    targetBitrateKbps: 1000,
    maxThroughputMbps: 5,
    fps: 15,
    maxArchiveSizeMb: 2048,
    format: "mp4",
    device: {
      platform: "ios",
      deviceId: "test-device",
      deviceType: "simulator",
      booted: true,
    } as BootedDevice,
  };
}

describe("FfmpegVideoProcessingBackend host integration", () => {
  test("produces playable trimmed output when stream-copy remuxing unscaled input", async () => {
    if (
      spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0 ||
      spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status !== 0
    ) {
      return;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-remux-"));
    const rawPath = path.join(tempDir, "raw.mov");
    const outputPath = path.join(tempDir, "trimmed.mp4");
    const backend = new FfmpegVideoProcessingBackend();
    const buildFfmpegArgs = Reflect.get(backend, "buildFfmpegArgs");

    try {
      await runCommand("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=16x16:rate=5",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        rawPath,
      ]);

      const args: string[] = await buildFfmpegArgs.call(
        backend,
        { ...config(outputPath), maxDurationSeconds: 1 },
        { encoder: "libx264", available: false, description: "Software encoding" },
        { type: "file", path: rawPath },
      );
      await runCommand("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args]);

      const probe = await runCommand("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        outputPath,
      ]);
      expect(Number.parseFloat(probe.stdout.trim())).toBeLessThan(1.6);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("rejects missing or empty post-processed output", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auto-mobile-video-"));
    const missingPath = path.join(tempDir, "missing.mp4");
    const emptyPath = path.join(tempDir, "empty.mp4");
    const backend = new FfmpegVideoProcessingBackend();
    const assertOutputReady = Reflect.get(backend, "assertFfmpegOutputReady");
    const tracker = { exitState: { exitCode: 0, signal: null }, stderr: [] };

    try {
      await expect(
        assertOutputReady.call(backend, missingPath, ["-i", "raw.mov", missingPath], tracker),
      ).rejects.toThrow(/FFmpeg output file missing/);

      await fs.writeFile(emptyPath, "");
      await expect(
        assertOutputReady.call(backend, emptyPath, ["-i", "raw.mov", emptyPath], tracker),
      ).rejects.toThrow(/FFmpeg output file is empty/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
