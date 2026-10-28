import { ActionableError } from "../../models/ActionableError";

/** Interleaved signed 16-bit PCM. Every audio path (injection, capture, analysis) uses this shape. */
export interface PcmAudio {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
}

/** The floor reported for digital silence, so levels stay finite and JSON-safe. */
export const MIN_DBFS = -120;
/** Default threshold below which a capture window counts as silent. */
export const DEFAULT_SILENCE_THRESHOLD_DBFS = -50;

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

interface WavFormat {
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

function invalidWav(reason: string): ActionableError {
  return new ActionableError(
    `Unsupported audio file: ${reason}. Provide an uncompressed PCM WAV file (8/16/24/32-bit integer or 32-bit float).`,
  );
}

function ascii(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function readFormat(view: DataView, offset: number, size: number): WavFormat {
  if (size < 16) {
    throw invalidWav("fmt chunk is too short");
  }
  let formatTag = view.getUint16(offset, true);
  if (formatTag === WAVE_FORMAT_EXTENSIBLE && size >= 26) {
    // The first two bytes of the SubFormat GUID carry the real format tag.
    formatTag = view.getUint16(offset + 24, true);
  }
  return {
    formatTag,
    channels: view.getUint16(offset + 2, true),
    sampleRate: view.getUint32(offset + 4, true),
    bitsPerSample: view.getUint16(offset + 14, true),
  };
}

function sampleReader(format: WavFormat): (view: DataView, offset: number) => number {
  const { formatTag, bitsPerSample } = format;
  if (formatTag === WAVE_FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
    return (view, offset) =>
      Math.round(Math.max(-1, Math.min(1, view.getFloat32(offset, true))) * 32767);
  }
  if (formatTag !== WAVE_FORMAT_PCM) {
    throw invalidWav(`format tag ${formatTag} is compressed or unknown`);
  }
  switch (bitsPerSample) {
    case 8:
      return (view, offset) => (view.getUint8(offset) - 128) << 8;
    case 16:
      return (view, offset) => view.getInt16(offset, true);
    case 24:
      return (view, offset) => view.getInt16(offset + 1, true);
    case 32:
      return (view, offset) => view.getInt32(offset, true) >> 16;
    default:
      throw invalidWav(`${bitsPerSample}-bit samples are not supported`);
  }
}

function decodeSamples(view: DataView, start: number, size: number, format: WavFormat): Int16Array {
  const bytesPerSample = format.bitsPerSample / 8;
  const count = Math.floor(Math.min(size, view.byteLength - start) / bytesPerSample);
  const read = sampleReader(format);
  const samples = new Int16Array(count);
  for (let index = 0; index < count; index++) {
    samples[index] = read(view, start + index * bytesPerSample);
  }
  return samples;
}

/** Decodes a RIFF/WAVE file into interleaved 16-bit PCM. */
export function parseWav(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || ascii(view, 0) !== "RIFF" || ascii(view, 8) !== "WAVE") {
    throw invalidWav("missing RIFF/WAVE header");
  }
  let format: WavFormat | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = readFormat(view, body, size);
    } else if (id === "data") {
      if (!format) {
        throw invalidWav("data chunk precedes the fmt chunk");
      }
      if (format.channels < 1 || format.sampleRate < 1) {
        throw invalidWav("fmt chunk declares no channels or no sample rate");
      }
      const samples = decodeSamples(view, body, size, format);
      return { sampleRate: format.sampleRate, channels: format.channels, samples };
    }
    // Chunks are padded to an even size.
    offset = body + size + (size % 2);
  }
  throw invalidWav("no data chunk");
}

/** Encodes PCM as a 16-bit RIFF/WAVE file. */
export function encodeWav(pcm: PcmAudio): Uint8Array {
  const dataBytes = pcm.samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, WAVE_FORMAT_PCM, true);
  view.setUint16(22, pcm.channels, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * pcm.channels * 2, true);
  view.setUint16(32, pcm.channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < pcm.samples.length; index++) {
    view.setInt16(44 + index * 2, pcm.samples[index], true);
  }
  return bytes;
}

/** Averages all channels into one. */
export function toMono(pcm: PcmAudio): PcmAudio {
  if (pcm.channels === 1) {
    return pcm;
  }
  const frames = Math.floor(pcm.samples.length / pcm.channels);
  const samples = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < pcm.channels; channel++) {
      sum += pcm.samples[frame * pcm.channels + channel];
    }
    samples[frame] = Math.round(sum / pcm.channels);
  }
  return { sampleRate: pcm.sampleRate, channels: 1, samples };
}

