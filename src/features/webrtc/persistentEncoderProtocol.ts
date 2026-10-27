import { connect as netConnect } from "node:net";
import { type BootedDevice } from "../../models";
import { exponentialBackoff, type BackoffInput } from "../../utils/Backoff";
import { type IdGenerator } from "../../utils/IdGenerator";
import { type Timer } from "../../utils/SystemTimer";
import { InMemoryActiveVideoSessionRegistry } from "./InMemoryActiveVideoSessionRegistry";
import type { JarIntegrityProbe } from "./VideoServerJarProvider";
import { VIDEO_SERVER_SOCKET_PREFIX } from "./VideoServerLeases";
import type { VideoSourceAdbFactory } from "./videoSourceAdb";

/**
 * Host→device command byte written back over the (bidirectional) socket to ask
 * the encoder for a fresh IDR. Keep in sync with
 * `VideoStreamProtocol.COMMAND_REQUEST_KEY_FRAME` in the Kotlin video-server.
 */
export const VIDEO_SERVER_COMMAND_REQUEST_KEY_FRAME = 0x01;

/**
 * Handshake protocol version this client speaks. The server advertises its own
 * supported version via `proto=<v>` on the readiness line; the client only sends
 * a handshake when the device advertises a version it understands. Keep in sync
 * with `VideoHandshake.PROTOCOL_VERSION` in the Kotlin video-server.
 */
export const VIDEO_SERVER_HANDSHAKE_VERSION = 1;

/**
 * Magic prefix of the pre-stream token handshake frame ("AVMH"). Keep in sync
 * with `VideoHandshake.MAGIC` in the Kotlin video-server.
 */
export const VIDEO_SERVER_HANDSHAKE_MAGIC = Buffer.from([0x41, 0x56, 0x4d, 0x48]);

/** Retry a replaced local ADB socket without tearing down the device encoder. */
export const DEFAULT_LOCAL_SOCKET_RECONNECT_WINDOW_MS = 5_000;

export const DEFAULT_LOCAL_SOCKET_RECONNECT_RETRY_MS = 100;

/**
 * Bounded time for a blocking launch-path ADB/socket call (push, forward, spawn,
 * initial connect). A wedged ADB/USB state must degrade to screenrecord, not hang
 * the stream lifecycle forever.
 */
export const DEFAULT_LAUNCH_COMMAND_TIMEOUT_MS = 20_000;

/**
 * Bounded time for a blocking teardown/cleanup ADB call. Teardown is best-effort:
 * a timeout is logged and skipped so `stop()` always settles and lease
 * reconciliation handles any orphaned device resources.
 */
export const DEFAULT_TEARDOWN_COMMAND_TIMEOUT_MS = 5_000;

/**
 * Default number of bounded, backed-off on-device server relaunch attempts made
 * across a source's lifetime before it gives up the persistent encoder and falls
 * back to screenrecord (or, when no fallback is wired, fails via `onError`). The
 * budget is cumulative — a persistently-broken device that keeps losing its
 * encoder cannot hot-loop restarts, it exhausts this budget and stops.
 */
export const DEFAULT_MAX_SERVER_RELAUNCH_ATTEMPTS = 3;

/**
 * Default backoff between post-start server relaunch attempts. Exponential so a
 * transient hiccup recovers quickly while a hard-broken device backs off before
 * the budget is spent.
 */
export const DEFAULT_SERVER_RELAUNCH_BACKOFF: BackoffInput = exponentialBackoff({
  initialDelayMs: 1_000,
  multiplier: 2,
  maxDelayMs: 8_000,
});

/**
 * Default sustained-healthy window (ms), measured on the injected {@link Timer},
 * that a (re)launched on-device server must run before a later, unrelated
 * post-start loss resets the cumulative relaunch budget instead of continuing to
 * spend it (issue #7547). Without this, a long-lived stream that hits a few
 * well-separated, individually-recovered blips over hours (codec reclaimed under
 * memory pressure, a transient `app_process` kill) is permanently demoted to
 * screenrecord by the same counter that exists to stop a hot-looping,
 * persistently-broken device. 60s is long enough that a device dying every few
 * seconds never accumulates it and still exhausts the budget — only a
 * genuinely well-separated incident resets it.
 */
export const DEFAULT_SERVER_RELAUNCH_HEALTHY_WINDOW_MS = 60_000;

