import { describe, expect, test } from "bun:test";
import type { RTCPeerConnection } from "werift";
import {
  evaluateH264SpsForSend,
  h264ProfileLevelId,
  h264SpsLevelIdc,
  h264SpsProfileLevelId,
  isCompatibleConstrainedBaselineProfile,
  isCompatibleMainProfile,
  isCompatibleProfileForSession,
  WEBRTC_H264_LEVEL_IDC,
  WEBRTC_H264_MAIN_PROFILE_LEVEL_ID,
  WEBRTC_H264_PROFILE_LEVEL_ID,
  type H264Profile,
} from "../../../src/features/webrtc/h264Level";
import { WebRtcPublisher } from "../../../src/features/webrtc/WebRtcPublisher";
import type { WhipClient } from "../../../src/features/webrtc/WhipClient";

/**
 * Cross-source H.264 profile-negotiation guard (issues #4884, #4756).
 *
 * PR #4877 GLOBALLY switched the advertised profile / acceptance gate to Main
 * and made the gate REJECT Baseline (`0x42`) for every source. But the sources
 * do not share one profile: after #4756 the Android MediaCodec encoder emits
 * **Main** (`0x4d`), while the iOS ffmpeg path (`-profile:v baseline`) and the
 * synthetic MediaMTX test frames (`libx264 -profile:v baseline`) still emit
 * **Baseline** (`0x42`). #4877's global switch broke the two Baseline sources'
 * WHIP publish and was only caught by a merge-only integration job, so it merged
 * green and had to be reverted (#4883).
 *
 * The durable fix is PER-SOURCE: each session negotiates the profile its source
 * encodes, the publisher advertises that `profile-level-id`, and the runtime gate
 * validates the SPS against THAT profile — never a global one. This test is fast,
 * deterministic, and runs on every PR via `bun test`. It pins BOTH profiles: a
 * Main source validates Main and a Baseline source validates Baseline, and
 * neither session accepts the other's profile (no accept-all union).
 */

/**
 * The exact H.264 profile each real capture source emits, captured as a 4-byte
 * SPS NAL: [nal header 0x67, profile_idc, profile-iop/constraint flags,
 * level_idc]. `profile_idc` (byte 1) is what the acceptance gate keys on; the
 * constraint byte is representative of what each encoder writes.
 *
 * These constants are the ground truth against which the gate is validated: they
 * must NOT be derived from the advertised `profile-level-id` constants, otherwise
 * a global switch of both the offer and this table would hide a real-source
 * regression.
 */
interface RealH264Source {
  readonly name: string;
  /** Where the encoder profile is configured, for failure triage. */
  readonly origin: string;
  /** The profile this source's WHIP session negotiates. */
  readonly profile: H264Profile;
  /** Expected advertised profile-level-id in the SDP offer for this source. */
  readonly advertisedProfileLevelId: string;
  /** The profile_idc byte the source's SPS carries. */
  readonly profileIdc: number;
  /** A representative SPS NAL the source's encoder emits. */
  readonly sps: Buffer;
}

const BASELINE_PROFILE_IDC = 0x42;
const MAIN_PROFILE_IDC = 0x4d;

const REAL_H264_SOURCES: readonly RealH264Source[] = [
  {
    name: "Android MediaCodec (AVCProfileMain, #4756)",
    origin: "android/video-server/.../VideoEncoder.kt (H264EncoderProfile)",
    profile: "main",
    advertisedProfileLevelId: WEBRTC_H264_MAIN_PROFILE_LEVEL_ID,
    profileIdc: MAIN_PROFILE_IDC,
    // Main (profile_idc 0x4d, profile-iop 0x00) at the advertised Level 4.2.
    sps: Buffer.from([0x67, 0x4d, 0x00, 0x2a]),
  },
  {
    name: "iOS ffmpeg (-profile:v baseline -level:v 4.2)",
    origin: "src/features/webrtc/IosH264Source.ts",
    profile: "constrained-baseline",
    advertisedProfileLevelId: WEBRTC_H264_PROFILE_LEVEL_ID,
    profileIdc: BASELINE_PROFILE_IDC,
    // VideoToolbox/ffmpeg baseline at the advertised Level 4.2 ceiling.
    sps: Buffer.from([0x67, 0x42, 0xc0, 0x2a]),
  },
  {
    name: "Synthetic MediaMTX frames (libx264 -profile:v baseline -level:v 3.1)",
    origin: "test/integration/mediamtxWebRtcPublisher.integration.test.ts",
    profile: "constrained-baseline",
    advertisedProfileLevelId: WEBRTC_H264_PROFILE_LEVEL_ID,
    profileIdc: BASELINE_PROFILE_IDC,
    sps: Buffer.from([0x67, 0x42, 0xc0, 0x1f]),
  },
] as const;

