/**
 * H.264 elementary-stream helpers used by the WebRTC publisher.
 *
 * The Android capture path (`adb exec-out screenrecord --output-format=h264 -`)
 * emits an Annex-B byte stream: a sequence of NAL units separated by
 * `00 00 01` or `00 00 00 01` start codes. To send that stream over WebRTC we
 * must (1) split it back into NAL units, (2) group NAL units into access units
 * (one displayed frame) so every fragment of a frame shares an RTP timestamp,
 * and (3) packetize each NAL unit into RTP payloads per RFC 6184.
 *
 * Specification: https://www.rfc-editor.org/rfc/rfc6184.html
 * - single-NAL and FU-A payload structures: §§5.2, 5.6, and 5.8
 * - RTP marker use for an access unit: §5.1
 *
 * All functions here are pure / library-agnostic so they can be unit-tested
 * without werift or a device. The publisher (`WebRtcPublisher`) owns RTP header
 * assignment (sequence numbers, timestamps, SSRC, marker bit).
 */

import { ActionableError } from "../../models";

/** NAL unit type for an Access Unit Delimiter (RFC / H.264 §7.4.1). */
export const NAL_TYPE_AUD = 9;
/** NAL unit type for a Sequence Parameter Set. */
export const NAL_TYPE_SPS = 7;
/** NAL unit type for a Picture Parameter Set. */
export const NAL_TYPE_PPS = 8;
/** NAL unit type for a coded slice of an IDR (key frame) picture. */
export const NAL_TYPE_IDR = 5;
/** NAL unit type for Supplemental Enhancement Information. */
export const NAL_TYPE_SEI = 6;
/** RFC 6184 FU-A fragmentation unit NAL type. */
export const FU_A_TYPE = 28;
/** FU-A per-fragment overhead: 1-byte FU indicator + 1-byte FU header. */
export const FU_A_HEADER_BYTES = 2;

/**
 * Default RTP payload MTU. 1200 bytes leaves headroom under a 1500-byte
 * Ethernet MTU for IP/UDP/RTP/SRTP/DTLS overhead, matching common WebRTC stacks.
 * This value is an AutoMobile operational choice, not an RFC 6184 requirement.
 */
export const DEFAULT_RTP_MTU = 1200;
/** Bound incomplete Annex-B NAL retention for a wedged or malformed capture source. */
export const MAX_ANNEX_B_BUFFER_BYTES = 4 * 1024 * 1024;

/** Return the NAL unit type (lower 5 bits of the first byte). */
export function nalUnitType(nal: Buffer): number {
  return nal.length > 0 ? nal[0] & 0x1f : 0;
}

/** True for VCL NAL types (coded slices: 1 non-IDR, 5 IDR). */
export function isVclNal(nal: Buffer): boolean {
  const type = nalUnitType(nal);
  return type >= 1 && type <= 5;
}

/**
 * True if a VCL NAL is the first slice of a new picture. `first_mb_in_slice` is
 * the leading `ue(v)` of the slice header; value 0 encodes as a single `1` bit,
 * so the MSB of the first RBSP byte (after the 1-byte NAL header) is set iff
 * `first_mb_in_slice == 0`. Later slices of the same (multi-slice) picture have
 * `first_mb_in_slice > 0` and must stay in the same access unit.
 */
export function isFirstSliceOfPicture(nal: Buffer): boolean {
  return nal.length > 1 && (nal[1] & 0x80) !== 0;
}

/** True if the NAL unit is a key-frame (IDR) slice. */
export function isKeyFrameNal(nal: Buffer): boolean {
  return nalUnitType(nal) === NAL_TYPE_IDR;
}

/**
 * Incremental Annex-B splitter. Feed arbitrary byte chunks via {@link push};
 * complete NAL units (with the start code stripped) are returned as soon as the
 * following start code is observed. Bytes for a not-yet-terminated NAL unit are
 * retained across calls so chunk boundaries never corrupt a NAL unit.
 */
export class H264AnnexBParser {
  private buffered: Buffer = Buffer.alloc(0);