/** Minimal socket surface the source needs, for injectable testing. */
export interface StreamSocket {
  on(event: "data", listener: (chunk: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
  /** Send bytes device-ward (e.g. a keyframe-request command). */
  write(chunk: Buffer): void;
  destroy(): void;
}

/** Connects to a forwarded local TCP port and resolves once connected. */
export type SocketConnector = (port: number, signal?: AbortSignal) => Promise<StreamSocket>;

export interface VideoServerSession {
  token: string;
  socketName: string;
  ownerPid: number;
  deviceSerial: string;
}

/**
 * Process-lived memory of which `automobile_video_*` abstract socket names are
 * currently owned by an in-flight or live capture session on a device.
 *
 * The orphan-forward sweep (`sweepOrphanForwards`) uses this to distinguish a
 * genuinely stranded `adb forward` — one whose device server self-expired and
 * deleted its own lease, or whose daemon was SIGKILLed — from the forward of a
 * *concurrently starting* session, which necessarily exists before that
 * session has written its lease. A session registers its socket name the moment
 * it is created (before its forward is opened) and unregisters it on teardown,
 * so any forward reachable during that write-before-lease gap is protected.
 *
 * Injected so unit tests stay isolated; the daemon uses a single process-lived
 * instance so registrations are visible across sibling sessions. A daemon crash
 * clears the in-memory instance along with the process, which is exactly
 * correct — the sessions it tracked are dead and their forwards are the orphans
 * the next `start()` should reclaim.
 */
export interface ActiveVideoSessionRegistry {
  /** Mark a session's abstract socket name as owned on a device. */
  add(deviceId: string, socketName: string): void;
  /** Clear a session's socket name once its resources are torn down. */
  remove(deviceId: string, socketName: string): void;
  /** Socket names currently owned by a live/in-flight session on the device. */
  active(deviceId: string): ReadonlySet<string>;
}

/** Shared across sibling capture sessions in the daemon process. */
export const defaultActiveVideoSessionRegistry: ActiveVideoSessionRegistry =
  new InMemoryActiveVideoSessionRegistry();

export const defaultConnector: SocketConnector = (port, signal) =>
  new Promise<StreamSocket>((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1");
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.off("connect", onConnect);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onConnect = (): void => finish(() => resolve(socket));
    const onError = (error: Error): void => finish(() => reject(error));
    const onAbort = (): void =>
      finish(() => {
        socket.destroy();
        reject(new Error("video-server socket connection aborted"));
      });

    socket.once("connect", onConnect);
    socket.once("error", onError);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export interface PersistentEncoderH264SourceOptions {
  device: BootedDevice;
  /** Called with each chunk of the raw H.264 (Annex-B) elementary stream. */
  onData: (chunk: Buffer) => void;
  /** Called for newly encoded device frames, excluding cached replay and config packets. */
  onSourceFrame?: () => void;
  /**
   * Called right after {@link onData} for every H.264 packet (config, live and
   * replayed). The device frames each encoder output as one length-delimited
   * packet, so the bytes just delivered end on an access-unit boundary: a
   * consumer that splits Annex-B can release the trailing NAL immediately
   * instead of holding it until the encoder's next output (issue #10150).
   */
  onEncodedAccessUnit?: () => void;
  /** Called with each chunk of 8 kHz mono PCM16LE audio when enabled. */
  onAudioData?: (chunk: Buffer) => void;
  /**
   * Called with the attested display rotation (0..3) each time the device emits a CONFIG packet —
   * at stream start and on every #4785 rotation-driven encoder swap (issue #4786). The live-mirror
   * relay records this so it can re-attest rotation to desktop clients.
   */
  onRotation?: (rotation: number) => void;
  /** Receives cumulative dropped frames from the on-device VideoStatsAccumulator. */
  onDroppedFrames?: (droppedFrames: number) => void;
  /** Called when the source fails fatally after a successful start. */
  onError?: (error: Error) => void;
  bitrateBps?: number;
  size?: { width: number; height: number };
  audioEnabled?: boolean;
  quality?: "low" | "medium" | "high";
  /**
   * Frame rate to request from the device encoder via `--fps`. When omitted the
   * video-server falls back to the quality preset's default (30fps). Decoupled
   * from `quality` so the host can lower the rate without also lowering
   * resolution/bitrate.
   */
  fps?: number;
  /** Local path to the built `automobile-video.jar`. Required to run. */
  jarPath: string;
  /**
   * Source of the host-known expected sha256 + size of {@link jarPath} (issue
   * #4733), used to skip a redundant push when the on-device copy already matches
   * and to verify remote integrity before `app_process` launch. Injected for
   * device-free tests; defaults to the shared {@link VideoServerJarProvider}
   * singleton, which hashes the local jar with the same canonical calculator it
   * verifies downloads with.
   */
  jarIntegrityProvider?: JarIntegrityProbe;
  adbFactory?: VideoSourceAdbFactory;
  connector?: SocketConnector;
  timer?: Timer;
  /**
   * Registry of socket names owned by live/in-flight sessions, used by the
   * orphan-forward sweep to avoid removing a concurrently-starting session's
   * forward. Defaults to a process-lived singleton shared across sessions.
   */
  activeVideoSessionRegistry?: ActiveVideoSessionRegistry;
  /** How long to wait for the server to signal readiness (ms). */
  readyTimeoutMs?: number;
  /** Bounded time for a blocking launch-path ADB/socket call (ms). */
  commandTimeoutMs?: number;
  /** Bounded time for a blocking teardown/cleanup ADB call (ms). */
  teardownTimeoutMs?: number;
  /** Bounded time to reconnect a dropped local socket before failing the source. */
  localSocketReconnectWindowMs?: number;
  /** Spacing between local socket reconnect attempts. */
  localSocketReconnectRetryMs?: number;
  /** Injectable session token source for deterministic tests. */
  sessionTokenFactory?: () => string;
  /**
   * Injectable opaque-socket-name source for deterministic tests. Defaults to a
   * fresh random id from the canonical {@link IdGenerator}, decoupled from the
   * session token so the token is never disclosed via `/proc/net/unix` (issue
   * #4729).
   */
  socketNameFactory?: () => string;
  /**
   * How many bounded, backed-off relaunches of the on-device server to attempt
   * (cumulatively over the source's lifetime) after a post-start server exit
   * before giving up the persistent encoder. Defaults to
   * {@link DEFAULT_MAX_SERVER_RELAUNCH_ATTEMPTS}. Set to `0` to disable relaunch
   * and surface a post-start loss immediately (fallback/`onError`).
   */
  maxServerRelaunchAttempts?: number;
  /** Backoff between post-start server relaunch attempts. */
  serverRelaunchBackoff?: BackoffInput;
  /**
   * Sustained-healthy runtime (ms), measured on the injected {@link Timer}, that
   * a (re)launched server must reach before a later post-start loss resets the
   * relaunch budget rather than spending it further (issue #7547). Defaults to
   * {@link DEFAULT_SERVER_RELAUNCH_HEALTHY_WINDOW_MS}.
   */
  serverRelaunchHealthyWindowMs?: number;
  /**
   * Invoked when relaunch attempts are exhausted, to hand the stream to
   * screenrecord via the SAME mechanism the initial-start path uses (see
   * `FallbackH264CaptureSource`). When it resolves, the persistent source is
   * considered gracefully superseded and does NOT fire `onError`. When it
   * rejects — or when it is not wired (e.g. the audio path, which requires the
   * jar) — the post-start loss surfaces via `onError` instead.
   */
  onScreenrecordFallback?: (error: Error) => Promise<void>;
}

export const DEFAULT_READY_TIMEOUT_MS = 10_000;

/**
 * Build an opaque abstract-socket name whose suffix is a fresh random id from the
 * canonical {@link IdGenerator}, deliberately unrelated to the session token
 * (issue #4729). Because abstract socket names are world-readable via
 * `/proc/net/unix`, embedding the token there would publish the secret; a random
 * id reveals nothing usable. The `automobile_video_` prefix is retained so the
 * orphan-forward sweep can still recognize our forwards, and dashes are stripped
 * so the suffix satisfies the server's `SAFE_SOCKET_NAME` (`[A-Za-z0-9_.-]{1,100}`).
 */
export function makeOpaqueSocketName(idGenerator: IdGenerator): string {
  return `${VIDEO_SERVER_SOCKET_PREFIX}_${idGenerator.next().replaceAll("-", "")}`;
}

/**
 * Assemble the pre-stream token handshake frame the client sends immediately on
 * connect (issue #4729): MAGIC(4) + VERSION(1) + TOKEN_LEN(1) + token bytes. Keep
 * in sync with `VideoHandshake` in the Kotlin video-server.
 */
export function buildHandshakeFrame(token: string, version: number): Buffer {
  const tokenBytes = Buffer.from(token, "ascii");
  const frame = Buffer.alloc(VIDEO_SERVER_HANDSHAKE_MAGIC.length + 2 + tokenBytes.length);
  let offset = VIDEO_SERVER_HANDSHAKE_MAGIC.copy(frame, 0);
  offset = frame.writeUInt8(version, offset);
  offset = frame.writeUInt8(tokenBytes.length, offset);
  tokenBytes.copy(frame, offset);
  return frame;
}

export function isSafeSessionToken(value: string): boolean {
  return /^[A-Za-z0-9-]{8,80}$/.test(value);
}
