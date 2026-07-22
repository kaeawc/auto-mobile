import { RtpHeader, RtpPacket } from "werift";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  DEFAULT_RTP_MTU,
  H264AccessUnitAssembler,
  H264AnnexBParser,
  isKeyFrameNal,
  packetizeAccessUnit,
} from "./h264";

/**
 * H.264 RTP clock rate (90 kHz, fixed by RFC 6184 §6).
 * https://www.rfc-editor.org/rfc/rfc6184.html#section-6
 */
export const H264_CLOCK_RATE = 90_000;

/**
 * Minimal sink the writer needs from a media track. werift's `MediaStreamTrack`
 * satisfies this via `writeRtp`, but the narrow interface keeps the writer
 * unit-testable without a peer connection.
 */
export interface RtpPacketSink {
  writeRtp(packet: RtpPacket): void;
}

export interface RtpH264TrackWriterOptions {
  sink: RtpPacketSink;
  /** RTP SSRC for this stream. */
  ssrc: number;
  /** Payload type; werift overrides this from the negotiated codec, so it is only a hint. */
  payloadType?: number;
  /** Max RTP payload size before FU-A fragmentation. */
  mtu?: number;
  timer?: Timer;
  /** Initial 16-bit sequence number (defaults to 0). */
  initialSequenceNumber?: number;
  /** Observes each complete SPS before it can be sent to the negotiated peer. */
  onSps?: (nal: Buffer) => void;
}

/**
 * Consumes an Annex-B H.264 elementary stream and writes RFC 6184 RTP packets
 * to a sink. Access units are timestamped from a wall clock (90 kHz), so RTP
 * pacing tracks real capture time regardless of the encoder's nominal frame
 * rate. The marker bit is set on the last packet of each frame, as required
 * for an H.264 access unit by RFC 6184 §5.1:
 * https://www.rfc-editor.org/rfc/rfc6184.html#section-5.1
 */
export class RtpH264TrackWriter {
  private readonly sink: RtpPacketSink;
  private readonly ssrc: number;
  private readonly payloadType: number;
  private readonly mtu: number;
  private readonly timer: Timer;
  private readonly onSps?: (nal: Buffer) => void;
  private readonly parser = new H264AnnexBParser();
  private readonly assembler = new H264AccessUnitAssembler();

  private sequenceNumber: number;
  private baseTimeMs: number | null = null;
  private accessUnitStartMs: number | null = null;
  private framesWritten = 0;
  private packetsWritten = 0;
  private sawKeyFrame = false;

  constructor(options: RtpH264TrackWriterOptions) {
    this.sink = options.sink;
    this.ssrc = options.ssrc >>> 0;
    this.payloadType = options.payloadType ?? 102;
    this.mtu = options.mtu ?? DEFAULT_RTP_MTU;
    if (!Number.isSafeInteger(this.mtu) || this.mtu < 3) {
      throw new Error("H.264 RTP MTU must be an integer of at least 3 bytes.");
    }
    this.timer = options.timer ?? defaultTimer;
    this.onSps = options.onSps;
    this.sequenceNumber = (options.initialSequenceNumber ?? 0) & 0xffff;
  }

  /** Feed a chunk of the elementary stream; RTP packets are written eagerly. */
  writeChunk(chunk: Buffer): void {
    for (const nal of this.parser.push(chunk)) {
      this.consumeNal(nal);
    }
  }

  /** Flush the trailing NAL unit / access unit at end of stream. */
  flush(): void {
    for (const nal of this.parser.flush()) {
      this.consumeNal(nal);
    }
    for (const accessUnit of this.assembler.flush()) {
      this.writeAccessUnit(accessUnit, this.accessUnitStartMs ?? this.timer.now());
      this.accessUnitStartMs = null;
    }
  }

  get stats(): { framesWritten: number; packetsWritten: number; sawKeyFrame: boolean } {
    return {
      framesWritten: this.framesWritten,
      packetsWritten: this.packetsWritten,
      sawKeyFrame: this.sawKeyFrame,
    };
  }

  private consumeNal(nal: Buffer): void {
    if ((nal[0] & 0x1f) === 7) {
      this.onSps?.(nal);
    }
    if (isKeyFrameNal(nal)) {
      this.sawKeyFrame = true;
    }
    // An access unit is timestamped by when its first NAL arrived, not when the
    // next frame's boundary flushes it — otherwise every frame's timestamp would
    // lag by one frame. `assembler.push` returning a completed AU means `nal`
    // just started a fresh access unit "now".
    const completed = this.assembler.push(nal);
    for (const accessUnit of completed) {
      this.writeAccessUnit(accessUnit, this.accessUnitStartMs ?? this.timer.now());
      this.accessUnitStartMs = null;
    }
    if (this.accessUnitStartMs === null) {
      this.accessUnitStartMs = this.timer.now();
    }
  }

  private writeAccessUnit(accessUnit: Buffer[], startMs: number): void {
    const timestamp = this.rtpTimestamp(startMs);
    const units = packetizeAccessUnit(accessUnit, this.mtu);
    if (units.length === 0) {
      return;
    }

    for (const unit of units) {
      const header = new RtpHeader({
        version: 2,
        payloadType: this.payloadType,
        marker: unit.marker,
        sequenceNumber: this.sequenceNumber,
        timestamp,
        ssrc: this.ssrc,
      });
      this.sink.writeRtp(new RtpPacket(header, unit.payload));
      this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
      this.packetsWritten++;
    }

    this.framesWritten++;
  }

  private rtpTimestamp(startMs: number): number {
    if (this.baseTimeMs === null) {
      this.baseTimeMs = startMs;
    }
    const elapsedMs = Math.max(0, startMs - this.baseTimeMs);
    return Math.round(elapsedMs * (H264_CLOCK_RATE / 1000)) >>> 0;
  }
}
