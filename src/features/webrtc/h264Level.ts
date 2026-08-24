/**
 * The H.264 profiles AutoMobile's WebRTC sender negotiates, per capture source.
 *
 * WebRTC negotiates exactly ONE `profile-level-id` per WHIP session, so the
 * advertised profile and the SPS-acceptance gate must depend on WHICH source
 * feeds that session — they are NOT global:
 *
 *  - The Android `video-server` MediaCodec encoder emits **Main** (`4d002a`).
 *    Main saves ~10-30% bitrate at equal quality (CABAC, no B-frames, no added
 *    latency) and both werift and Chromium decode it.
 *  - The iOS ffmpeg source and the synthetic MediaMTX test source emit
 *    **Constrained Baseline** (`42e02a`) and must keep negotiating Baseline.
 *
 * A GLOBAL Main switch is exactly the #4877 regression: it made this gate reject
 * the Baseline SPS that the iOS and synthetic sources still produce, breaking the
 * merge-only MediaMTX publisher integration test. The gate here is therefore
 * always evaluated against the session's negotiated {@link H264Profile}, never a
 * single global assumption.
 *
 * Level 4.2 supports 8,192 macroblocks per picture and 522,240 macroblocks per
 * second (RFC 6184 §8.2.2 and ITU-T H.264 Annex A). That covers AutoMobile's
 * 1080p/60 preset for both profiles while keeping the SDP offer truthful.
 * https://www.rfc-editor.org/rfc/rfc6184.html#section-8.2.2
 */

/** Which H.264 profile a capture source encodes and its WHIP session negotiates. */
export type H264Profile = "constrained-baseline" | "main";

/** The profile a session negotiates when a source does not declare one. */
export const DEFAULT_H264_PROFILE: H264Profile = "constrained-baseline";

/** Constrained Baseline (profile_idc 0x42), Level 4.2 — iOS ffmpeg + synthetic sources. */
export const WEBRTC_H264_PROFILE_LEVEL_ID = "42e02a";
/** Main (profile_idc 0x4d, profile-iop 0x00), Level 4.2 — Android MediaCodec source. */
export const WEBRTC_H264_MAIN_PROFILE_LEVEL_ID = "4d002a";
export const WEBRTC_H264_LEVEL_IDC = 0x2a;
export const WEBRTC_H264_MAX_MACROBLOCKS_PER_FRAME = 8_192;

/** The `profile-level-id` AutoMobile advertises in the SDP offer for `profile`. */
export function h264ProfileLevelId(profile: H264Profile): string {
  return profile === "main" ? WEBRTC_H264_MAIN_PROFILE_LEVEL_ID : WEBRTC_H264_PROFILE_LEVEL_ID;
}

/** Return the number of 16x16 H.264 macroblocks needed for a frame. */
export function h264MacroblocksPerFrame(width: number, height: number): number {
  return Math.ceil(width / 16) * Math.ceil(height / 16);
}

/** Read `level_idc` from an SPS NAL unit, if it contains the fixed SPS prefix. */
export function h264SpsProfileLevelId(nal: Buffer): string | undefined {
  // nal[0] is the NAL header; profile_idc, constraint flags, and level_idc
  // immediately follow it in an SPS RBSP (H.264 §7.3.2.1.1).
  return nal.length >= 4 && (nal[0] & 0x1f) === 7 ? nal.subarray(1, 4).toString("hex") : undefined;
}

/** Return the level_idc byte from an SPS NAL unit. */
export function h264SpsLevelIdc(nal: Buffer): number | undefined {
  const profileLevelId = h264SpsProfileLevelId(nal);
  return profileLevelId ? Number.parseInt(profileLevelId.slice(4, 6), 16) : undefined;
}

/** Result of validating an encoded SPS against the negotiated send profile. */
export interface H264SpsSendCompatibility {
  /** Whether the SPS may be sent over the negotiated track. */
  compatible: boolean;
  /** Human-readable reason when `compatible` is false; omitted when compatible. */
  reason?: string;
}

/**
 * Decide whether an encoded SPS NAL from a capture source may be sent on the
 * WHIP track, given the {@link H264Profile} AutoMobile negotiated for THAT
 * session and the level it advertises.
 *
 * This is the single source of truth for the runtime acceptance gate: the
 * publisher's `onSps` hook delegates here so the decision cannot drift between
 * the real send path and the fast profile-negotiation test. Validation is
 * per-source — a Main session accepts a Main SPS, a Baseline session accepts a
 * Baseline SPS — so no profile a real source emits is ever globally rejected.
 * A global rejection of Baseline is exactly the #4877 regression (a Main-only
 * switch broke the iOS ffmpeg and synthetic sources that still emit Baseline).
 */
export function evaluateH264SpsForSend(
  sps: Buffer,
  profile: H264Profile = DEFAULT_H264_PROFILE,
): H264SpsSendCompatibility {
  const profileLevelId = h264SpsProfileLevelId(sps);
  if (profileLevelId && !isCompatibleProfileForSession(profileLevelId, profile)) {
    return {
      compatible: false,
      reason: `H.264 SPS profile ${profileLevelId.slice(0, 4)} is incompatible with negotiated ${profile}.`,
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

/**
 * Whether `profileLevelId` matches the profile family a session negotiated.
 * Dispatches per-source so Baseline and Main are each accepted only for their
 * own session; there is no union that would let one session accept the other.
 */
export function isCompatibleProfileForSession(
  profileLevelId: string,
  profile: H264Profile,
): boolean {
  return profile === "main"
    ? isCompatibleMainProfile(profileLevelId)
    : isCompatibleConstrainedBaselineProfile(profileLevelId);
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
  // Non-Baseline profiles (Main 0x4d, High 0x64) are still rejected here — those
  // genuinely differ and are matched by their own session profile.
  // https://www.rfc-editor.org/rfc/rfc6184.html#section-8.2.2
  const profileIdc = Number.parseInt(profileLevelId.slice(0, 2), 16);
  return profileIdc === 0x42;
}

/**
 * Whether a profile-level-id is compatible with AutoMobile's Main-profile send
 * path (the Android MediaCodec source). Accepts the Main family (profile_idc 77
 * / 0x4d) regardless of constraint flags. Baseline (0x42) and High (0x64) are
 * rejected for a Main session — each source validates against its own profile,
 * so a Main session never has to accept a foreign profile. Chromium and werift
 * both decode Main, so advertising it does not narrow viewer compatibility.
 * https://www.rfc-editor.org/rfc/rfc6184.html#section-8.2.2
 */
export function isCompatibleMainProfile(profileLevelId: string): boolean {
  const profileIdc = Number.parseInt(profileLevelId.slice(0, 2), 16);
  return profileIdc === 0x4d;
}
