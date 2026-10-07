import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Real encoder output already in the repo: an x264 Annex-B elementary stream
 * (SPS, PPS, SEI, one IDR, nine P frames) used by the desktop decoder tests.
 * No bitstream is hand-written for the packet-boundary tests (issue #10150).
 */
const SAMPLE_H264_PATH = path.resolve(
  import.meta.dir,
  "../../android/desktop-core/src/test/resources/sample.h264",
);

const NAL_SPS = 7;
const NAL_PPS = 8;

export function readCapturedH264Stream(): Buffer {
  return readFileSync(SAMPLE_H264_PATH);
}

interface RawNal {
  /** Offset of the start code (including its leading zero byte when 4 bytes long). */
  start: number;
  type: number;
}

/** Independent of the production splitter: scan for 00 00 01 and read each NAL header. */
function scanNals(stream: Buffer): RawNal[] {
  const nals: RawNal[] = [];
  for (let i = 0; i + 3 < stream.length; i++) {
    if (stream[i] === 0 && stream[i + 1] === 0 && stream[i + 2] === 1) {
      const fourByte = i > 0 && stream[i - 1] === 0;
      nals.push({ start: fourByte ? i - 1 : i, type: stream[i + 3] & 0x1f });
    }
  }
  return nals;
}

const isVcl = (type: number): boolean => type >= 1 && type <= 5;

/**
 * Split the captured stream at its real NAL boundaries into the packets the
 * Android video-server emits: one config packet (SPS+PPS), then one packet per
 * encoded frame (a frame's SEI stays with its slice). Concatenating the result
 * reproduces the captured file byte for byte.
 */
export function capturedH264AsDevicePackets(): Buffer[] {
  const stream = readCapturedH264Stream();
  const nals = scanNals(stream);
  const cuts: number[] = [];
  nals.forEach((nal, index) => {
    const prev = index > 0 ? nals[index - 1] : undefined;
    const startsPacket =
      !prev ||
      nal.type === NAL_SPS ||
      prev.type === NAL_PPS ||
      (isVcl(nal.type) && isVcl(prev.type));
    if (startsPacket) {
      cuts.push(nal.start);
    }
  });
  return cuts.map((start, index) => stream.subarray(start, cuts[index + 1] ?? stream.length));
}