  constructor(private readonly maxBufferedBytes: number = MAX_ANNEX_B_BUFFER_BYTES) {
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
      throw new Error("H.264 Annex-B parser buffer limit must be a positive integer.");
    }
  }

  /** Feed a chunk; returns any NAL units that became complete. */
  push(chunk: Buffer): Buffer[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
    if (this.buffered.length > this.maxBufferedBytes) {
      this.buffered = Buffer.alloc(0);
      throw new Error(
        `H.264 Annex-B parser buffer exceeded ${this.maxBufferedBytes} bytes without a complete NAL.`,
      );
    }
    return this.drain(false);
  }

  /** Emit any trailing NAL unit still buffered (call once the stream ends). */
  flush(): Buffer[] {
    return this.drain(true);
  }

  /**
   * Whether the incomplete trailing NAL has the requested type. This inspects
   * only a complete start code plus its header and leaves the NAL buffered for
   * normal boundary-aware delivery.
   */
  hasBufferedNalType(type: number): boolean {
    const startCodes = this.findStartCodes(this.buffered);
    const last = startCodes.at(-1);
    if (!last) {
      return false;
    }
    const headerOffset = last.offset + last.length;
    return (
      headerOffset < this.buffered.length &&
      nalUnitType(this.buffered.subarray(headerOffset)) === type
    );
  }

  private drain(final: boolean): Buffer[] {
    const nals: Buffer[] = [];
    const startCodes = this.findStartCodes(this.buffered);

    if (startCodes.length === 0) {
      if (final) {
        this.buffered = Buffer.alloc(0);
      }
      return nals;
    }

    // Emit the NAL unit between each start code and the next one.
    for (let i = 0; i < startCodes.length - 1; i++) {
      const nalStart = startCodes[i].offset + startCodes[i].length;
      const nalEnd = startCodes[i + 1].offset;
      const nal = this.buffered.subarray(nalStart, nalEnd);
      if (nal.length > 0) {
        nals.push(Buffer.from(nal));
      }
    }

    const last = startCodes[startCodes.length - 1];
    if (final) {
      const nal = this.buffered.subarray(last.offset + last.length);
      if (nal.length > 0) {
        nals.push(Buffer.from(nal));
      }
      this.buffered = Buffer.alloc(0);
    } else {
      // Keep everything from the last start code onward; that NAL unit is not
      // terminated until the next start code arrives.
      this.buffered = Buffer.from(this.buffered.subarray(last.offset));
    }

    return nals;
  }

  private findStartCodes(data: Buffer): Array<{ offset: number; length: number }> {
    const result: Array<{ offset: number; length: number }> = [];
    for (let i = 0; i + 2 < data.length; i++) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        const fourByte = i > 0 && data[i - 1] === 0;
        result.push({ offset: fourByte ? i - 1 : i, length: fourByte ? 4 : 3 });
      }
    }
    return result;
  }
}

/**
 * Groups NAL units into access units (a single coded picture plus its
 * associated parameter sets / delimiters). A new access unit begins at an
 * Access Unit Delimiter, or at a VCL NAL unit when the current access unit
 * already contains one. This keeps SPS/PPS + IDR together and assigns one RTP
 * timestamp per displayed frame.
 */
export class H264AccessUnitAssembler {
  private current: Buffer[] = [];
  private hasVcl = false;

  /** Feed a NAL unit; returns access units that became complete. */
  push(nal: Buffer): Buffer[][] {
    const completed: Buffer[][] = [];
    const type = nalUnitType(nal);
    // Parameter sets / SEI that arrive *after* the current AU already has a VCL
    // slice belong to the NEXT access unit (H.264 §7.4.1.2.3). Handling this is
    // what keeps a segment-restart's fresh SPS/PPS grouped with its following
    // IDR (e.g. `P, SPS, PPS, IDR`) instead of being appended to the prior frame.
    const beginsNextAuAfterVcl =
      type === NAL_TYPE_SPS || type === NAL_TYPE_PPS || type === NAL_TYPE_SEI;
    // A VCL NAL begins a new access unit only when it is the FIRST slice of a
    // picture. Multi-slice encoders emit several VCL NALs per frame; the later
    // slices (first_mb_in_slice > 0) must stay in the current access unit so the
    // whole picture shares one RTP timestamp and a single marker bit.
    const startsNewAccessUnit =
      (isVclNal(nal) && this.hasVcl && isFirstSliceOfPicture(nal)) ||
      (type === NAL_TYPE_AUD && this.current.length > 0) ||
      (beginsNextAuAfterVcl && this.hasVcl);

    if (startsNewAccessUnit) {
      completed.push(this.current);
      this.current = [];
      this.hasVcl = false;
    }

    this.current.push(nal);
    if (isVclNal(nal)) {
      this.hasVcl = true;
    }

    return completed;
  }

