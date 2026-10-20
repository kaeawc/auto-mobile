import type { PersistentEncoderH264SourceOptions } from "./persistentEncoderProtocol";
import { logger } from "../../utils/logger";
import {
  buildHandshakeFrame,
  isSafeSessionToken,
  type StreamSocket,
  VIDEO_SERVER_HANDSHAKE_VERSION,
  type VideoServerSession,
} from "./persistentEncoderProtocol";
import { VIDEO_SERVER_REMOTE_JAR_PATH } from "./VideoServerJarDeployment";
import { SAFE_SOCKET_NAME_PATTERN, VIDEO_SERVER_MAIN_CLASS } from "./VideoServerLeases";
interface PersistentEncoderSessionContext {
  session: VideoServerSession | null;
  forwardedPort: number | null;
  options: PersistentEncoderH264SourceOptions;
  sessionTokenFactory: () => string;
  socketNameFactory: () => string;
  negotiatedHandshakeVersion: number | null;
}

export function buildServerArgs(
  context: Pick<PersistentEncoderSessionContext, "session" | "forwardedPort" | "options">,
): string[] {
  const session = context.session;
  if (!session || context.forwardedPort === null) {
    throw new Error("Video server session was not initialized.");
  }
  const args = [
    "shell",
    `CLASSPATH=${VIDEO_SERVER_REMOTE_JAR_PATH}`,
    "app_process",
    "/",
    VIDEO_SERVER_MAIN_CLASS,
    "--quality",
    context.options.quality ?? "medium",
    "--socket-name",
    session.socketName,
    "--session-token",
    session.token,
    "--owner-pid",
    String(session.ownerPid),
    "--device-serial",
    session.deviceSerial,
    "--forward-port",
    String(context.forwardedPort),
  ];
  if (context.options.bitrateBps && context.options.bitrateBps > 0) {
    args.push("--bit-rate", String(Math.round(context.options.bitrateBps)));
  }
  if (Number.isInteger(context.options.fps) && (context.options.fps as number) > 0) {
    args.push("--fps", String(context.options.fps));
  }
  if (context.options.size) {
    args.push("--size", `${context.options.size.width}x${context.options.size.height}`);
  }
  if (context.options.audioEnabled) {
    args.push("--audio");
  }
  return args;
}

export function createSession(
  context: Pick<
    PersistentEncoderSessionContext,
    "sessionTokenFactory" | "socketNameFactory" | "options"
  >,
): VideoServerSession {
  const token = context.sessionTokenFactory();
  if (!isSafeSessionToken(token)) {
    throw new Error("Video server session token factory returned an unsafe token.");
  }
  const socketName = context.socketNameFactory();
  if (!SAFE_SOCKET_NAME_PATTERN.test(socketName)) {
    throw new Error("Video server socket-name factory returned an unsafe socket name.");
  }
  return {
    token,
    socketName,
    ownerPid: process.pid,
    deviceSerial: context.options.device.deviceId,
  };
}

/**
 * Reconcile the device-advertised handshake version with the version this
 * client speaks (issue #4729). A `null` advertisement (pre-handshake device)
 * yields `null` — the client will skip the handshake and stream anyway
 * (graceful degrade). An advertised version this client does not support is
 * clamped down to the client's version when the client is newer, or accepted
 * as-is; the on-wire VERSION byte lets the server reject a frame it cannot
 * parse with an actionable reason rather than a resync storm.
 */
export function resolveHandshakeVersion(advertised: number | null): number | null {
  if (advertised === null) {
    logger.warn(
      "[PersistentEncoderH264Source] device advertised no handshake protocol; " +
        "streaming without a token handshake (defense-in-depth degraded, UID gating still applies)",
    );
    return null;
  }
  return Math.min(advertised, VIDEO_SERVER_HANDSHAKE_VERSION);
}

/**
 * Send the pre-stream token handshake as the FIRST bytes on a freshly-connected
 * socket, before the server emits (or the client reads) any stream header (issue
 * #4729). Skipped when the device advertised no handshake support
 * ({@link negotiatedHandshakeVersion} is `null`), so a new host degrades
 * gracefully against a pre-handshake device instead of hard-breaking the stream.
 * Called on every accept — the initial connect and each socket reconnect — because
 * the server requires the handshake on every `accept()`.
 */
export function sendHandshake(
  context: Pick<PersistentEncoderSessionContext, "session" | "negotiatedHandshakeVersion">,
  socket: StreamSocket,
): void {
  const session = context.session;
  const version = context.negotiatedHandshakeVersion;
  if (!session || version === null) {
    return;
  }
  try {
    socket.write(buildHandshakeFrame(session.token, version));
  } catch (error) {
    // A write failure on a just-connected socket surfaces via its own error/close
    // handler wired immediately after; do not double-report here.
    logger.debug(`[PersistentEncoderH264Source] handshake write failed: ${error}`);
  }
}