describe("H.264 cross-source profile negotiation (#4884, #4756)", () => {
  test("Baseline sources advertise Baseline; the Main source advertises Main", () => {
    // The offer we send viewers must advertise the same profile family the
    // session's source encodes; otherwise a viewer negotiates a profile it will
    // never actually receive. #4877 advertised Main for sources that stayed
    // Baseline.
    expect(Number.parseInt(WEBRTC_H264_PROFILE_LEVEL_ID.slice(0, 2), 16)).toBe(
      BASELINE_PROFILE_IDC,
    );
    expect(Number.parseInt(WEBRTC_H264_MAIN_PROFILE_LEVEL_ID.slice(0, 2), 16)).toBe(
      MAIN_PROFILE_IDC,
    );
    expect(h264ProfileLevelId("constrained-baseline")).toBe(WEBRTC_H264_PROFILE_LEVEL_ID);
    expect(h264ProfileLevelId("main")).toBe(WEBRTC_H264_MAIN_PROFILE_LEVEL_ID);
  });

  for (const source of REAL_H264_SOURCES) {
    describe(source.name, () => {
      test("emits its declared profile at or below the negotiated level", () => {
        const profileLevelId = h264SpsProfileLevelId(source.sps);
        expect(profileLevelId).toBeDefined();
        expect(Number.parseInt(profileLevelId!.slice(0, 2), 16)).toBe(source.profileIdc);
        // Its encoded level must not exceed the negotiated ceiling, or onSps rejects it.
        expect(h264SpsLevelIdc(source.sps)!).toBeLessThanOrEqual(WEBRTC_H264_LEVEL_IDC);
      });

      test("the per-session gate accepts the SPS it produces", () => {
        // Direct guard: the session's negotiated profile accepts this source's
        // profile. A global switch that rejects a real source's profile fails
        // here on PR CI — the durable fix for the #4877 incident.
        const profileLevelId = h264SpsProfileLevelId(source.sps)!;
        expect(isCompatibleProfileForSession(profileLevelId, source.profile)).toBe(true);
      });

      test("runtime send guard (onSps) accepts the SPS under its negotiated profile", () => {
        // evaluateH264SpsForSend is the exact function WebRtcPublisher.onSps
        // delegates to; it is called with the session's negotiated profile.
        expect(evaluateH264SpsForSend(source.sps, source.profile)).toEqual({ compatible: true });
      });

      test("publisher negotiates and connects for this source's advertised profile", async () => {
        // End-to-end SDP leg: a WHEP answer echoing this session's advertised
        // profile must be accepted so the publisher reaches `connected`. Exercises
        // the acceptsLocalH264Send negotiation path for this source's profile.
        const pc = new NegotiationFakePeerConnection();
        const answerSdp = [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 102",
          "a=recvonly",
          "a=rtpmap:102 H264/90000",
          `a=fmtp:102 packetization-mode=1;profile-level-id=${source.advertisedProfileLevelId}`,
        ].join("\r\n");
        const publisher = new WebRtcPublisher(
          {
            streamId: "s",
            whipEndpoint: "https://coord/whip",
            maxReconnectAttempts: 1,
            h264Profile: source.profile,
          },
          {
            createPeerConnection: () => pc as unknown as RTCPeerConnection,
            createWhipClient: () =>
              ({
                publish: async () => ({ answerSdp, resourceUrl: "https://coord/whip/s" }),
                delete: async () => {},
              }) as unknown as WhipClient,
          },
        );

        await publisher.start();
        expect(publisher.getState()).toBe("connected");
        await publisher.stop();
      });
    });
  }

  test("a session never accepts a foreign profile (no global accept-all union)", () => {
    // The #4877 failure mode was a union that let one profile be accepted where a
    // different one was negotiated. Prove each session rejects the other's SPS.
    const baselineSps = Buffer.from([0x67, 0x42, 0xc0, 0x1f]);
    const mainSps = Buffer.from([0x67, 0x4d, 0x00, 0x2a]);

    // A Baseline session rejects a Main SPS...
    expect(evaluateH264SpsForSend(mainSps, "constrained-baseline").compatible).toBe(false);
    // ...and a Main session rejects a Baseline SPS.
    expect(evaluateH264SpsForSend(baselineSps, "main").compatible).toBe(false);

    // High (0x64) is emitted by no source and rejected by both sessions.
    const highSps = Buffer.from([0x67, 0x64, 0x00, 0x1f]);
    expect(evaluateH264SpsForSend(highSps, "constrained-baseline").compatible).toBe(false);
    expect(evaluateH264SpsForSend(highSps, "main").compatible).toBe(false);
  });

  test("profile predicates are discriminating, not accept-all", () => {
    expect(isCompatibleConstrainedBaselineProfile("42e02a")).toBe(true);
    expect(isCompatibleConstrainedBaselineProfile("4d002a")).toBe(false);
    expect(isCompatibleMainProfile("4d002a")).toBe(true);
    expect(isCompatibleMainProfile("42e02a")).toBe(false);
    expect(isCompatibleMainProfile("64001f")).toBe(false);
  });
});

/** Minimal fake peer connection whose offer/publish path succeeds up to connect. */
class NegotiationFakePeerConnection {
  closed = false;
  connectionState = "new";
  iceGatheringState = "complete";
  connectionStateChange = { subscribe: () => {} };
  iceGatheringStateChange = { watch: async () => {} };
  localDescription = { sdp: "v=0" };
  addTransceiver() {
    return {
      sender: {
        ssrc: 1,
        onPictureLossIndication: { subscribe: () => {} },
      },
    };
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async close() {
    this.closed = true;
  }
}