  /** Emit the in-progress access unit, if any. */
  flush(): Buffer[][] {
    if (this.current.length === 0) {
      return [];
    }
    const au = this.current;
    this.current = [];
    this.hasVcl = false;
    return [au];
  }
}

/**
 * Packetize one NAL unit into RTP payloads per RFC 6184. NAL units that fit
 * within `mtu` are sent as a Single NAL Unit packet; larger ones are split into
 * FU-A fragments. Returns the ordered list of RTP payload buffers (RTP header
 * assignment is the caller's responsibility).
 */
export function packetizeNalUnit(nal: Buffer, mtu: number = DEFAULT_RTP_MTU): Buffer[] {
  if (nal.length === 0) {
    return [];
  }
  if (nal.length <= mtu) {
    return [Buffer.from(nal)];
  }

  // Fragmentation reserves 2 bytes per packet for the FU indicator + FU header.
  // An MTU that leaves no room for at least one payload byte would make the
  // fragment loop below never advance, wedging the daemon (issue #4170). A
  // non-finite MTU (NaN) would silently truncate the NAL to a single empty
  // fragment. Reject both so a misconfigured MTU fails loudly instead.
  // Note: Infinity is handled by the single-packet fast path above and never
  // reaches here.
  if (!Number.isFinite(mtu) || mtu <= FU_A_HEADER_BYTES) {
    throw new ActionableError(
      `RTP MTU ${mtu} is too small to fragment a ${nal.length}-byte NAL unit; it must exceed the ${FU_A_HEADER_BYTES}-byte FU-A header.`,
    );
  }

  const nalHeader = nal[0];
  const forbiddenAndNri = nalHeader & 0xe0;
  const nalType = nalHeader & 0x1f;
  const fuIndicator = forbiddenAndNri | FU_A_TYPE;

  const payload = nal.subarray(1);
  const maxFragmentSize = mtu - 2; // 2 bytes: FU indicator + FU header
  const packets: Buffer[] = [];

  let offset = 0;
  while (offset < payload.length) {
    const fragmentSize = Math.min(maxFragmentSize, payload.length - offset);
    const isFirst = offset === 0;
    const isLast = offset + fragmentSize >= payload.length;

    let fuHeader = nalType;
    if (isFirst) {
      fuHeader |= 0x80; // Start bit
    }
    if (isLast) {
      fuHeader |= 0x40; // End bit
    }

    packets.push(
      Buffer.concat([
        Buffer.from([fuIndicator, fuHeader]),
        payload.subarray(offset, offset + fragmentSize),
      ]),
    );
    offset += fragmentSize;
  }

  return packets;
}

/** An RTP payload plus whether it is the final packet of its access unit. */
export interface RtpPayloadUnit {
  payload: Buffer;
  /** RTP marker bit — set on the last packet of an access unit (frame). */
  marker: boolean;
}

/**
 * Packetize a full access unit (list of NAL units) into ordered RTP payload
 * units, setting the marker bit only on the very last packet of the frame.
 */
export function packetizeAccessUnit(
  accessUnit: Buffer[],
  mtu: number = DEFAULT_RTP_MTU,
): RtpPayloadUnit[] {
  const payloads: Buffer[] = [];
  for (const nal of accessUnit) {
    for (const packet of packetizeNalUnit(nal, mtu)) {
      payloads.push(packet);
    }
  }

  return payloads.map((payload, index) => ({
    payload,
    marker: index === payloads.length - 1,
  }));
}
