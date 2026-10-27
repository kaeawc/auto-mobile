/** NAL unit type for an Access Unit Delimiter (RFC / H.264 §7.4.1). */
export const NAL_TYPE_AUD = 9;

/** NAL unit type for a Sequence Parameter Set. */
export const NAL_TYPE_SPS = 7;

/** NAL unit type for a Picture Parameter Set. */
export const NAL_TYPE_PPS = 8;

/** NAL unit type for Supplemental Enhancement Information. */
export const NAL_TYPE_SEI = 6;

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

  /**
   * Emit the in-progress access unit only when it already holds a VCL slice,
   * i.e. a picture is actually in progress. A parameter-set-only prefix
   * (SPS/PPS from a codec-config packet) stays pending so it is still grouped
   * with the IDR that follows it, exactly as when no boundary was signalled.
   * Used at a transport packet boundary where the producer guarantees the
   * packet carried a whole picture (the Android video-server frames one
   * encoder output per packet).
   */
  flushPicture(): Buffer[][] {
    return this.hasVcl ? this.flush() : [];
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
