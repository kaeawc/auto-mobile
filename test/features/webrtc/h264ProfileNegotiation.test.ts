import { describe, expect, test } from "bun:test";
import type { RTCPeerConnection } from "werift";
import {
  evaluateH264SpsForSend,
  h264SpsLevelIdc,
  h264SpsProfileLevelId,
  isCompatibleConstrainedBaselineProfile,
  WEBRTC_H264_LEVEL_IDC,
  WEBRTC_H264_PROFILE_LEVEL_ID,
} from "../../../src/features/webrtc/h264Level";
import { WebRtcPublisher } from "../../../src/features/webrtc/WebRtcPublisher";
import type { WhipClient } from "../../../src/features/webrtc/WhipClient";

/**
 * Cross-source H.264 profile-negotiation guard (issue #4884).
 *
 * PR #4877 globally switched the advertised profile / acceptance gate to Main
 * and made the gate REJECT Baseline (`0x42`). But every real capture source
 * still emits Baseline: Android MediaCodec is configured with
 * `AVCProfileBaseline`, the iOS ffmpeg path passes `-profile:v baseline`, and
 * the synthetic MediaMTX test frames use `libx264 -profile:v baseline`. That
 * mismatch broke WebRtcPublisher -> MediaMTX and was only caught by a
 * merge-only integration job, so #4877 merged green and had to be reverted
 * (#4883).
 *
 * This test is fast, deterministic, and runs on every PR via `bun test`. It
 * asserts that BOTH the advertised offer (`WEBRTC_H264_PROFILE_LEVEL_ID`) and
 * the runtime acceptance gate accept the exact SPS each real source produces. A
 * future global-profile switch that rejects a profile a real source emits must
 * fail here on PR CI, before it can reach `main`.
 */

/**
 * The exact H.264 profile each real capture source emits, captured as a 4-byte
 * SPS NAL: [nal header 0x67, profile_idc, profile-iop/constraint flags,
 * level_idc]. Only `profile_idc` (byte 1) is load-bearing for the acceptance
 * gate; the constraint byte is representative of what each encoder writes.
 *
 * profile_idc 0x42 == Baseline (profile 66). These constants are the ground
 * truth against which the gate is validated: they must NOT be derived from
 * `WEBRTC_H264_PROFILE_LEVEL_ID`, otherwise a global switch of both the offer
 * and this table would hide a real-source regression.
 */
interface RealH264Source {
  readonly name: string;
  /** Where the encoder profile is configured, for failure triage. */
  readonly origin: string;
  /** A representative SPS NAL the source's encoder emits. */
  readonly sps: Buffer;
}

const REAL_H264_SOURCES: readonly RealH264Source[] = [
  {
    name: "Android MediaCodec (AVCProfileBaseline)",
    origin: "android/video-server/.../VideoEncoder.kt",
    // Plain Baseline as Android device encoders routinely emit it
    // (constraint_set0 only, constraint_set1 clear), level 4.0. This is the
    // representation #4877's gate rejected outright.
    sps: Buffer.from([0x67, 0x42, 0x80, 0x28]),
  },
  {
    name: "iOS ffmpeg (-profile:v baseline -level:v 4.2)",
    origin: "src/features/webrtc/IosH264Source.ts",
    // VideoToolbox/ffmpeg baseline at the advertised Level 4.2 ceiling.
    sps: Buffer.from([0x67, 0x42, 0xc0, 0x2a]),
  },
  {
    name: "Synthetic MediaMTX frames (libx264 -profile:v baseline -level:v 3.1)",
    origin: "test/integration/mediamtxWebRtcPublisher.integration.test.ts",
    sps: Buffer.from([0x67, 0x42, 0xc0, 0x1f]),
  },
] as const;

/** Baseline profile_idc; the family every real source encodes and every viewer must decode. */
const BASELINE_PROFILE_IDC = 0x42;

