import { describe, expect, test } from "bun:test";
import {
  audioTrackMuxArgs,
  FfmpegAudioTrackMuxer,
} from "../../../src/features/video/FfmpegAudioTrackMuxer";
import type { FfmpegCommandResult, FfmpegRunRequest } from "../../../src/utils/media/FfmpegClient";

const request = {
  videoPath: "/rec/a.mp4",
  pcmPath: "/rec/a.mp4.audio.pcm",
  pcmBytes: 9_600,
  sampleRate: 48_000,
  leadMs: 250,
};

function fakeClient(result: Partial<FfmpegCommandResult>, probeFails = false) {
  const runs: FfmpegRunRequest[] = [];
  return {
    runs,
    client: {
      run: async (run: FfmpegRunRequest): Promise<FfmpegCommandResult> => {
        runs.push(run);
        return { stdout: "", stderr: "", exitCode: 0, signal: null, ...result };
      },
      probe: async () => {
        if (probeFails) {
          throw new Error("ffmpeg not found");
        }
        return { version: "7.0", encoders: [] };
      },
    },
  };
}

describe("audioTrackMuxArgs", () => {
  test("copies the video, skips audio captured before it, and pads the track to its length", () => {
    const args = audioTrackMuxArgs(request, "/rec/out.mp4");
    expect(args.join(" ")).toBe(
      "-y -hide_banner -loglevel error -i /rec/a.mp4 -ss 0.250 -f s16le -ar 48000 -ac 1 " +
        "-i /rec/a.mp4.audio.pcm -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 128k -af apad " +
        "-shortest -movflags +faststart /rec/out.mp4",
    );
  });

  test("an empty capture becomes a silent track", () => {
    const args = audioTrackMuxArgs({ ...request, pcmBytes: 0 }, "/rec/out.mp4");
    expect(args).toContain("anullsrc=r=48000:cl=mono");
    expect(args).not.toContain("/rec/a.mp4.audio.pcm");
  });
});

describe("FfmpegAudioTrackMuxer", () => {
  test("replaces the video with the muxed file", async () => {
    const renamed: Array<[string, string]> = [];
    const { client, runs } = fakeClient({});
    const muxer = new FfmpegAudioTrackMuxer(client, {
      rename: async (from, to) => {
        renamed.push([from, to]);
      },
      remove: async () => {},
    });
    await muxer.mux(request);
    expect(runs[0].args.at(-1)).toBe("/rec/a.mp4.with-audio.mp4");
    expect(renamed).toEqual([["/rec/a.mp4.with-audio.mp4", "/rec/a.mp4"]]);
  });

  test("a failed mux removes its partial output and leaves the video", async () => {
    const removed: string[] = [];
    const { client } = fakeClient({ exitCode: 1, stderr: "Invalid data found" });
    const muxer = new FfmpegAudioTrackMuxer(client, {
      rename: async () => {
        throw new Error("must not rename");
      },
      remove: async (path) => {
        removed.push(path);
      },
    });
    await expect(muxer.mux(request)).rejects.toThrow("Invalid data found");
    expect(removed).toEqual(["/rec/a.mp4.with-audio.mp4"]);
  });

  test("a host without FFmpeg gets an actionable error", async () => {
    const { client } = fakeClient({}, true);
    await expect(new FfmpegAudioTrackMuxer(client).ensureAvailable()).rejects.toThrow(
      "Install FFmpeg",
    );
  });
});
