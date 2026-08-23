import { RtpHeader, RtpPacket } from "werift";
import { ActionableError } from "../../models";
import type { RtpPacketSink } from "./RtpH264TrackWriter";

/**
 * PCMU/G.711 RTP clock rate and static payload type 0.
 * RFC 3551 §6: https://www.rfc-editor.org/rfc/rfc3551.html#section-6
 */
export const PCMU_CLOCK_RATE = 8_000;
export const PCMU_PAYLOAD_TYPE = 0;
const DEFAULT_AUDIO_MTU = 1200;

export interface RtpPcmuTrackWriterOptions {
  sink: RtpPacketSink;
  ssrc: number;
  payloadType?: number;
  mtu?: number;
  initialSequenceNumber?: number;
}

/**
 * Consumes 8 kHz mono signed 16-bit little-endian PCM and writes PCMU RTP
 * packets. The Android audio source emits exactly that format, keeping this
 * writer dependency-free and fast to unit-test.
 */
export class RtpPcmuTrackWriter {
  private readonly sink: RtpPacketSink;
  private readonly ssrc: number;
  private readonly payloadType: number;
  private readonly mtu: number;
  private sequenceNumber: number;
  private timestamp = 0;
  private packetsWritten = 0;
  private samplesWritten = 0;
  private remainder: Buffer | null = null;

  constructor(options: RtpPcmuTrackWriterOptions) {
    this.sink = options.sink;
    this.ssrc = options.ssrc >>> 0;
    this.payloadType = options.payloadType ?? PCMU_PAYLOAD_TYPE;
    this.mtu = options.mtu ?? DEFAULT_AUDIO_MTU;
    // The packetization loop advances by `mtu` bytes per iteration; a zero,
    // negative, or non-finite MTU would never advance and wedge the daemon
    // (issue #4170). Each PCMU sample is one byte, so any mtu >= 1 is legitimate
    // (the audio path deliberately constructs with small MTUs in tests).
    if (!Number.isFinite(this.mtu) || this.mtu <= 0) {
      throw new ActionableError(
        `PCMU RTP MTU must be a positive number of bytes; got ${this.mtu}.`,
      );
    }
    this.sequenceNumber = (options.initialSequenceNumber ?? 0) & 0xffff;
  }

  writePcm16Chunk(chunk: Buffer): void {
    const input = this.remainder ? Buffer.concat([this.remainder, chunk]) : chunk;
    const sampleCount = Math.floor(input.length / 2);
    this.remainder = input.length % 2 === 0 ? null : Buffer.from(input.subarray(-1));
    if (sampleCount === 0) {
      return;
    }

    const payload = Buffer.alloc(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      payload[i] = linear16ToMuLaw(input.readInt16LE(i * 2));
    }

    for (let offset = 0; offset < payload.length; offset += this.mtu) {
      const part = payload.subarray(offset, Math.min(offset + this.mtu, payload.length));
      const header = new RtpHeader({
        version: 2,
        payloadType: this.payloadType,
        marker: false,
        sequenceNumber: this.sequenceNumber,
        timestamp: this.timestamp,
        ssrc: this.ssrc,
      });
      this.sink.writeRtp(new RtpPacket(header, Buffer.from(part)));
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
      this.timestamp = (this.timestamp + part.length) >>> 0;
      this.packetsWritten++;
    }
    this.samplesWritten += sampleCount;
  }

  get stats(): { packetsWritten: number; samplesWritten: number } {
    return {
      packetsWritten: this.packetsWritten,
      samplesWritten: this.samplesWritten,
    };
  }
}

function linear16ToMuLaw(sample: number): number {
  const bias = 0x84;
  const clip = 32635;
  let sign = 0;
  let magnitude = sample;
  if (magnitude < 0) {
    magnitude = -magnitude;
    sign = 0x80;
  }
  magnitude = Math.min(magnitude, clip) + bias;

  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (magnitude & mask) === 0; mask >>= 1) {
    exponent--;
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
