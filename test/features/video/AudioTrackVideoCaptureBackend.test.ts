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

interface SetupOptions {
  /** The video stop fails once, then succeeds. */
  videoStopFailsOnce?: boolean;
  muxFails?: boolean;
  ffmpegMissing?: boolean;
  innerStartFails?: boolean;
  audioStopFails?: boolean;
  pcmWriteFails?: boolean;
  /** Holds the video stop until the returned release is called. */
  holdVideoStop?: boolean;
}

function setup(options: SetupOptions = {}) {
  const events: string[] = [];
  let releaseVideoStop: () => void = () => {};
  const videoStopHeld = new Promise<void>((resolve) => {
    releaseVideoStop = resolve;
  });
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
      if (options.holdVideoStop) {
        await videoStopHeld;
      }
      if (options.videoStopFailsOnce) {
        options.videoStopFailsOnce = false;
        throw new Error("adb pull failed");
      }
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
        clock += 500;
        sink = onPcm;
        return {
          sampleRate: 48_000,
          stop: async () => {
            events.push("audio-stop");
            if (options.audioStopFails) {
              throw new Error("emulator refused capture");
            }
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
        close: async () => {
          events.push("pcm-close");
          if (options.pcmWriteFails) {
            throw new Error("ENOSPC: no space left on device");
          }
          return files.get(path)?.length ?? 0;
        },
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
    releaseVideoStop,
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
      "pcm-close",
    ]);
    expect(muxed).toEqual([
      {
        videoPath: "/rec/rec-1.mp4",
        pcmPath: "/rec/rec-1.mp4.audio.pcm",
        pcmBytes: 4,
        sampleRate: 48_000,
        // Neither the audio stream's setup nor the video's start-up wait is audio before the video.
        leadMs: 0,
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
    expect(events).toEqual(["audio-start:emulator-5554", "video-start", "audio-stop", "pcm-close"]);
    expect(removed).toEqual(["/rec/rec-1.mp4.audio.pcm"]);
  });

  test("a force stop discards the audio and stops the video", async () => {
    const { backend, events, removed } = setup();
    const handle = await backend.start(config(true));
    await backend.forceStop(handle);
    expect(events.slice(-3)).toEqual(["audio-stop", "pcm-close", "video-force-stop"]);
    expect(removed).toEqual(["/rec/rec-1.mp4.audio.pcm"]);
  });

  test("an audio stop that fails still closes the PCM file before removing it", async () => {
    const { backend, events, removed, muxed } = setup({ audioStopFails: true });
    const result = await backend.stop(await backend.start(config(true)));
    expect(result.hasAudioTrack).toBe(false);
    expect(result.warnings).toEqual(["The recording has no audio track: emulator refused capture"]);
    expect(events.slice(-2)).toEqual(["audio-stop", "pcm-close"]);
    expect(removed).toEqual(["/rec/rec-1.mp4.audio.pcm"]);
    expect(muxed).toEqual([]);
  });

  test("a failed PCM write is reported instead of muxing a short track", async () => {
    const { backend, muxed } = setup({ pcmWriteFails: true });
    const result = await backend.stop(await backend.start(config(true)));
    expect(result.hasAudioTrack).toBe(false);
    expect(result.warnings).toEqual([
      "The recording has no audio track: ENOSPC: no space left on device",
    ]);
    expect(muxed).toEqual([]);
  });

  test("a force stop while the video is still stopping stops the audio right away", async () => {
    const { backend, events, removed, muxed, releaseVideoStop } = setup({ holdVideoStop: true });
    const handle = await backend.start(config(true));
    const stopping = backend.stop(handle);
    await Promise.resolve();
    await backend.forceStop(handle);
    expect(events.slice(-3)).toEqual(["audio-stop", "pcm-close", "video-force-stop"]);
    expect(removed).toEqual(["/rec/rec-1.mp4.audio.pcm"]);
    releaseVideoStop();
    const result = await stopping;
    expect(result.hasAudioTrack).toBe(false);
    expect(result.warnings).toEqual([
      "The recording has no audio track: it was force-stopped while stopping.",
    ]);
    expect(muxed).toEqual([]);
  });

  test("the audio file is reported as a sidecar the size cap counts", async () => {
    const { backend } = setup();
    const handle = await backend.start(config(true));
    expect(handle.inProgressSidecarPaths).toEqual(["/rec/rec-1.mp4.audio.pcm"]);
    expect(
      (await backend.start({ ...config(false), recordingId: "rec-2" })).inProgressSidecarPaths,
    ).toBeUndefined();
  });

  test("an Android recording longer than one segment is refused audio before any capture", async () => {
    const { backend, events } = setup();
    await expect(
      backend.start({ ...config(true), maxDurationSeconds: 181 }),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(events).toEqual([]);
    await backend.start({ ...config(true), maxDurationSeconds: 180 });
    expect(events[0]).toBe("audio-start:emulator-5554");
  });

  test("a stop retried after a failed video stop still reports the lost audio track", async () => {
    const { backend, muxed } = setup({ videoStopFailsOnce: true });
    const handle = await backend.start(config(true));
    await expect(backend.stop(handle)).rejects.toThrow("adb pull failed");
    const result = await backend.stop(handle);
    expect(result.hasAudioTrack).toBe(false);
    expect(result.warnings).toEqual([
      "The recording has no audio track: an earlier stop failed and its audio was discarded.",
    ]);
    expect(muxed).toEqual([]);
    // Reported once: a later stop of the same id is a plain pass-through.
    expect((await backend.stop(handle)).hasAudioTrack).toBeUndefined();
  });

  test("a force stop clears the lost-audio state of a failed stop", async () => {
    const { backend } = setup({ videoStopFailsOnce: true });
    const handle = await backend.start(config(true));
    await expect(backend.stop(handle)).rejects.toThrow("adb pull failed");
    await backend.forceStop(handle);
    expect((await backend.stop(handle)).hasAudioTrack).toBeUndefined();
  });
});
