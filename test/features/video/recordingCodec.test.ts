import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultRecordingCodecProbe,
  parseMp4VideoCodec,
} from "../../../src/features/video/recordingCodec";

/** Build an ISO-BMFF box: [uint32 size][4-char type][payload]. */
function box(type: string, ...children: Buffer[]): Buffer {
  const payload = Buffer.concat(children);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, payload]);
}

/** A `stsd` box wrapping the given sample-entry boxes. */
function stsd(...entries: Buffer[]): Buffer {
  const preamble = Buffer.alloc(8); // version(1) + flags(3) + entry_count(4)
  preamble.writeUInt32BE(entries.length, 4);
  return box("stsd", preamble, ...entries);
}

/** A sample-entry box whose FourCC type carries the codec identity. */
function sampleEntry(fourcc: string): Buffer {
  // Real sample entries carry reserved fields; the parser only reads the header,
  // so any payload length is fine.
  return box(fourcc, Buffer.alloc(16));
}

/** Wrap sample-description entries in the moov→trak→…→stbl nesting. */
function trak(...entries: Buffer[]): Buffer {
  return box("trak", box("mdia", box("minf", box("stbl", stsd(...entries)))));
}

function moov(...traks: Buffer[]): Buffer {
  return box("moov", ...traks);
}

const FTYP = box("ftyp", Buffer.from("isomiso2", "latin1"));

describe("parseMp4VideoCodec", () => {
  test("maps an avc1 sample entry to h264", () => {
    const mp4 = Buffer.concat([FTYP, moov(trak(sampleEntry("avc1"))), box("mdat", Buffer.alloc(8))]);
    expect(parseMp4VideoCodec(mp4)).toBe("h264");
  });

  test("maps avc3 to h264", () => {
    expect(parseMp4VideoCodec(moov(trak(sampleEntry("avc3"))))).toBe("h264");
  });

  test("maps hvc1 (simctl default) to hevc", () => {
    const mp4 = Buffer.concat([FTYP, moov(trak(sampleEntry("hvc1"))), box("mdat", Buffer.alloc(8))]);
    expect(parseMp4VideoCodec(mp4)).toBe("hevc");
  });

  test("maps hev1 to hevc", () => {
    expect(parseMp4VideoCodec(moov(trak(sampleEntry("hev1"))))).toBe("hevc");
  });

  test("skips a leading audio track and finds the video track", () => {
    const mp4 = moov(trak(sampleEntry("mp4a")), trak(sampleEntry("hvc1")));
    expect(parseMp4VideoCodec(mp4)).toBe("hevc");
  });

  test("returns undefined when no known video codec is present", () => {
    expect(parseMp4VideoCodec(moov(trak(sampleEntry("mp4a"))))).toBeUndefined();
  });

  test("returns undefined for an empty or non-container buffer", () => {
    expect(parseMp4VideoCodec(Buffer.alloc(0))).toBeUndefined();
    expect(parseMp4VideoCodec(Buffer.from("not an mp4 file", "latin1"))).toBeUndefined();
  });

  test("does not descend into a declared box size that overruns the buffer", () => {
    // A truncated moov whose declared size exceeds the buffer must not throw.
    const truncated = moov(trak(sampleEntry("avc1"))).subarray(0, 20);
    expect(parseMp4VideoCodec(truncated)).toBeUndefined();
  });
});

describe("defaultRecordingCodecProbe", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "recording-codec-"));
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  test("reads the codec from a finalized file (moov before mdat)", async () => {
    const filePath = path.join(tempDir, "faststart.mp4");
    const mp4 = Buffer.concat([FTYP, moov(trak(sampleEntry("hvc1"))), box("mdat", Buffer.alloc(64))]);
    await fsPromises.writeFile(filePath, mp4);
    expect(await defaultRecordingCodecProbe.codec(filePath)).toBe("hevc");
  });

  test("skips a large mdat that precedes moov without misreading its bytes", async () => {
    const filePath = path.join(tempDir, "mdat-first.mp4");
    // mdat payload deliberately contains bytes that look like an avc1 stsd, to
    // prove the walker skips mdat by its declared size rather than scanning it.
    const decoy = moov(trak(sampleEntry("avc1")));
    const mdat = box("mdat", decoy);
    const mp4 = Buffer.concat([FTYP, mdat, moov(trak(sampleEntry("hvc1")))]);
    await fsPromises.writeFile(filePath, mp4);
    expect(await defaultRecordingCodecProbe.codec(filePath)).toBe("hevc");
  });

  test("returns undefined for a non-mp4 file rather than throwing", async () => {
    const filePath = path.join(tempDir, "bogus.mp4");
    await fsPromises.writeFile(filePath, Buffer.alloc(4096, 1));
    expect(await defaultRecordingCodecProbe.codec(filePath)).toBeUndefined();
  });

  test("returns undefined when the file does not exist rather than throwing", async () => {
    expect(await defaultRecordingCodecProbe.codec(path.join(tempDir, "missing.mp4"))).toBeUndefined();
  });
});
