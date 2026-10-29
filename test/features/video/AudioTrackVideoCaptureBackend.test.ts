import { describe, expect, test } from "bun:test";
import {
  AudioTrackVideoCaptureBackend,
  type AudioTrackMuxRequest,
} from "../../../src/features/video/AudioTrackVideoCaptureBackend";
import type {
  RecordingHandle,
  RecordingResult,
  VideoCaptureBackend,
  VideoCaptureConfig,
} from "../../../src/features/video/VideoRecorderService";
import { ActionableError } from "../../../src/models/ActionableError";

const device = { name: "emu", platform: "android" as const, deviceId: "emulator-5554" };

function config(audio: boolean): VideoCaptureConfig {
  return {
    recordingId: "rec-1",
    outputDirectory: "/rec",
    outputPath: "/rec/rec-1.mp4",
    fileName: "rec-1.mp4",
    startedAt: "2026-01-01T00:00:00.000Z",
    device,
    audio,
    qualityPreset: "low",
    targetBitrateKbps: 1000,
    maxThroughputMbps: 5,
    fps: 15,
    maxArchiveSizeMb: 100,
    format: "mp4",
  };
}

function setup(
  options: { muxFails?: boolean; ffmpegMissing?: boolean; innerStartFails?: boolean } = {},
) {
  const events: string[] = [];
  let clock = 1_000;
  const files = new Map<string, number[]>();
  const removed: string[] = [];
  const muxed: AudioTrackMuxRequest[] = [];
  let sink: ((pcm: Uint8Array) => void) | undefined;
  const inner: VideoCaptureBackend = {
    start: async (captureConfig): Promise<RecordingHandle> => {
      events.push("video-start");
      clock += 250;
      if (options.innerStartFails) {
        throw new Error("screenrecord failed");
      }
      return {
        recordingId: captureConfig.recordingId,
        outputPath: captureConfig.outputPath,
        startedAt: captureConfig.startedAt,
      };
    },
    stop: async (handle): Promise<RecordingResult> => {
      events.push("video-stop");
      return { recordingId: handle.recordingId, outputPath: handle.outputPath, sizeBytes: 42 };
    },
    forceStop: async () => {
      events.push("video-force-stop");
    },
  };
  const backend = new AudioTrackVideoCaptureBackend(inner, {
    source: {
      startStream: async (deviceId, onPcm) => {
        events.push(`audio-start:${deviceId}`);
        sink = onPcm;
        return {
          sampleRate: 48_000,
          stop: async () => {
            events.push("audio-stop");
          },
        };
      },
    },
    muxer: {
      ensureAvailable: async () => {
        if (options.ffmpegMissing) {
          throw new ActionableError("A recording with audio needs FFmpeg");
        }
      },
      mux: async (request) => {
        muxed.push(request);
        if (options.muxFails) {
          throw new Error("ffmpeg exited with 1");
        }
      },
    },
    openPcmFile: (path) => {
      files.set(path, []);
      return {
        write: (chunk) => files.get(path)?.push(...chunk),
        close: async () => files.get(path)?.length ?? 0,
      };
    },
    removeFile: async (path) => {
      removed.push(path);
    },
    now: () => clock,
  });
  return {
    backend,
    events,
    files,
    removed,
    muxed,
    emit: (bytes: number[]) => sink?.(Uint8Array.from(bytes)),
  };
}

describe("AudioTrackVideoCaptureBackend", () => {
  test("a recording without audio passes straight through", async () => {
    const { backend, events } = setup();
    const handle = await backend.start(config(false));
    const result = await backend.stop(handle);
    expect(events).toEqual(["video-start", "video-stop"]);
    expect(result.hasAudioTrack).toBeUndefined();
    expect(result.sizeBytes).toBe(42);
  });

  test("audio is captured from before the video starts and muxed in at stop", async () => {
    const { backend, events, muxed, removed, emit } = setup();
    const handle = await backend.start(config(true));
    emit([1, 2, 3, 4]);
    const result = await backend.stop(handle);
    expect(events).toEqual([
      "audio-start:emulator-5554",
      "video-start",
      "video-stop",
      "audio-stop",
    ]);
    expect(muxed).toEqual([
      {
        videoPath: "/rec/rec-1.mp4",
        pcmPath: "/rec/rec-1.mp4.audio.pcm",
        pcmBytes: 4,
        sampleRate: 48_000,
        leadMs: 250,
      },
    ]);
    expect(result).toMatchObject({ hasAudioTrack: true, sizeBytes: undefined });
    expect(removed).toEqual(["/rec/rec-1.mp4.audio.pcm"]);
  });

  test("a failed mux keeps the video and reports why it has no audio track", async () => {
    const { backend, removed } = setup({ muxFails: true });
    const result = await backend.stop(await backend.start(config(true)));
    expect(result.hasAudioTrack).toBe(false);
    expect(result.sizeBytes).toBe(42);
    expect(result.warnings).toEqual(["The recording has no audio track: ffmpeg exited with 1"]);
    expect(removed).toEqual(["/rec/rec-1.mp4.audio.pcm"]);
  });

  test("without FFmpeg the recording is refused before any capture starts", async () => {
    const { backend, events } = setup({ ffmpegMissing: true });
    await expect(backend.start(config(true))).rejects.toThrow("needs FFmpeg");
    expect(events).toEqual([]);
  });

  test("a video that fails to start stops the audio and removes its file", async () => {
    const { backend, events, removed } = setup({ innerStartFails: true });
    await expect(backend.start(config(true))).rejects.toThrow("screenrecord failed");
    expect(events).toEqual(["audio-start:emulator-5554", "video-start", "audio-stop"]);
    expect(removed).toEqual(["/rec/rec-1.mp4.audio.pcm"]);
  });

  test("a force stop discards the audio and stops the video", async () => {
    const { backend, events, removed } = setup();
    const handle = await backend.start(config(true));
    await backend.forceStop(handle);
    expect(events.slice(-2)).toEqual(["audio-stop", "video-force-stop"]);
    expect(removed).toEqual(["/rec/rec-1.mp4.audio.pcm"]);
  });
});
