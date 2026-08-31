import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dump, load } from "js-yaml";
import { IOS_FIRST_FRAME_TIMEOUT_MS } from "../../src/features/webrtc/IosH264Source";

/**
 * Measured on the hosted device lanes after #4346 landed (issue #4345, using the
 * stage instrumentation from #4343). Each figure is the elapsed time from
 * `whipConnected` to `firstEncodedFrame` — the exact interval MediaMTX's
 * `webrtcTrackGatherTimeout` governs.
 *
 * iOS samples, n=7 (ms): 3356, 3587, 4164, 6158, 6436, 10570, 15065
 *   runs 30061346419, 30062724119, 30061350168, 30058014124/2, 30061342714,
 *        30061358682, 30061354391
 * Android samples, n=4 (ms): 5141, 5164, 5680, 5924
 *
 * iOS is bimodal: a 3-6s cluster and a 10-15s tail. Android is consistently fast.
 * The tail is why these timeouts were NOT tightened — see the note in
 * examples/mediamtx/mediamtx.yml.
 */
const MEASURED_IOS_P50_MS = 6_158;
const MEASURED_IOS_P95_MS = 15_065;

/**
 * Upper bound on the window the iOS first-frame deadline actually covers.
 *
 * `IOS_FIRST_FRAME_TIMEOUT_MS` starts just before `helper.start()` and ends on the
 * helper's first frame, so its window is a strict *sub-interval* of
 * `whipConnected -> sourceStarted` (that span also contains ffmpeg validation,
 * simulator window resolution, and helper spawn). We cannot isolate it from the
 * current instrumentation, so we hold the contract against the whole enclosing
 * span — deliberately conservative in the safe direction.
 *
 * Worst observed span: 13009ms (run 30061354391).
 */
const MEASURED_IOS_MAX_WHIP_TO_SOURCE_STARTED_MS = 13_009;

/**
 * Encoder startup, measured as `sourceStarted -> firstEncodedFrame` across the same
 * runs: 738-2121ms on iOS, 613-821ms on Android. The relay deadline must clear the
 * source contract by at least this much or MediaMTX can close a publisher that is
 * still within its own first-frame budget.
 */
const ENCODER_STARTUP_HEADROOM_MS = 3_000;

/**
 * How far the relay deadline must sit above the measured p95. A deadline at or
 * near p95 closes valid publishers on the slow tail that produced that p95.
 */
const P95_SAFETY_FACTOR = 1.5;

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

interface MediaMtxConfig {
  webrtc?: boolean;
  webrtcTrackGatherTimeout?: string;
  rtsp?: boolean;
  rtmp?: boolean;
  hls?: boolean;
  srt?: boolean;
  moq?: boolean;
}

/** Parses MediaMTX's Go duration scalars ("30s", "1500ms"). */
function parseDurationMs(value: string): number {
  const match = DURATION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`unsupported MediaMTX duration: ${value}`);
  }
  return Number(match[1]) * DURATION_UNIT_MS[match[2]];
}

function loadMediaMtxConfig(): MediaMtxConfig {
  return load(readFileSync("examples/mediamtx/mediamtx.yml", "utf8")) as MediaMtxConfig;
}

function loadTrackGatherTimeoutMs(): number {
  const config = loadMediaMtxConfig();
  expect(config.webrtcTrackGatherTimeout).toBeString();
  return parseDurationMs(config.webrtcTrackGatherTimeout as string);
}

describe("MediaMTX WebRTC configuration", () => {
  test("uses YAML booleans so generated worker configs keep protocol listeners typed", () => {
    const config = loadMediaMtxConfig();
    expect(config.webrtc).toBe(true);
    expect(config.rtsp).toBe(false);
    expect(config.rtmp).toBe(false);
    expect(config.hls).toBe(false);
    expect(config.srt).toBe(false);
    expect(config.moq).toBe(false);

    const generatedConfig = dump(config, { lineWidth: -1 });
    expect(generatedConfig).toContain("webrtc: true\n");
    expect(generatedConfig).toContain("rtsp: false\n");
    expect(generatedConfig).toContain("rtmp: false\n");
    expect(generatedConfig).toContain("hls: false\n");
    expect(generatedConfig).toContain("srt: false\n");
    expect(generatedConfig).toContain("moq: false\n");
  });

  test("allows enough time for a device encoder to provide its first track", () => {
    expect(loadTrackGatherTimeoutMs()).toBe(30_000);
  });

  test("keeps the relay deadline above the iOS source contract plus encoder startup", () => {
    // #4345: the two must only ever move together. Tightening either alone makes
    // MediaMTX close a publisher that is still inside its own first-frame budget.
    expect(loadTrackGatherTimeoutMs()).toBeGreaterThanOrEqual(
      IOS_FIRST_FRAME_TIMEOUT_MS + ENCODER_STARTUP_HEADROOM_MS,
    );
  });

  test("keeps the relay deadline clear of the measured p95 track-gather time", () => {
    expect(loadTrackGatherTimeoutMs()).toBeGreaterThanOrEqual(
      MEASURED_IOS_P95_MS * P95_SAFETY_FACTOR,
    );
  });

  test("keeps the iOS first-frame contract above the slowest observed source startup", () => {
    expect(IOS_FIRST_FRAME_TIMEOUT_MS).toBeGreaterThanOrEqual(
      MEASURED_IOS_MAX_WHIP_TO_SOURCE_STARTED_MS,
    );
  });

  test("records a p50 well under the contracts it justifies", () => {
    // Guards the record itself: if a future edit lowers these constants to justify a
    // tighter timeout, the ordering that makes them meaningful has to still hold.
    expect(MEASURED_IOS_P50_MS).toBeLessThan(MEASURED_IOS_P95_MS);
    expect(MEASURED_IOS_P95_MS).toBeGreaterThan(MEASURED_IOS_MAX_WHIP_TO_SOURCE_STARTED_MS);
  });
});
