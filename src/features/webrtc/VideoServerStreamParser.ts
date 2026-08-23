/**
 * Parser for the on-device `video-server` binary stream protocol.
 *
 * The persistent encoder (`android/video-server`, run via `app_process`) writes
 * H.264 over a LocalSocket using a small binary framing:
 *
 * - Stream header (12 bytes, once): `codec_id (4) | width (4) | height (4)`,
 *   all big-endian. `codec_id == 0x68323634` ("h264").
 * - Packet header (12 bytes, per packet): `pts_and_flags (8) | size (4)`,
 *   big-endian, followed by `size` bytes of encoded data.
 *   - bit 63 of `pts_and_flags`: CONFIG (codec config / SPS+PPS)
 *   - bit 62: KEY_FRAME (IDR)
 *   - bit 61: REPLAYED (cached packet for a replacement client)
 *   - bits 60-59: display ROTATION (0..3), attested on CONFIG packets only (issue #4786)
 *   - bits 0-58: presentation timestamp (microseconds)
 *
 * Each packet payload is already Annex-B (MediaCodec AVC byte-buffer output), so
 * the concatenation of payloads is a valid Annex-B elementary stream — exactly
 * what `WebRtcPublisher.writeH264Chunk` expects. This parser is pure and
 * library-agnostic so it can be unit-tested without a device.
 */

import { ActionableError } from "../../models/ActionableError";
import { BufferQueue } from "../../utils/BufferQueue";

/** "h264" as a big-endian int: 0x68323634. */
export const VIDEO_SERVER_CODEC_ID_H264 = 0x68323634;
/** "amux" as a big-endian int: multiplexed audio/video protocol marker. */
export const VIDEO_SERVER_CODEC_ID_AMUX = 0x616d7578;
/** "s16l" as a big-endian int: signed 16-bit little-endian PCM. */
export const VIDEO_SERVER_CODEC_ID_PCM16 = 0x7331366c;
export const VIDEO_SERVER_TRACK_ID_VIDEO = 1;
export const VIDEO_SERVER_TRACK_ID_AUDIO = 2;

const STREAM_HEADER_BYTES = 12;
const PACKET_HEADER_BYTES = 12;
const MUX_TRACK_BYTES = 16;
const MUX_PACKET_HEADER_BYTES = 16;

/**
 * Largest per-packet payload the parser will buffer. A single framing desync
 * makes the 32-bit big-endian `size` field decode to an arbitrary value, so
 * without a cap the parser buffers incoming bytes indefinitely while it waits
 * for a bogus length — unbounded host-memory growth on a live 4-8 Mbps feed.
 * 16 MiB sits comfortably above any real keyframe at the supported
 * resolutions/bitrates, so legitimate maximum-size IDRs still parse while a
 * corrupt length surfaces a bounded parse error instead.
 */
export const MAX_PACKET_BYTES = 16 * 1024 * 1024;

/**
 * Largest declared mux `trackCount`. The multiplexed protocol carries a handful
 * of tracks (video + audio today); a bogus 32-bit count would otherwise make
 * the header wait for `12 + trackCount * 16` bytes that never arrive.
 */
export const MAX_TRACK_COUNT = 16;
const FLAG_CONFIG = 1n << 63n;
const FLAG_KEY_FRAME = 1n << 62n;
const FLAG_REPLAYED = 1n << 61n;
/**
 * Display rotation (0..3) occupies bits 60-59 of `ptsAndFlags`, attested on CONFIG packets only
 * (issue #4786). A real microsecond PTS never reaches bit 59 (~18 000 years), so narrowing the PTS
 * mask to bits 0-58 is backward compatible: old streams wrote 0 there.
 */
const ROTATION_SHIFT = 59n;
const ROTATION_MASK = 0b11n << ROTATION_SHIFT;
const PTS_MASK = (1n << ROTATION_SHIFT) - 1n;
/** Mux header wire version whose config packets attest rotation in bits 60-59 (issue #4786). */
export const VIDEO_SERVER_MUX_VERSION = 2;

