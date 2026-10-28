import { describe, expect, test } from "bun:test";
import {
  analyzeLevels,
  applyGainDb,
  durationMs,
  encodeWav,
  MIN_DBFS,
  parseWav,
  resampleMono,
  sineTone,
  toMono,
  type PcmAudio,
} from "../../../src/utils/audio/pcm";

function wavWith(
  format: { tag: number; channels: number; rate: number; bits: number },
  data: Uint8Array,
): Uint8Array {
  const bytes = new Uint8Array(44 + data.byteLength);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) =>
    [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + data.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format.tag, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.rate, true);
  view.setUint16(34, format.bits, true);
  ascii(36, "data");
  view.setUint32(40, data.byteLength, true);
  bytes.set(data, 44);
  return bytes;
}

describe("WAV codec", () => {
  test("round-trips 16-bit PCM", () => {
    const pcm: PcmAudio = {
      sampleRate: 16_000,
      channels: 2,
      samples: Int16Array.from([1, -2, 32767, -32768]),
    };
    expect(parseWav(encodeWav(pcm))).toEqual(pcm);
  });

  test("decodes 8-bit unsigned samples around the 128 midpoint", () => {
    const pcm = parseWav(
      wavWith({ tag: 1, channels: 1, rate: 8_000, bits: 8 }, Uint8Array.from([128, 255, 0])),
    );
    expect(Array.from(pcm.samples)).toEqual([0, 127 << 8, -32768]);
  });

  test("decodes 32-bit float samples, clipping out-of-range values", () => {
    const data = new Uint8Array(12);
    const view = new DataView(data.buffer);
    view.setFloat32(0, 0.5, true);
    view.setFloat32(4, -2, true);
    view.setFloat32(8, 0, true);
    const pcm = parseWav(wavWith({ tag: 3, channels: 1, rate: 44_100, bits: 32 }, data));
    expect(Array.from(pcm.samples)).toEqual([16384, -32767, 0]);
  });

  test("skips unknown chunks before the data chunk", () => {
    const base = encodeWav({ sampleRate: 8_000, channels: 1, samples: Int16Array.from([7]) });
    const extra = Uint8Array.from(
      [..."LIST"].map((c) => c.charCodeAt(0)).concat([3, 0, 0, 0, 1, 2, 3, 0]),
    );
    const bytes = new Uint8Array(base.byteLength + extra.byteLength);
    bytes.set(base.subarray(0, 36), 0);
    bytes.set(extra, 36);
    bytes.set(base.subarray(36), 36 + extra.byteLength);
    expect(Array.from(parseWav(bytes).samples)).toEqual([7]);
  });

  test("rejects compressed and non-WAV input with an actionable message", () => {
    expect(() => parseWav(new TextEncoder().encode("ID3 not a wav file"))).toThrow(/RIFF\/WAVE/);
    expect(() =>
      parseWav(wavWith({ tag: 0x55, channels: 1, rate: 8_000, bits: 16 }, new Uint8Array(2))),
    ).toThrow(/compressed or unknown/);
  });
});

describe("PCM transforms", () => {
  test("toMono averages channels", () => {
    const mono = toMono({
      sampleRate: 8_000,
      channels: 2,
      samples: Int16Array.from([100, 300, -10, -30]),
    });
    expect(mono).toEqual({ sampleRate: 8_000, channels: 1, samples: Int16Array.from([200, -20]) });
  });

  test("resampleMono halves the sample count when halving the rate", () => {
    const out = resampleMono(
      { sampleRate: 96_000, channels: 1, samples: new Int16Array(960).fill(1000) },
      48_000,
    );
    expect(out.sampleRate).toBe(48_000);
    expect(out.samples.length).toBe(480);
    expect(out.samples.every((sample) => sample === 1000)).toBe(true);
  });

  test("applyGainDb scales and clips", () => {
    const louder = applyGainDb(
      { sampleRate: 8_000, channels: 1, samples: Int16Array.from([1000, 30000]) },
      6,
    );
    expect(louder.samples[0]).toBe(1995);
    expect(louder.samples[1]).toBe(32767);
  });

  test("durationMs counts frames, not samples", () => {
    expect(durationMs({ sampleRate: 1_000, channels: 2, samples: new Int16Array(500) })).toBe(250);
  });
});

describe("analyzeLevels", () => {
  test("digital silence is silent at the dBFS floor", () => {
    const levels = analyzeLevels({
      sampleRate: 48_000,
      channels: 1,
      samples: new Int16Array(4_800),
    });
    expect(levels).toEqual({
      durationMs: 100,
      rmsDbfs: MIN_DBFS,
      peakDbfs: MIN_DBFS,
      activeRatio: 0,
      silent: true,
    });
  });

  test("a -6 dBFS tone peaks near -6 and has RMS 3 dB lower", () => {
    const levels = analyzeLevels(sineTone({ durationMs: 100, amplitudeDbfs: -6 }));
    expect(levels.silent).toBe(false);
    expect(levels.activeRatio).toBe(1);
    expect(levels.peakDbfs).toBeCloseTo(-6, 0);
    expect(levels.rmsDbfs).toBeCloseTo(-9, 0);
  });

  test("a short burst inside a quiet capture is not silent", () => {
    const samples = new Int16Array(48_000);
    samples.set(sineTone({ durationMs: 40 }).samples, 24_000);
    const levels = analyzeLevels({ sampleRate: 48_000, channels: 1, samples });
    expect(levels.silent).toBe(false);
    expect(levels.activeRatio).toBeGreaterThan(0);
    expect(levels.activeRatio).toBeLessThan(0.1);
  });

  test("a tone below the threshold counts as silent", () => {
    const levels = analyzeLevels(sineTone({ durationMs: 50, amplitudeDbfs: -70 }), {
      silenceThresholdDbfs: -60,
    });
    expect(levels.silent).toBe(true);
  });
});
