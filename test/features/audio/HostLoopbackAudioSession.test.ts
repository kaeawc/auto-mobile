import { describe, expect, test } from "bun:test";
import { HostLoopbackAudioSession } from "../../../src/features/audio/HostLoopbackAudioSession";
import { LOOPBACK_READY_TIMEOUT_MS } from "../../../src/features/audio/loopbackHelperProcess";
import { sineTone } from "../../../src/utils/audio/pcm";
import { FakeLoopbackHelperProcess } from "../../fakes/FakeLoopbackHelperProcess";
import { FakeTimer } from "../../fakes/FakeTimer";

const ENV_NAME = "AUTOMOBILE_IOS_AUDIO_LOOPBACK_HELPER";

function setup(
  script: (helper: FakeLoopbackHelperProcess) => void = (helper) => helper.ready(),
  helperPath: string | null = "/opt/audio-loopback-helper",
) {
  const timer = new FakeTimer();
  const helpers: FakeLoopbackHelperProcess[] = [];
  const session = new HostLoopbackAudioSession(
    {
      helperPath: () => helperPath ?? undefined,
      launchHelper: (path, args) => {
        expect(path).toBe("/opt/audio-loopback-helper");
        const helper = new FakeLoopbackHelperProcess(args);
        helpers.push(helper);
        queueMicrotask(() => script(helper));
        return helper;
      },
      timer,
    },
    ENV_NAME,
  );
  return { session, helpers, timer };
}

