import type { PublisherPeerConnection } from "./PublisherPeerConnection";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  h264ProfileLevelId,
  isCompatibleProfileForSession,
  WEBRTC_H264_LEVEL_IDC,
  type H264Profile,
} from "./h264Level";
import { type WhipSignalingClient } from "./WhipClient";

export function assertWhipAnswerAcceptsMedia(
  answerSdp: string,
  kind: "audio" | "video",
  codec: "h264" | "pcmu",
  profile: H264Profile,
): void {
  const section = findSdpMediaSection(answerSdp, kind);
  if (!section) {
    throw new Error(`WHIP answer did not include a ${kind} m-line.`);
  }

  const { mediaLine, attributeLines, sessionDirection } = section;
  const mediaParts = mediaLine.split(/\s+/);
  const port = Number(mediaParts[1]);
  const formats = new Set(mediaParts.slice(3));
  if (!Number.isFinite(port) || port === 0) {
    throw new Error(`WHIP answer rejected the requested ${kind} m-line.`);
  }

  const direction =
    attributeLines
      .map((line) => line.match(/^a=(sendrecv|sendonly|recvonly|inactive)$/)?.[1])
      .find(
        (value): value is "sendrecv" | "sendonly" | "recvonly" | "inactive" => value !== undefined,
      ) ??
    sessionDirection ??
    "sendrecv";
  // WHIP is unidirectional ingest: an accepting endpoint MUST answer recvonly
  // (RFC 9725 §4.2). Accepting sendrecv would make AutoMobile interoperate with
  // a non-conforming endpoint and hide an invalid session contract.
  if (direction !== "recvonly") {
    throw new Error(`WHIP answer did not accept receiving ${kind} (direction=${direction}).`);
  }

  const staticPayloadType = codec === "pcmu" ? "0" : undefined;
  const accepted =
    (staticPayloadType !== undefined && formats.has(staticPayloadType)) ||
    attributeLines.some((line) =>
      isAcceptedCodecRtpMap(line, formats, codec, attributeLines, profile),
    );
  if (!accepted) {
    throw new Error(`WHIP answer did not accept ${codec.toUpperCase()} ${kind}.`);
  }
}

function findSdpMediaSection(
  sdp: string,
  kind: "audio" | "video",
): {
  mediaLine: string;
  attributeLines: string[];
  sessionDirection?: "sendrecv" | "sendonly" | "recvonly" | "inactive";
} | null {
  const lines = sdp
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstMedia = lines.findIndex((line) => line.startsWith("m="));
  const sessionDirection = lines
    .slice(0, firstMedia < 0 ? lines.length : firstMedia)
    .map((line) => line.match(/^a=(sendrecv|sendonly|recvonly|inactive)$/)?.[1])
    .find(
      (value): value is "sendrecv" | "sendonly" | "recvonly" | "inactive" => value !== undefined,
    );
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].startsWith(`m=${kind} `)) {
      continue;
    }
    const attributeLines: string[] = [];
    for (let sectionIndex = index + 1; sectionIndex < lines.length; sectionIndex++) {
      if (lines[sectionIndex].startsWith("m=")) {
        break;
      }
      attributeLines.push(lines[sectionIndex]);
    }
    return { mediaLine: lines[index], attributeLines, sessionDirection };
  }
  return null;
}

function isAcceptedCodecRtpMap(
  line: string,
  formats: Set<string>,
  codec: string,
  attributeLines: string[],
  profile: H264Profile,
): boolean {
  const match = line.match(/^a=rtpmap:(\S+)\s+([^/\s]+)\/(\d+)/i);
  if (!match || !formats.has(match[1]) || match[2].toLowerCase() !== codec) {
    return false;
  }
  if (codec !== "h264") {
    return true;
  }
  // AutoMobile packetizes H.264 at the RFC 6184 fixed 90 kHz clock rate and
  // uses FU-A, which requires packetization-mode=1. The local werift codec's
  // profile is this session's `profile` (Baseline 42e0xx or Main 4d00xx); level
  // may differ when asymmetry is negotiated.
  return (
    match[3] === "90000" &&
    attributeLines.some((fmtp) => {
      if (!fmtp.startsWith(`a=fmtp:${match[1]} `)) {
        return false;
      }
      const parameters = fmtp.slice(fmtp.indexOf(" ") + 1);
      const packetizationMode = /(?:^|;)\s*packetization-mode\s*=\s*1(?:;|$)/i.test(parameters);
      const profileLevelId = /(?:^|;)\s*profile-level-id\s*=\s*([0-9a-f]{6})(?:;|$)/i.exec(
        parameters,
      )?.[1];
      return (
        packetizationMode &&
        profileLevelId !== undefined &&
        acceptsLocalH264Send(parameters, profileLevelId, profile)
      );
    })
  );
}

export function h264CodecParameters(profile: H264Profile): string {
  return `profile-level-id=${h264ProfileLevelId(profile)};packetization-mode=1;level-asymmetry-allowed=1`;
}

function acceptsLocalH264Send(
  parameters: string,
  profileLevelId: string,
  profile: H264Profile,
): boolean {
  if (!isCompatibleProfileForSession(profileLevelId, profile)) {
    return false;
  }
  const answerLevelIdc = Number.parseInt(profileLevelId.slice(4, 6), 16);
  if (answerLevelIdc >= WEBRTC_H264_LEVEL_IDC) {
    return true;
  }
  // With level asymmetry, the answer's profile-level-id describes its sending
  // level; max-recv-level is its separately advertised receive ceiling (RFC
  // 6184 §8.2.2). Do not send a Level 4.2 stream unless that ceiling permits it.
  const asymmetric = /(?:^|;)\s*level-asymmetry-allowed\s*=\s*1(?:;|$)/i.test(parameters);
  const maxReceiveLevel = /(?:^|;)\s*max-recv-level\s*=\s*([0-9a-f]{4})(?:;|$)/i.exec(
    parameters,
  )?.[1];
  // RFC 6184 §8.2.2 encodes max-recv-level as the two hexadecimal bytes after
  // profile_idc in an SPS: profile-iop followed by level_idc (for example,
  // e02a for constrained-baseline Level 4.2). It is not a decimal level number.
  const maxReceiveLevelIdc = maxReceiveLevel
    ? Number.parseInt(maxReceiveLevel.slice(2), 16)
    : Number.NaN;
  return asymmetric && maxReceiveLevelIdc >= WEBRTC_H264_LEVEL_IDC;
}

export function addWhipRtcpMuxOnly(sdp: string): string {
  return sdp.replace(/a=rtcp-mux\r?\n/g, (match) => `${match}a=rtcp-mux-only\r\n`);
}
export async function closeCancelledWhipSession(
  pc: PublisherPeerConnection,
  whip: WhipSignalingClient,
  resourceUrl: string | null,
): Promise<never> {
  if (resourceUrl) {
    await whip.delete(resourceUrl).catch((error) => {
      logger.warn(
        `[WebRtcPublisher] Cancelled WHIP session cleanup failed: ${errorMessage(error)}`,
      );
    });
  }
  await pc.close().catch((error) => {
    logger.warn(`[WebRtcPublisher] Cancelled peer cleanup rejected: ${errorMessage(error)}`);
  });
  throw new Error("Publisher closed during establish.");
}
