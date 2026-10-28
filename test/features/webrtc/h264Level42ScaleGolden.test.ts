import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME,
  h264MacroblocksPerFrame,
} from "../../../src/features/webrtc/h264Level";
import { IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL } from "../../../src/features/webrtc/IosH264Source";

/**
 * Pins the H.264 Level 4.2 macroblock budget and the resolution/bitrate
 * contract against the shared golden vectors in
 * `test/fixtures/h264-level42-scale-golden-vectors.json` (issue #4788). The
 * Swift helper (`ScreenCaptureCore.H264EncodeMath`) asserts the SAME fixture, so
 * the cross-language Level 4.2 capability the WHIP SDP advertises cannot drift
 * from what the in-helper encoder produces. Scaling and bitrate math are
 * implemented and tested by the Swift helper.
 */
interface ScaleCase {
  width: number;
  height: number;
  macroblocks: number;
}
interface Golden {
  maxMacroblocksPerFrame: number;
  defaultBitsPerPixel: number;
  scaleCases: ScaleCase[];
}

const golden: Golden = JSON.parse(
  readFileSync(
    new URL("../../fixtures/h264-level42-scale-golden-vectors.json", import.meta.url),
    "utf8",
  ),
);

describe("H.264 Level 4.2 capability golden vectors (issue #4788)", () => {
  test("the Level 4.2 macroblock budget matches the fixture", () => {
    expect(WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME).toBe(golden.maxMacroblocksPerFrame);
    expect(IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL).toBe(golden.defaultBitsPerPixel);
  });

  for (const scaleCase of golden.scaleCases) {
    test(`macroblock count matches ${scaleCase.width}x${scaleCase.height}`, () => {
      expect(h264MacroblocksPerFrame(scaleCase.width, scaleCase.height)).toBe(
        scaleCase.macroblocks,
      );
    });
  }
});