export interface VideoServerStreamHeader {
  codecId: number;
  width: number;
  height: number;
  muxed?: boolean;
  audio?: boolean;
  /** Mux wire version (issue #4786); present only for the muxed header, absent for legacy. */
  muxVersion?: number;
}

export interface VideoServerPacket {
  trackId: number;
  codecId: number;
  /** The encoded payload (Annex-B H.264). */
  data: Buffer;
  /** Codec configuration data (SPS/PPS), not a displayable frame. */
  config: boolean;
  /** Key frame (IDR). */
  keyFrame: boolean;
  /** Cached packet replayed for a replacement LocalSocket client. */
  replayed: boolean;
  /**
   * Attested display rotation (0..3), present ONLY on CONFIG packets (issue #4786); `undefined` on
   * non-config packets. A config packet always carries a valid rotation, so `undefined` here means
   * "not a config packet", never "config packet without rotation".
   */
  rotation?: number;
  /** Presentation timestamp in microseconds. */
  ptsUs: number;
}

export interface VideoServerStreamParserCallbacks {
  /** Fired once, when the 12-byte stream header has been read. */
  onHeader?: (header: VideoServerStreamHeader) => void;
  /** Fired for each complete packet. */
  onPacket: (packet: VideoServerPacket) => void;
}

/**
 * Incremental parser: feed arbitrary byte chunks via {@link push}; the header
 * and complete packets are dispatched to the callbacks as soon as they are
 * fully buffered. Bytes for a not-yet-complete packet are retained across calls.
 */
export class VideoServerStreamParser {
  private readonly buffered = new BufferQueue();
  private header: VideoServerStreamHeader | null = null;
  private muxTracks: Map<number, { codecId: number; param1: number; param2: number }> | null = null;

  constructor(private readonly callbacks: VideoServerStreamParserCallbacks) {}

  /**
   * Extract the attested rotation (0..3) from a packet's flags, but only for CONFIG packets — the
   * rotation bits are undefined on any other packet (issue #4786).
   */
  private static rotationFromFlags(flags: bigint): number | undefined {
    if ((flags & FLAG_CONFIG) === 0n) {
      return undefined;
    }
    return Number((flags & ROTATION_MASK) >> ROTATION_SHIFT);
  }

  /**
   * Guard a size/track-count read against its cap. A declared length over the
   * cap means a framing desync (or a corrupt stream): fail fast with a bounded
   * parse error instead of buffering the bogus length forever. The socket
   * wiring routes the throw to its reconnect/fallback path.
   */
  private assertWithinCap(value: number, cap: number, field: string): void {
    if (value > cap) {
      throw new ActionableError(
        `video-server stream declared ${field}=${value}, exceeding the ${cap} cap; ` +
          "the stream is likely corrupt or out of sync.",
      );
    }
  }