/** Linear-interpolation resample of mono PCM. Good enough for test clips, not for hi-fi. */
export function resampleMono(pcm: PcmAudio, targetRate: number): PcmAudio {
  if (pcm.channels !== 1) {
    throw new Error("resampleMono expects mono PCM");
  }
  if (pcm.sampleRate === targetRate || pcm.samples.length === 0) {
    return { ...pcm, sampleRate: targetRate };
  }
  const ratio = pcm.sampleRate / targetRate;
  const length = Math.max(1, Math.floor(pcm.samples.length / ratio));
  const samples = new Int16Array(length);
  const last = pcm.samples.length - 1;
  for (let index = 0; index < length; index++) {
    const position = index * ratio;
    const left = Math.min(Math.floor(position), last);
    const right = Math.min(left + 1, last);
    const fraction = position - left;
    samples[index] = Math.round(pcm.samples[left] * (1 - fraction) + pcm.samples[right] * fraction);
  }
  return { sampleRate: targetRate, channels: 1, samples };
}

function clamp16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

/** Scales every sample by `gainDb`, clipping at full scale. */
export function applyGainDb(pcm: PcmAudio, gainDb: number): PcmAudio {
  if (gainDb === 0) {
    return pcm;
  }
  const factor = 10 ** (gainDb / 20);
  return { ...pcm, samples: pcm.samples.map((sample) => clamp16(sample * factor)) };
}

export function durationMs(pcm: PcmAudio): number {
  const frames = pcm.samples.length / pcm.channels;
  return Math.round((frames / pcm.sampleRate) * 1000);
}

function toDbfs(level: number): number {
  if (level <= 0) {
    return MIN_DBFS;
  }
  return Math.max(MIN_DBFS, Math.round(20 * Math.log10(level / 32768) * 10) / 10);
}

function rms(samples: Int16Array, start: number, end: number): number {
  if (end <= start) {
    return 0;
  }
  let sumSquares = 0;
  for (let index = start; index < end; index++) {
    sumSquares += samples[index] * samples[index];
  }
  return Math.sqrt(sumSquares / (end - start));
}

function peak(samples: Int16Array): number {
  let max = 0;
  for (const sample of samples) {
    max = Math.max(max, Math.abs(sample));
  }
  return max;
}

export interface AudioLevels {
  durationMs: number;
  rmsDbfs: number;
  peakDbfs: number;
  /** Fraction of fixed windows whose RMS is at or above the silence threshold. */
  activeRatio: number;
  silent: boolean;
}

export interface AnalyzeLevelsOptions {
  silenceThresholdDbfs?: number;
  windowMs?: number;
}

/**
 * Overall and windowed levels. The clip is `silent` when no window reaches the threshold, so a
 * short sound inside a long quiet capture still counts as non-silent.
 */
export function analyzeLevels(pcm: PcmAudio, options: AnalyzeLevelsOptions = {}): AudioLevels {
  const threshold = options.silenceThresholdDbfs ?? DEFAULT_SILENCE_THRESHOLD_DBFS;
  const windowSamples = Math.max(
    pcm.channels,
    Math.round(((options.windowMs ?? 20) / 1000) * pcm.sampleRate) * pcm.channels,
  );
  const { samples } = pcm;
  let windows = 0;
  let active = 0;
  for (let start = 0; start < samples.length; start += windowSamples) {
    windows++;
    if (toDbfs(rms(samples, start, Math.min(start + windowSamples, samples.length))) >= threshold) {
      active++;
    }
  }
  return {
    durationMs: durationMs(pcm),
    rmsDbfs: toDbfs(rms(samples, 0, samples.length)),
    peakDbfs: toDbfs(peak(samples)),
    activeRatio: windows === 0 ? 0 : Math.round((active / windows) * 1000) / 1000,
    silent: active === 0,
  };
}

export interface SineToneOptions {
  frequencyHz?: number;
  durationMs: number;
  sampleRate?: number;
  /** Peak amplitude relative to full scale. */
  amplitudeDbfs?: number;
}

/** A mono sine tone, the built-in clip for injection when the caller has no file. */
export function sineTone(options: SineToneOptions): PcmAudio {
  const sampleRate = options.sampleRate ?? 48_000;
  const frequency = options.frequencyHz ?? 1_000;
  const amplitude = 32767 * 10 ** ((options.amplitudeDbfs ?? -6) / 20);
  const length = Math.round((options.durationMs / 1000) * sampleRate);
  const samples = new Int16Array(length);
  for (let index = 0; index < length; index++) {
    samples[index] = clamp16(amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate));
  }
  return { sampleRate, channels: 1, samples };
}
