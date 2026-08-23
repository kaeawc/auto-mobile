import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type DecodedAudio,
  type DecodedEncodedVideo,
  type DecodedFrame,
  encodeEncodedVideoHeader,
  ENCODED_VIDEO_HEIGHT_BASE,
  ENCODED_VIDEO_HEIGHT_MASK,
  FrameDecoder,
  type MalformedFrameError,
} from "../../../src/features/screen-stream/frameProtocol";

interface GoldenRecord {
  name: string;
  keyframe: boolean;
  presentationTimestampMs: number;
  payloadHex: string;
  recordHex: string;
}

interface GoldenVectors {
  headerSize: number;
  encodedVideoHeightBase: string;
  encodedVideoHeightMask: string;
  records: GoldenRecord[];
  resync: {
    corruptedRecordHex: string;
    streamHex: string;
    recoveredRecordName: string;
  };
}

const golden: GoldenVectors = JSON.parse(
  readFileSync(new URL("../../fixtures/encoded-h264-golden-vectors.json", import.meta.url), "utf8"),
) as GoldenVectors;

const byName = (name: string): GoldenRecord => {
  const found = golden.records.find((r) => r.name === name);
  if (found === undefined) {
    throw new Error(`golden record ${name} missing`);
  }
  return found;
};

/** Collect every callback the decoder can fire, so distinctness is provable. */
function drain(
  decoder: FrameDecoder,
  chunk: Buffer,
): {
  frames: DecodedFrame[];
  audio: DecodedAudio[];
  video: DecodedEncodedVideo[];
  malformed: MalformedFrameError[];
} {
  const frames: DecodedFrame[] = [];
  const audio: DecodedAudio[] = [];
  const video: DecodedEncodedVideo[] = [];
  const malformed: MalformedFrameError[] = [];
  decoder.push(
    chunk,
    (err) => malformed.push(err),
    (a) => audio.push(a),
    (f) => frames.push(f),
    (v) => video.push(v),
  );
  return { frames, audio, video, malformed };
}

describe("encoded-video golden vectors (issue #4787)", () => {
  test("the fixture pins the discriminator constants used by the code", () => {
    expect(golden.headerSize).toBe(24);
    expect(parseInt(golden.encodedVideoHeightBase, 16) >>> 0).toBe(ENCODED_VIDEO_HEIGHT_BASE);
    expect(parseInt(golden.encodedVideoHeightMask, 16) >>> 0).toBe(ENCODED_VIDEO_HEIGHT_MASK);
  });

  for (const name of ["keyframe", "delta"]) {
    test(`re-encoding the ${name} record reproduces the golden bytes`, () => {
      const record = byName(name);
      const payload = Buffer.from(record.payloadHex, "hex");
      const header = encodeEncodedVideoHeader({
        payloadLength: payload.length,
        keyframe: record.keyframe,
        presentationTimestampMs: record.presentationTimestampMs,
      });
      expect(Buffer.concat([header, payload]).toString("hex")).toBe(record.recordHex);
    });

    test(`decoding the ${name} record surfaces it distinctly with identical fields`, () => {
      const record = byName(name);
      const out = drain(new FrameDecoder(), Buffer.from(record.recordHex, "hex"));
      // Distinct from raw frames and audio: only the encoded-video callback fires.
      expect(out.frames).toHaveLength(0);
      expect(out.audio).toHaveLength(0);
      expect(out.malformed).toHaveLength(0);
      expect(out.video).toHaveLength(1);
      expect(out.video[0].keyframe).toBe(record.keyframe);
      expect(out.video[0].presentationTimestampMs).toBe(record.presentationTimestampMs);
      expect(out.video[0].payload.toString("hex")).toBe(record.payloadHex);
    });
  }

  test("a corrupted encoded record is reported once, then the decoder recovers the next record", () => {
    const out = drain(new FrameDecoder(), Buffer.from(golden.resync.streamHex, "hex"));
    // Exactly one malformed report for the corruption episode.
    expect(out.malformed).toHaveLength(1);
    expect(out.malformed[0].reason).toBe("header_checksum_mismatch");
    // The following valid record is recovered and decoded.
    const recovered = byName(golden.resync.recoveredRecordName);
    expect(out.video).toHaveLength(1);
    expect(out.video[0].keyframe).toBe(recovered.keyframe);
    expect(out.video[0].presentationTimestampMs).toBe(recovered.presentationTimestampMs);
    expect(out.video[0].payload.toString("hex")).toBe(recovered.payloadHex);
  });

  test("the corrupted record alone yields no decoded video and reports the checksum mismatch", () => {
    const out = drain(new FrameDecoder(), Buffer.from(golden.resync.corruptedRecordHex, "hex"));
    expect(out.video).toHaveLength(0);
    expect(out.frames).toHaveLength(0);
    expect(out.malformed).toHaveLength(1);
    expect(out.malformed[0].reason).toBe("header_checksum_mismatch");
  });

  test("an encoded-video header is never mistaken for audio or a raw frame", () => {
    const record = byName("keyframe");
    const out = drain(new FrameDecoder(), Buffer.from(record.recordHex, "hex"));
    expect(out.audio).toHaveLength(0);
    expect(out.frames).toHaveLength(0);
    expect(out.video).toHaveLength(1);
  });
});
