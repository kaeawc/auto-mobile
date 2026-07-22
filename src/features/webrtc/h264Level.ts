/**
 * The constrained-baseline level advertised by AutoMobile's WebRTC sender.
 *
 * Level 4.2 supports 8,192 macroblocks per picture and 522,240 macroblocks
 * per second (RFC 6184 §8.2.2 and ITU-T H.264 Annex A). That covers AutoMobile's
 * 1080p/60 Android preset while keeping the SDP offer truthful.
 * https://www.rfc-editor.org/rfc/rfc6184.html#section-8.2.2
 */
export const WEBRTC_H264_PROFILE_LEVEL_ID = "42e02a";
export const WEBRTC_H264_LEVEL_IDC = 0x2a;
export const WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME = 8_192;

/** Return the number of 16x16 H.264 macroblocks needed for a frame. */
export function h264MacroblocksPerFrame(width: number, height: number): number {
  return Math.ceil(width / 16) * Math.ceil(height / 16);
}

/** Read `level_idc` from an SPS NAL unit, if it contains the fixed SPS prefix. */
export function h264SpsProfileLevelId(nal: Buffer): string | undefined {
  // nal[0] is the NAL header; profile_idc, constraint flags, and level_idc
  // immediately follow it in an SPS RBSP (H.264 §7.3.2.1.1).
  return nal.length >= 4 && (nal[0] & 0x1f) === 7
    ? nal.subarray(1, 4).toString("hex")
    : undefined;
}

/** Return the level_idc byte from an SPS NAL unit. */
export function h264SpsLevelIdc(nal: Buffer): number | undefined {
  const profileLevelId = h264SpsProfileLevelId(nal);
  return profileLevelId ? Number.parseInt(profileLevelId.slice(4, 6), 16) : undefined;
}

/** Whether a profile-level-id is compatible with AutoMobile constrained baseline. */
export function isCompatibleConstrainedBaselineProfile(profileLevelId: string): boolean {
  // RFC 6184 §8.2.2 permits constraint_set3_flag (bit 4) to vary with the
  // level for Baseline/Main/Extended profiles; the remaining profile fields
  // must be symmetric.
  const profileIdc = Number.parseInt(profileLevelId.slice(0, 2), 16);
  const profileIop = Number.parseInt(profileLevelId.slice(2, 4), 16);
  return profileIdc === 0x42 && (profileIop & 0xef) === 0xe0;
}
