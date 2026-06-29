import { beforeEach, describe, expect, test } from "bun:test";
import { promises as fsPromises } from "node:fs";
import os, { platform } from "node:os";
import path from "node:path";
import { FfmpegVideoProcessingBackend } from "../../../src/features/video/FfmpegVideoProcessingBackend";
import type { VideoCaptureConfig } from "../../../src/features/video/VideoRecorderService";
import type { BootedDevice } from "../../../src/models";

describe("FfmpegVideoProcessingBackend - Unit Tests", function() {
  let backend: FfmpegVideoProcessingBackend;
  let mockDevice: BootedDevice;
  let mockConfig: VideoCaptureConfig;
  let listEncodersCalls: number;
  let checkVersionCalls: number;

  beforeEach(function() {
    backend = new FfmpegVideoProcessingBackend();
    listEncodersCalls = 0;
    checkVersionCalls = 0;

    (backend as any).listEncoders = async () => {
      listEncodersCalls += 1;
      return ["h264_nvenc", "h264_vaapi", "h264_videotoolbox"];
    };
    (backend as any).checkFfmpegVersion = async () => {
      checkVersionCalls += 1;
    };

    mockDevice = {
      platform: "android",
      deviceId: "test-device",
      deviceType: "emulator",
      sdkVersion: 33,
      booted: true,
    } as BootedDevice;

    mockConfig = {
      recordingId: "test-recording",
      outputDirectory: "/tmp/test",
      outputPath: "/tmp/test/video.mp4",
      fileName: "video.mp4",
      startedAt: new Date().toISOString(),
      qualityPreset: "low",
      targetBitrateKbps: 1000,
      maxThroughputMbps: 5,
      fps: 15,
      maxArchiveSizeMb: 2048,
      format: "mp4",
      device: mockDevice,
    };
  });

  describe("Hardware Acceleration Detection", function() {
    test("should detect platform capabilities", async function() {
      const osPlatform = platform();
      const hwAccel = await (backend as any).detectHardwareAccel();

      expect(hwAccel).toBeDefined();
      expect(hwAccel.encoder).toBeDefined();
      expect(typeof hwAccel.available).toBe("boolean");
      expect(hwAccel.description).toBeDefined();

      if (osPlatform === "darwin") {
        expect(hwAccel.encoder).toBe("h264_videotoolbox");
        expect(hwAccel.available).toBe(true);
        expect(listEncodersCalls).toBe(1);
      } else if (osPlatform === "linux") {
        expect(hwAccel.encoder).toBe("h264_nvenc");
        expect(hwAccel.available).toBe(true);
        expect(listEncodersCalls).toBe(1);
      } else {
        expect(hwAccel.encoder).toBe("libx264");
        expect(hwAccel.available).toBe(false);
        expect(hwAccel.description).toContain("Unsupported platform");
        expect(listEncodersCalls).toBe(0);
      }
    });

    test("should cache hardware acceleration detection", async function() {
      const osPlatform = platform();
      const hwAccel1 = await (backend as any).detectHardwareAccel();
      const hwAccel2 = await (backend as any).detectHardwareAccel();

      expect(hwAccel1).toEqual(hwAccel2);
      if (osPlatform === "darwin" || osPlatform === "linux") {
        expect(listEncodersCalls).toBe(1);
      } else {
        expect(listEncodersCalls).toBe(0);
      }
    });
  });

  describe("FFmpeg Args Builder", function() {
    test("should build basic FFmpeg args for piped input", async function() {
      const hwAccel = {
        encoder: "libx264",
        available: false,
        description: "Software encoding",
      };

      const args = await (backend as any).buildFfmpegArgs(
        mockConfig,
        hwAccel,
        { type: "pipe" }
      );

      expect(args).toContain("-f");
      expect(args).toContain("mp4");
      expect(args).toContain("-i");
      expect(args).toContain("pipe:0");
      expect(args).toContain("-r");
      expect(args).toContain("15");
      expect(args).toContain("-b:v");
      expect(args).toContain("1000k");
      expect(args).toContain("-c:v");
      expect(args).toContain("libx264");
      expect(args).toContain(mockConfig.outputPath);
    });

    test("should include resolution scaling when specified", async function() {
      const configWithResolution = {
        ...mockConfig,
        resolution: { width: 1280, height: 720 },
      };

      const hwAccel = {
        encoder: "libx264",
        available: false,
        description: "Software encoding",
      };

      const args = await (backend as any).buildFfmpegArgs(
        configWithResolution,
        hwAccel,
        { type: "pipe" }
      );

      expect(args).toContain("-vf");
      expect(args).toContain("scale=1280:720");
    });

    test("should use hardware encoder when available", async function() {
      const hwAccel = {
        encoder: "h264_videotoolbox",
        available: true,
        description: "VideoToolbox HW accel",
      };

      const args = await (backend as any).buildFfmpegArgs(
        mockConfig,
        hwAccel,
        { type: "pipe" }
      );

      expect(args).toContain("-c:v");
      expect(args).toContain("h264_videotoolbox");
      expect(args).not.toContain("-preset");
    });

    test("should include duration limit when specified", async function() {
      const configWithDuration = {
        ...mockConfig,
        maxDurationSeconds: 60,
      };

      const hwAccel = {
        encoder: "libx264",
        available: false,
        description: "Software encoding",
      };

      const args = await (backend as any).buildFfmpegArgs(
        configWithDuration,
        hwAccel,
        { type: "pipe" }
      );

      expect(args).toContain("-t");
      expect(args).toContain("60");
    });

    test("should remux iOS simulator file input without re-encoding when no scaling is requested", async function() {
      const hwAccel = {
        encoder: "h264_videotoolbox",
        available: true,
        description: "VideoToolbox HW accel",
      };

      const args = await (backend as any).buildFfmpegArgs(
        mockConfig,
        hwAccel,
        { type: "file", path: "/tmp/test/test-recording-raw.mov" }
      );

      expect(args).toEqual([
        "-i",
        "/tmp/test/test-recording-raw.mov",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-y",
        mockConfig.outputPath,
      ]);
    });

    test("should transcode file input when scaling is requested", async function() {
      const hwAccel = {
        encoder: "h264_videotoolbox",
        available: true,
        description: "VideoToolbox HW accel",
      };

      const args = await (backend as any).buildFfmpegArgs(
        {
          ...mockConfig,
          resolution: { width: 720, height: 1280 },
        },
        hwAccel,
        { type: "file", path: "/tmp/test/test-recording-raw.mov" }
      );

      expect(args).toContain("-vf");
      expect(args).toContain("scale=720:1280");
      expect(args).toContain("-c:v");
      expect(args).toContain("h264_videotoolbox");
    });
  });

  describe("FFmpeg Diagnostics", function() {
    test("should include command, stderr, and missing output path for opaque post-processing failures", function() {
      const message = (backend as any).buildFfmpegFailureMessage(
        "FFmpeg output file missing",
        ["-i", "/tmp/raw.mov", "-c", "copy", "-y", "/tmp/out.mp4"],
        {
          exitState: { exitCode: null, signal: "SIGINT" },
          stderr: ["moov atom not found\n"],
        },
        "/tmp/out.mp4"
      );

      expect(message).toContain("FFmpeg output file missing");
      expect(message).toContain("output: /tmp/out.mp4");
      expect(message).toContain("command: ffmpeg -i /tmp/raw.mov -c copy -y /tmp/out.mp4");
      expect(message).toContain("exitCode: null");
      expect(message).toContain("signal: SIGINT");
      expect(message).toContain("stderr:\nmoov atom not found");
    });

    test("should include command and stderr for non-zero exits", function() {
      const message = (backend as any).buildFfmpegFailureMessage(
        "FFmpeg post-processing failed",
        ["-i", "/tmp/raw.mov", "-y", "/tmp/out.mp4"],
        {
          exitState: { exitCode: 1, signal: null },
          stderr: ["Invalid argument\n"],
        }
      );

      expect(message).toContain("FFmpeg post-processing failed");
      expect(message).toContain("command: ffmpeg -i /tmp/raw.mov -y /tmp/out.mp4");
      expect(message).toContain("exitCode: 1");
      expect(message).toContain("stderr:\nInvalid argument");
    });

    test("should reject missing post-processed output with FFmpeg context", async function() {
      const outputPath = path.join(os.tmpdir(), "auto-mobile-missing-output.mp4");

      await expect((backend as any).assertFfmpegOutputReady(
        outputPath,
        ["-i", "/tmp/raw.mov", "-c", "copy", "-y", outputPath],
        {
          exitState: { exitCode: 0, signal: null },
          stderr: ["No output produced\n"],
        }
      )).rejects.toThrow(/FFmpeg output file missing/);
    });

    test("should reject empty post-processed output with FFmpeg context", async function() {
      const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-video-"));
      const outputPath = path.join(tempDir, "empty.mp4");

      try {
        await fsPromises.writeFile(outputPath, "");

        await expect((backend as any).assertFfmpegOutputReady(
          outputPath,
          ["-i", "/tmp/raw.mov", "-c", "copy", "-y", outputPath],
          {
            exitState: { exitCode: 0, signal: null },
            stderr: [],
          }
        )).rejects.toThrow(/FFmpeg output file is empty/);
      } finally {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("FFmpeg Availability", function() {
    test("should check FFmpeg version", async function() {
      await (backend as any).checkFfmpegVersion();
      expect(checkVersionCalls).toBe(1);
    });
  });

  describe("Encoder Listing", function() {
    test("should list available encoders", async function() {
      const encoders = await (backend as any).listEncoders();
      expect(Array.isArray(encoders)).toBe(true);
      expect(encoders.length).toBeGreaterThan(0);
      expect(listEncodersCalls).toBe(1);
    });
  });
});