  push(chunk: Buffer): void {
    this.buffered.append(chunk);

    if (!this.header && !this.muxTracks) {
      if (this.buffered.length < STREAM_HEADER_BYTES) {
        return;
      }
      const streamHeader = this.buffered.peek(STREAM_HEADER_BYTES);
      const codecOrMagic = streamHeader.readUInt32BE(0);
      if (codecOrMagic === VIDEO_SERVER_CODEC_ID_AMUX) {
        const trackCount = streamHeader.readUInt32BE(8);
        this.assertWithinCap(trackCount, MAX_TRACK_COUNT, "trackCount");
        const headerBytes = STREAM_HEADER_BYTES + trackCount * MUX_TRACK_BYTES;
        if (this.buffered.length < headerBytes) {
          return;
        }
        const fullHeader = this.buffered.peek(headerBytes);
        this.muxTracks = new Map();
        let videoHeader: Pick<VideoServerStreamHeader, "codecId" | "width" | "height"> | null =
          null;
        let hasPcmAudioTrack = false;
        for (let i = 0; i < trackCount; i++) {
          const offset = STREAM_HEADER_BYTES + i * MUX_TRACK_BYTES;
          const trackId = fullHeader.readUInt32BE(offset);
          const codecId = fullHeader.readUInt32BE(offset + 4);
          const param1 = fullHeader.readUInt32BE(offset + 8);
          const param2 = fullHeader.readUInt32BE(offset + 12);
          this.muxTracks.set(trackId, { codecId, param1, param2 });
          if (codecId === VIDEO_SERVER_CODEC_ID_H264) {
            videoHeader = { codecId, width: param1, height: param2 };
          } else if (
            trackId === VIDEO_SERVER_TRACK_ID_AUDIO &&
            codecId === VIDEO_SERVER_CODEC_ID_PCM16
          ) {
            hasPcmAudioTrack = true;
          }
        }
        if (videoHeader) {
          this.header = {
            ...videoHeader,
            muxed: true,
            audio: hasPcmAudioTrack,
            muxVersion: fullHeader.readUInt32BE(4),
          };
          this.callbacks.onHeader?.(this.header);
        }
        this.buffered.discard(headerBytes);
      } else {
        this.header = {
          codecId: codecOrMagic,
          width: streamHeader.readUInt32BE(4),
          height: streamHeader.readUInt32BE(8),
        };
        this.buffered.discard(STREAM_HEADER_BYTES);
        this.callbacks.onHeader?.(this.header);
      }
    }

    if (this.muxTracks) {
      this.drainMuxPackets();
      return;
    }

    while (this.buffered.length >= PACKET_HEADER_BYTES) {
      const packetHeader = this.buffered.peek(PACKET_HEADER_BYTES);
      const flags = packetHeader.readBigUInt64BE(0);
      const size = packetHeader.readUInt32BE(8);
      this.assertWithinCap(size, MAX_PACKET_BYTES, "packet size");
      if (this.buffered.length < PACKET_HEADER_BYTES + size) {
        break; // wait for the rest of the payload
      }
      this.buffered.discard(PACKET_HEADER_BYTES);
      const data = this.buffered.takeDetached(size);
      this.callbacks.onPacket({
        trackId: VIDEO_SERVER_TRACK_ID_VIDEO,
        codecId: this.header?.codecId ?? VIDEO_SERVER_CODEC_ID_H264,
        data,
        config: (flags & FLAG_CONFIG) !== 0n,
        keyFrame: (flags & FLAG_KEY_FRAME) !== 0n,
        replayed: (flags & FLAG_REPLAYED) !== 0n,
        rotation: VideoServerStreamParser.rotationFromFlags(flags),
        ptsUs: Number(flags & PTS_MASK),
      });
    }
  }

  private drainMuxPackets(): void {
    while (this.buffered.length >= MUX_PACKET_HEADER_BYTES) {
      const packetHeader = this.buffered.peek(MUX_PACKET_HEADER_BYTES);
      const trackId = packetHeader.readUInt32BE(0);
      const flags = packetHeader.readBigUInt64BE(4);
      const size = packetHeader.readUInt32BE(12);
      this.assertWithinCap(size, MAX_PACKET_BYTES, "packet size");
      if (this.buffered.length < MUX_PACKET_HEADER_BYTES + size) {
        break;
      }
      this.buffered.discard(MUX_PACKET_HEADER_BYTES);
      const data = this.buffered.takeDetached(size);
      const track = this.muxTracks?.get(trackId);
      if (!track) {
        continue;
      }
      this.callbacks.onPacket({
        trackId,
        codecId: track.codecId,
        data,
        config: (flags & FLAG_CONFIG) !== 0n,
        keyFrame: (flags & FLAG_KEY_FRAME) !== 0n,
        replayed: (flags & FLAG_REPLAYED) !== 0n,
        rotation: VideoServerStreamParser.rotationFromFlags(flags),
        ptsUs: Number(flags & PTS_MASK),
      });
    }
  }
}