describe("H.264 cross-source profile negotiation (#4884)", () => {
  test("the advertised offer profile is itself Baseline and gate-compatible", () => {
    // The offer we send viewers must advertise the same profile family our
    // sources encode; otherwise a viewer negotiates a profile it will never
    // actually receive. #4877 advertised Main here while sources stayed Baseline.
    const offerProfileIdc = Number.parseInt(WEBRTC_H264_PROFILE_LEVEL_ID.slice(0, 2), 16);
    expect(offerProfileIdc).toBe(BASELINE_PROFILE_IDC);
    expect(isCompatibleConstrainedBaselineProfile(WEBRTC_H264_PROFILE_LEVEL_ID)).toBe(true);
  });

  for (const source of REAL_H264_SOURCES) {
    describe(source.name, () => {
      test("emits a Baseline SPS (documents ground truth)", () => {
        const profileLevelId = h264SpsProfileLevelId(source.sps);
        expect(profileLevelId).toBeDefined();
        const profileIdc = Number.parseInt(profileLevelId!.slice(0, 2), 16);
        expect(profileIdc).toBe(BASELINE_PROFILE_IDC);
        // Its encoded level must not exceed the negotiated ceiling, or onSps rejects it.
        expect(h264SpsLevelIdc(source.sps)!).toBeLessThanOrEqual(WEBRTC_H264_LEVEL_IDC);
      });

      test("acceptance gate accepts the SPS it produces", () => {
        // Direct guard: if a global switch makes the gate reject Baseline, this
        // fails on PR CI — the durable fix for the #4877 incident.
        const profileLevelId = h264SpsProfileLevelId(source.sps)!;
        expect(isCompatibleConstrainedBaselineProfile(profileLevelId)).toBe(true);
      });

      test("runtime send guard (onSps) accepts the SPS it produces", () => {
        // evaluateH264SpsForSend is the exact function WebRtcPublisher.onSps
        // delegates to, so this exercises the runtime acceptance decision that
        // #4877 turned into a fatal throw for Baseline sources.
        expect(evaluateH264SpsForSend(source.sps)).toEqual({ compatible: true });
      });

      test("publisher negotiates and connects for this source's advertised profile", async () => {
        // End-to-end SDP leg: a WHEP answer echoing our offer profile must be
        // accepted so the publisher reaches `connected`. Exercises the
        // acceptsLocalH264Send / sdpOffersCompatibleH264 negotiation path.
        const pc = new NegotiationFakePeerConnection();
        const answerSdp = [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 102",
          "a=recvonly",
          "a=rtpmap:102 H264/90000",
          `a=fmtp:102 packetization-mode=1;profile-level-id=${WEBRTC_H264_PROFILE_LEVEL_ID}`,
        ].join("\r\n");
        const publisher = new WebRtcPublisher(
          { streamId: "s", whipEndpoint: "https://coord/whip", maxReconnectAttempts: 1 },
          {
            createPeerConnection: () => pc as unknown as RTCPeerConnection,
            createWhipClient: () =>
              ({
                publish: async () => ({ answerSdp, resourceUrl: "https://coord/whip/s" }),
                delete: async () => {},
              }) as unknown as WhipClient,
          }
        );

        await publisher.start();
        expect(publisher.getState()).toBe("connected");
        await publisher.stop();
      });
    });
  }

  test("gate still rejects a genuinely different profile a source never emits", () => {
    // Negative control: proves the gate is discriminating, not accept-all. Main
    // (0x4d) and High (0x64) SPS are rejected because no AutoMobile source emits
    // them; if a source ever did, its entry above would fail first.
    const mainProfileSps = Buffer.from([0x67, 0x4d, 0x40, 0x1f]);
    const highProfileSps = Buffer.from([0x67, 0x64, 0x00, 0x1f]);
    expect(evaluateH264SpsForSend(mainProfileSps).compatible).toBe(false);
    expect(evaluateH264SpsForSend(highProfileSps).compatible).toBe(false);
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