/** Lets the fake's one-chunk-per-turn stdin make progress. */
async function turns(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("HostLoopbackAudioSession injection", () => {
  test("plays a clip as mono PCM, closes stdin and completes when the helper exits", async () => {
    const { session, helpers } = setup();
    const mono = sineTone({ durationMs: 250, sampleRate: 16_000 });
    const stereo = {
      sampleRate: 16_000,
      channels: 2,
      samples: Int16Array.from(Array.from(mono.samples).flatMap((sample) => [sample, sample])),
    };
    const injection = await session.injectAudio(stereo);
    expect(helpers[0].args).toEqual(["play", "--sample-rate", "16000"]);
    expect(injection).toMatchObject({ durationMs: 250, sampleRate: 16_000 });

    await turns(5);
    expect(helpers[0].stdinEnded).toBe(true);
    expect(helpers[0].writtenFrames()).toBe(4_000);
    helpers[0].exit(0);
    expect(await injection.done).toEqual({ framesSent: 4_000, reason: "completed" });
  });

  test("a rate the helper cannot take is resampled to 48 kHz", async () => {
    const { session, helpers } = setup();
    const injection = await session.injectAudio(sineTone({ durationMs: 10, sampleRate: 96_000 }));
    expect(helpers[0].args).toEqual(["play", "--sample-rate", "48000"]);
    expect(injection.sampleRate).toBe(48_000);
    await injection.stop();
  });

  test("a loop keeps writing until stopped, then reports stopped", async () => {
    const { session, helpers } = setup();
    const injection = await session.injectAudio(sineTone({ durationMs: 100, sampleRate: 8_000 }), {
      loop: true,
    });
    await turns(4);
    expect(helpers[0].writtenFrames()).toBeGreaterThan(800);
    const result = await injection.stop();
    expect(result.reason).toBe("stopped");
    expect(helpers[0].signals).toEqual(["SIGTERM"]);
    expect(helpers[0].stdinEnded).toBe(false);
    expect(await injection.stop()).toEqual(result);
  });

  test("maxDurationMs ends the injection", async () => {
    const { session, helpers, timer } = setup();
    const injection = await session.injectAudio(sineTone({ durationMs: 100, sampleRate: 8_000 }), {
      loop: true,
      maxDurationMs: 300,
    });
    timer.advanceTime(300);
    expect((await injection.done).reason).toBe("max_duration");
    expect(helpers[0].signals).toEqual(["SIGTERM"]);
  });

  test("a start delay holds the first write until it elapses", async () => {
    const { session, helpers, timer } = setup();
    const injection = await session.injectAudio(sineTone({ durationMs: 10, sampleRate: 8_000 }), {
      startDelayMs: 500,
    });
    await turns(2);
    expect(helpers[0].written).toHaveLength(0);
    timer.advanceTime(500);
    await turns(3);
    expect(helpers[0].writtenFrames()).toBe(80);
    await injection.stop();
  });

  test("a host without a loopback default input is unsupported, with the helper's reason", async () => {
    const { session } = setup((helper) => {
      helper.report(
        "no_loopback_input",
        "The host default input 'MacBook Pro Microphone' is not a loopback device.",
      );
      helper.exit(2);
    });
    const error = await session.injectAudio(sineTone({ durationMs: 10 })).catch((caught) => caught);
    expect(error).toMatchObject({ code: "audio_injection_unsupported" });
    expect(String(error.message)).toContain("MacBook Pro Microphone");
  });

  test("a helper that fails mid-playback rejects done with audio_loopback_failed", async () => {
    const { session, helpers } = setup();
    const injection = await session.injectAudio(sineTone({ durationMs: 10, sampleRate: 8_000 }), {
      loop: true,
    });
    helpers[0].report("audio_failed", "Queueing audio failed (OSStatus -50).");
    helpers[0].exit(2);
    await expect(injection.done).rejects.toMatchObject({ code: "audio_loopback_failed" });
  });

  test("no configured helper is unsupported and names the variable to set", async () => {
    const { session, helpers } = setup(undefined, null);
    await expect(session.injectAudio(sineTone({ durationMs: 10 }))).rejects.toThrow(ENV_NAME);
    await expect(session.captureAudio({ durationMs: 10 })).rejects.toMatchObject({
      code: "audio_capture_unsupported",
    });
    expect(helpers).toHaveLength(0);
  });

  test("a helper that never opens its device is killed after the ready timeout", async () => {
    const { session, helpers, timer } = setup(() => {});
    const starting = session.injectAudio(sineTone({ durationMs: 10 }));
    await turns(1);
    timer.advanceTime(LOOPBACK_READY_TIMEOUT_MS);
    await expect(starting).rejects.toMatchObject({ code: "audio_loopback_failed" });
    expect(helpers[0].signals).toEqual(["SIGKILL"]);
  });
});

describe("HostLoopbackAudioSession capture", () => {
  function pcmBytes(samples: number[]): Buffer {
    return Buffer.from(Int16Array.from(samples).buffer);
  }

  test("returns the helper's PCM as 48 kHz mono", async () => {
    const { session, helpers } = setup((helper) => {
      helper.ready();
      helper.stdout.write(pcmBytes(new Array(480).fill(1000)));
      helper.exit(0);
    });
    const result = await session.captureAudio({ durationMs: 10 });
    expect(helpers[0].args).toEqual(["capture", "--duration-ms", "10", "--sample-rate", "48000"]);
    expect(result.timedOut).toBe(false);
    expect(result.pcm).toMatchObject({ sampleRate: 48_000, channels: 1 });
    expect(result.pcm.samples.length).toBe(480);
  });

  test("PCM delivered after the helper reports its exit is still captured", async () => {
    const { session } = setup((helper) => {
      helper.ready();
      helper.stdout.write(pcmBytes(new Array(240).fill(1)));
      // The exit arrives before the pipe has delivered the rest of the PCM.
      setImmediate(() => {
        helper.emit("exit", 0);
        setImmediate(() => {
          helper.stdout.write(pcmBytes(new Array(240).fill(2)));
          helper.stdout.end();
        });
      });
    });
    const result = await session.captureAudio({ durationMs: 10 });
    expect(result.pcm.samples.length).toBe(480);
    expect(result.timedOut).toBe(false);
  });

  test("an open-ended capture streams PCM until stopped by closing stdin", async () => {
    const { session, helpers } = setup();
    const received: number[] = [];
    const stream = await session.streamCapture((pcm) => received.push(...pcm));
    expect(helpers[0].args).toEqual(["capture", "--until-stopped", "--sample-rate", "48000"]);
    helpers[0].stdout.write(pcmBytes([7, 8]));
    // Closing stdin is the helper's cue to write its last buffer and exit.
    helpers[0].stdin.on("finish", () => {
      helpers[0].stdout.write(pcmBytes([9]));
      helpers[0].exit(0);
    });
    await stream.stop();
    expect(Array.from(new Int16Array(Uint8Array.from(received).buffer))).toEqual([7, 8, 9]);
    expect(helpers[0].signals).toEqual([]);
  });

  test("less audio than asked for is timedOut, not an error", async () => {
    const { session } = setup((helper) => {
      helper.ready();
      helper.stdout.write(pcmBytes([1, 2, 3]));
      helper.exit(0);
    });
    const result = await session.captureAudio({ durationMs: 10 });
    expect(result.timedOut).toBe(true);
    expect(Array.from(result.pcm.samples)).toEqual([1, 2, 3]);
  });

  test("a stalled capture is killed after its duration plus grace", async () => {
    const { session, helpers, timer } = setup();
    const capturing = session.captureAudio({ durationMs: 1_000 });
    await turns(2);
    timer.advanceTime(6_000);
    expect((await capturing).timedOut).toBe(true);
    expect(helpers[0].signals).toEqual(["SIGTERM"]);
  });

  test("a host without a loopback default output is unsupported for capture", async () => {
    const { session } = setup((helper) => {
      helper.report(
        "no_loopback_output",
        "The host default output 'Speakers' is not a loopback device.",
      );
      helper.exit(2);
    });
    await expect(session.captureAudio({ durationMs: 10 })).rejects.toMatchObject({
      code: "audio_capture_unsupported",
    });
  });
});
