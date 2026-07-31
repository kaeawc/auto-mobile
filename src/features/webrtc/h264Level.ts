/**
 * The Main-profile level advertised by AutoMobile's WebRTC sender.
 *
 * `4d002a`: profile_idc `0x4d` (Main, 77), profile-iop `0x00` (Main sets no
 * constraint flags), level_idc `0x2a` (Level 4.2). Main enables CABAC over
 * Baseline's CAVLC for ~10-30% bitrate savings at equal quality with no added
 * latency (no B-frames requested), and both decode targets — werift and
 * Chromium — support it.
 *
 * Level 4.2 supports 8,192 macroblocks per picture and 522,240 macroblocks
 * per second (RFC 6184 §8.2.2 and ITU-T H.264 Annex A). That covers AutoMobile's
 * 1080p/60 Android preset while keeping the SDP offer truthful.
 * https://www.rfc-editor.org/rfc/rfc6184.html#section-8.2.2
 */
export const WEBRTC_H264_PROFILE_LEVEL_ID = "4d002a";
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

/** Whether a profile-level-id is compatible with AutoMobile's Main-profile sender. */
export function isCompatibleMainProfile(profileLevelId: string): boolean {
  // Accept the whole Main family (profile_idc 77 / 0x4d), regardless of the
  // profile-iop constraint flags. AutoMobile's encoder now requests Main
  // (`4d xx yy`); a device encoder may echo varying constraint-flag bytes, all
  // of which decode identically for a screen-capture stream. Only profile_idc is
  // significant here because reconnecting cannot change a fixed-profile encoder —
  // an over-strict iop check turns into an endless reconnect loop that never
  // renders a frame.
  //
  // Baseline (0x42) is deliberately rejected now that we send Main: a decoder
  // that only advertises Baseline cannot decode a Main-profile stream. Higher
  // profiles (High 0x64) genuinely differ and are handled by the caller.
  // https://www.rfc-editor.org/rfc/rfc6184.html#section-8.2.2
  const profileIdc = Number.parseInt(profileLevelId.slice(0, 2), 16);
  return profileIdc === 0x4d;
}
