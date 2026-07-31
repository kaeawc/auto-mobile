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

/** Result of validating an encoded SPS against the negotiated send profile. */
export interface H264SpsSendCompatibility {
  /** Whether the SPS may be sent over the negotiated constrained-baseline track. */
  compatible: boolean;
  /** Human-readable reason when `compatible` is false; omitted when compatible. */
  reason?: string;
}

/**
 * Decide whether an encoded SPS NAL from a capture source may be sent on the
 * WHIP track, given the profile and level AutoMobile negotiates.
 *
 * This is the single source of truth for the runtime acceptance gate: the
 * publisher's `onSps` hook delegates here so the decision cannot drift between
 * the real send path and the fast profile-negotiation test. A source whose SPS
 * this function rejects will never render — that is exactly the #4877 regression
 * (a global Main-profile switch made this reject the Baseline SPS that the iOS
 * ffmpeg and synthetic sources actually emit).
 */
export function evaluateH264SpsForSend(sps: Buffer): H264SpsSendCompatibility {
  const profileLevelId = h264SpsProfileLevelId(sps);
  if (profileLevelId && !isCompatibleConstrainedBaselineProfile(profileLevelId)) {
    return {
      compatible: false,
      reason: `H.264 SPS profile ${profileLevelId.slice(0, 4)} is incompatible with negotiated constrained baseline.`,
    };
  }
  const levelIdc = h264SpsLevelIdc(sps);
  if (levelIdc !== undefined && levelIdc > WEBRTC_H264_LEVEL_IDC) {
    return {
      compatible: false,
      reason: `H.264 SPS level ${levelIdc} exceeds negotiated level ${WEBRTC_H264_LEVEL_IDC}.`,
    };
  }
  return { compatible: true };
}

/** Whether a profile-level-id is compatible with AutoMobile constrained baseline. */
export function isCompatibleConstrainedBaselineProfile(profileLevelId: string): boolean {
  // Accept the whole Baseline family (profile_idc 66 / 0x42), regardless of the
  // constraint flags. Constrained Baseline (constraint_set1_flag set) is a subset
  // of Baseline and decodes identically for a screen-capture stream; the earlier
  // `(iop & 0x4f) === 0x40` check rejected the plain-Baseline SPS that Android
  // device encoders routinely emit (`42 80 xx`, constraint_set0 only, or
  // `42 00 xx`). Because reconnecting cannot change a fixed-profile encoder, that
  // rejection turned into an endless reconnect loop that never rendered a frame.
  // Non-Baseline profiles (Main 0x4d, High 0x64) are still rejected — those
  // genuinely differ and are handled by the caller.
  // https://www.rfc-editor.org/rfc/rfc6184.html#section-8.2.2
  const profileIdc = Number.parseInt(profileLevelId.slice(0, 2), 16);
  return profileIdc === 0x42;
}
