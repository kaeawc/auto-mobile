import { connect as netConnect } from "node:net";
import { createHash } from "node:crypto";
import { ActionableError, type BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { shellQuote } from "../../utils/shellQuote";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  exponentialBackoff,
  normalizeBackoff,
  type BackoffInput,
  type BackoffPolicy,
} from "../../utils/Backoff";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbProcess } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  VideoServerJarProvider,
  type JarIntegrityProbe,
  type VideoServerJarIntegrity,
} from "./VideoServerJarProvider";
import type { H264CaptureSource, H264CaptureSourceTelemetry } from "./H264CaptureSource";
import {
  VIDEO_SERVER_CODEC_ID_H264,
  VIDEO_SERVER_CODEC_ID_PCM16,
  type VideoServerPacket,
  type VideoServerStreamHeader,
  VideoServerStreamParser,
} from "./VideoServerStreamParser";

/** Remote path the DEX jar is pushed to before launch. */
export const VIDEO_SERVER_REMOTE_JAR_PATH = "/data/local/tmp/automobile-video.jar";
/** Prefix for host-owned per-session LocalSocket names. */
export const VIDEO_SERVER_SOCKET_PREFIX = "automobile_video";
const VIDEO_SERVER_MAIN_CLASS = "dev.jasonpearson.automobile.video.VideoServer";
/** Device-side directory containing JSON lease files for owned capture sessions. */
export const VIDEO_SERVER_LEASE_DIRECTORY = "/data/local/tmp/automobile-video-sessions";
/** A device heartbeat older than this is eligible for owned stale cleanup. */
const STALE_LEASE_MS = 30_000;
/**
 * Fallback staleness threshold for a lease that predates the
 * `heartbeatElapsedRealtimeMs` field (see `hasValidLeaseHeartbeat`). The
 * monotonic elapsed-realtime clock is unavailable, so we fall back to the
 * always-written wall-clock `heartbeatAtMs`. Wall clock can jump (NTP, manual
 * set, timezone), so this is deliberately several minutes rather than the 30 s
 * monotonic window — a jump smaller than this cannot cause a false reclaim.
 */
const STALE_LEASE_WALL_CLOCK_MS = 5 * 60_000;
/**
 * A lease *file* (unparseable `*.json` or orphaned `*.json.tmp`) whose mtime is
 * older than this is swept during reconcile. Conservative because a
 * `*.json.tmp` may be mid-rename by a live server; younger files are left alone.
 */
const STALE_LEASE_FILE_SWEEP_MS = 5 * 60_000;
// The optional trailing `proto=<v>` is the handshake version negotiation channel
// (issue #4729): a pre-handshake device omits it, a handshake-capable device
// advertises it. Non-greedy socket capture so the optional group binds correctly.
const SESSION_READY_PATTERN =
  /^VIDEO_SESSION_READY token=([^ ]+) pid=(\d+) socket=([^ ]+?)(?: proto=(\d+))?$/;
/** Server stdout line printed after capture has fully started. */
const STREAMING_STARTED_MARKER = "Streaming started";
const VIDEO_STATS_PATTERN = /(?:^|\s)dropped=(\d+)(?:\s|$)/;

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
const VIDEO_SERVER_HANDSHAKE_MAGIC = Buffer.from([0x41, 0x56, 0x4d, 0x48]);
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

const EMPTY_SOCKET_NAME_SET: ReadonlySet<string> = new Set<string>();

export class InMemoryActiveVideoSessionRegistry implements ActiveVideoSessionRegistry {
  private readonly byDevice = new Map<string, Set<string>>();

  add(deviceId: string, socketName: string): void {
    const existing = this.byDevice.get(deviceId);
    if (existing) {
      existing.add(socketName);
      return;
    }
    this.byDevice.set(deviceId, new Set([socketName]));
  }

  remove(deviceId: string, socketName: string): void {
    const existing = this.byDevice.get(deviceId);
    if (!existing) {
      return;
    }
    existing.delete(socketName);
    if (existing.size === 0) {
      this.byDevice.delete(deviceId);
    }
  }

  active(deviceId: string): ReadonlySet<string> {
    return this.byDevice.get(deviceId) ?? EMPTY_SOCKET_NAME_SET;
  }
}

/** Shared across sibling capture sessions in the daemon process. */
export const defaultActiveVideoSessionRegistry: ActiveVideoSessionRegistry =
  new InMemoryActiveVideoSessionRegistry();

interface RawVideoServerLease {
  socketName: string;
  /**
   * SHA-256 hex of the session token (issue #4731). The lease never stores the raw token — it is
   * the on-wire auth secret (issue #4729), so cleartext-at-rest would be a disclosure path. A lease
   * owner re-derives this hash from the token it holds (see {@link hashSessionToken}) to confirm
   * ownership; foreign-lease reclaim matches on the non-secret `socketName` instead.
   */
  sessionTokenHash: string;
  ownerPid: number;
  deviceSerial: string;
  pid: number;
  forwardPort: number;
  startedAtMs: number;
  heartbeatAtMs: number;
  heartbeatElapsedRealtimeMs?: number;
}

/**
 * A validated lease read back from the device. Identical to the on-disk record: the raw token is no
 * longer recoverable from disk, so a parsed lease carries only the non-secret `socketName` (the
 * filename/id the reconcile+sweep match on) and the token's hash.
 */
type VideoServerLease = RawVideoServerLease;

/**
 * SHA-256 hex of a session token, matching the device's `sessionTokenSha256Hex` (issue #4731). Used
 * to confirm an owned lease belongs to this session without the token ever touching disk.
 */
function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "ascii").digest("hex");
}

const defaultConnector: SocketConnector = (port, signal) =>
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
  adbFactory?: AdbClientFactory;
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
   * Invoked when relaunch attempts are exhausted, to hand the stream to
   * screenrecord via the SAME mechanism the initial-start path uses (see
   * `FallbackH264CaptureSource`). When it resolves, the persistent source is
   * considered gracefully superseded and does NOT fire `onError`. When it
   * rejects — or when it is not wired (e.g. the audio path, which requires the
   * jar) — the post-start loss surfaces via `onError` instead.
   */
  onScreenrecordFallback?: (error: Error) => Promise<void>;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;

/**
 * Build an opaque abstract-socket name whose suffix is a fresh random id from the
 * canonical {@link IdGenerator}, deliberately unrelated to the session token
 * (issue #4729). Because abstract socket names are world-readable via
 * `/proc/net/unix`, embedding the token there would publish the secret; a random
 * id reveals nothing usable. The `automobile_video_` prefix is retained so the
 * orphan-forward sweep can still recognize our forwards, and dashes are stripped
 * so the suffix satisfies the server's `SAFE_SOCKET_NAME` (`[A-Za-z0-9_.-]{1,100}`).
 */
function makeOpaqueSocketName(idGenerator: IdGenerator): string {
  return `${VIDEO_SERVER_SOCKET_PREFIX}_${idGenerator.next().replaceAll("-", "")}`;
}

/**
 * Assemble the pre-stream token handshake frame the client sends immediately on
 * connect (issue #4729): MAGIC(4) + VERSION(1) + TOKEN_LEN(1) + token bytes. Keep
 * in sync with `VideoHandshake` in the Kotlin video-server.
 */
function buildHandshakeFrame(token: string, version: number): Buffer {
  const tokenBytes = Buffer.from(token, "ascii");
  const frame = Buffer.alloc(VIDEO_SERVER_HANDSHAKE_MAGIC.length + 2 + tokenBytes.length);
  let offset = VIDEO_SERVER_HANDSHAKE_MAGIC.copy(frame, 0);
  offset = frame.writeUInt8(version, offset);
  offset = frame.writeUInt8(tokenBytes.length, offset);
  tokenBytes.copy(frame, offset);
  return frame;
}

/**
 * Parse one `adb forward --list` row (`<serial> tcp:<port> localabstract:<name>`)
 * into a video forward, or `null` when the row is not an `automobile_video_*`
 * TCP forward. Field order is not assumed — the `tcp:`/`localabstract:` tokens
 * are matched positionally-agnostically, mirroring `removeForwardIfMatching`.
 */
function parseVideoForwardLine(line: string): { port: number; socketName: string } | null {
  const fields = line.trim().split(/\s+/);
  const destination = fields.find((field) =>
    field.startsWith(`localabstract:${VIDEO_SERVER_SOCKET_PREFIX}_`),
  );
  const portField = fields.find((field) => field.startsWith("tcp:"));
  if (destination === undefined || portField === undefined) {
    return null;
  }
  const port = Number.parseInt(portField.slice("tcp:".length), 10);
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }
  return { port, socketName: destination.slice("localabstract:".length) };
}

/**
 * Parse the on-device jar-integrity probe output (issue #4733): the combined
 * stdout of `sha256sum <jar>` (a `<64-hex>  <path>` line) and `wc -c < <jar>` (a
 * bare byte count). Order-independent. Returns `null` on any missing/garbled
 * field — a partial or absent result (jar missing, `sha256sum`/`wc` unavailable)
 * is treated by the caller as "push needed", never as a match.
 */
function parseRemoteJarIntegrity(output: string): VideoServerJarIntegrity | null {
  let sha256: string | null = null;
  let size: number | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (/^[0-9]+$/.test(line)) {
      size = Number.parseInt(line, 10);
      continue;
    }
    const shaMatch = /^([a-f0-9]{64})(?:\s|$)/.exec(line);
    if (shaMatch) {
      sha256 = shaMatch[1];
    }
  }
  if (sha256 === null || size === null || !Number.isInteger(size) || size < 0) {
    return null;
  }
  return { sha256, size };
}

function isSafeSessionToken(value: string): boolean {
  return /^[A-Za-z0-9-]{8,80}$/.test(value);
}

/** Lowercase SHA-256 hex, the only token-derived value now persisted (issue #4731). */
function isSessionTokenHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Mirrors `VideoSessionArguments.SAFE_SOCKET_NAME` on the device side. */
const SAFE_SOCKET_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasValidLeaseHeartbeat(lease: Record<string, unknown>): boolean {
  const elapsedRealtimeMs = lease.heartbeatElapsedRealtimeMs;
  return (
    elapsedRealtimeMs === undefined || (isFiniteNumber(elapsedRealtimeMs) && elapsedRealtimeMs >= 0)
  );
}

function isVideoServerLease(value: unknown): value is RawVideoServerLease {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const lease = value as Record<string, unknown>;
  return [
    isSessionTokenHash(lease.sessionTokenHash),
    typeof lease.socketName === "string",
    // The socket name is the on-disk filename/id (issue #4731); require the safe shape so it is
    // never interpolated into a `cat`/`rm` path we did not expect.
    typeof lease.socketName === "string" && SAFE_SOCKET_NAME_PATTERN.test(lease.socketName),
    typeof lease.deviceSerial === "string",
    isPositiveInteger(lease.ownerPid),
    isPositiveInteger(lease.pid),
    isPositiveInteger(lease.forwardPort),
    isFiniteNumber(lease.startedAtMs),
    isFiniteNumber(lease.heartbeatAtMs),
    hasValidLeaseHeartbeat(lease),
  ].every(Boolean);
}

function parseLeases(output: string): VideoServerLease[] {
  return output.split(/\r?\n/).flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isVideoServerLease(parsed)) {
        return [];
      }
      return [parsed];
    } catch (error) {
      logger.debug(
        `[PersistentEncoderH264Source] ignoring malformed video session lease: ${error}`,
      );
      return [];
    }
  });
}

/** Basenames the sweep is allowed to `rm`; guards against odd device output. */
const LEASE_FILE_NAME_PATTERN = /^[A-Za-z0-9_.-]+\.json(?:\.tmp)?$/;

/**
 * Parse the `sweepOrphanLeaseFiles` listing: a leading `NOW <epochSeconds>`
 * line emitted by `date +%s`, followed by `<mtimeSeconds> <path>` rows from
 * `stat -c '%Y %n'`. Returns the device wall clock in ms plus each file's
 * basename and mtime in ms. Rows whose basename fails the safe-name pattern are
 * dropped so the caller never issues a surprising `rm`.
 */
function parseLeaseFileListing(output: string): {
  nowEpochMs: number | null;
  files: { name: string; mtimeMs: number }[];
} {
  let nowEpochMs: number | null = null;
  const files: { name: string; mtimeMs: number }[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.startsWith("NOW ")) {
      const seconds = Number.parseInt(trimmed.slice(4).trim(), 10);
      if (Number.isFinite(seconds) && seconds >= 0) {
        nowEpochMs = seconds * 1_000;
      }
      continue;
    }
    const separator = trimmed.indexOf(" ");
    if (separator <= 0) {
      continue;
    }
    const mtimeSeconds = Number.parseInt(trimmed.slice(0, separator), 10);
    const path = trimmed.slice(separator + 1).trim();
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (!Number.isFinite(mtimeSeconds) || mtimeSeconds < 0 || !LEASE_FILE_NAME_PATTERN.test(name)) {
      continue;
    }
    files.push({ name, mtimeMs: mtimeSeconds * 1_000 });
  }
  return { nowEpochMs, files };
}

/**
 * Produces a continuous H.264 Annex-B elementary stream from a persistent
 * on-device MediaCodec encoder (the `android/video-server` DEX run via
 * `app_process`), instead of a time-limited `screenrecord`. Because the encoder
 * is long-lived there is no ~175s segment-rotation boundary and no per-rotation
 * SPS/PPS + IDR re-emission — a single continuous timestamp base.
 *
 * Lifecycle: push the jar, launch the server, wait for its readiness line,
 * `adb forward` an ephemeral local port to the server's abstract LocalSocket,
 * connect, and parse the binary framing into Annex-B payloads. Fully injectable
 * (ADB factory, socket connector, timer) for device-free unit tests.
 */
export class PersistentEncoderH264Source implements H264CaptureSource {
  private readonly options: PersistentEncoderH264SourceOptions;
  private readonly adbFactory: AdbClientFactory;
  private readonly connector: SocketConnector;
  private readonly timer: Timer;
  private readonly readyTimeoutMs: number;
  private readonly commandTimeoutMs: number;
  private readonly teardownTimeoutMs: number;
  private readonly localSocketReconnectWindowMs: number;
  private readonly localSocketReconnectRetryMs: number;
  private readonly sessionTokenFactory: () => string;
  private readonly socketNameFactory: () => string;
  private readonly activeVideoSessionRegistry: ActiveVideoSessionRegistry;
  private readonly maxServerRelaunchAttempts: number;
  private readonly serverRelaunchBackoff: BackoffPolicy;
  /**
   * Injected host-integrity source, or `undefined` to lazily default to the
   * shared {@link VideoServerJarProvider} singleton. Resolved on first use rather
   * than in the constructor so the `??` default does not count against the
   * constructor's complexity ratchet.
   */
  private readonly jarIntegrityProvider: JarIntegrityProbe | undefined;

  /**
   * Host-known expected sha256 + size of the local jar (issue #4733), memoized
   * across relaunches because the on-disk jar does not change during a source's
   * lifetime.
   */
  private expectedJarIntegrity: VideoServerJarIntegrity | null = null;
  /**
   * True once the on-device jar has been confirmed byte-identical to the expected
   * host copy for the current launch. Set when the pre-push probe matches (push
   * skipped) so the pre-launch verify can reuse that result; reset per session.
   */
  private remoteJarVerified = false;

  private server: AdbProcess | null = null;
  private socket: StreamSocket | null = null;
  private forwardedPort: number | null = null;
  private session: VideoServerSession | null = null;
  private deviceProcessId: number | null = null;
  /**
   * Handshake protocol version negotiated from the device's readiness line
   * (issue #4729). `null` means the device advertised no `proto=` field (a
   * pre-handshake jar): the client then connects without sending a handshake so
   * streaming degrades gracefully instead of hard-breaking.
   */
  private negotiatedHandshakeVersion: number | null = null;
  private running = false;
  private teardownPromise: Promise<void> | null = null;
  private resolveStartupAudioHeader: ((header: VideoServerStreamHeader) => void) | undefined;
  private resolveStartupAudioPacket: ((packet: VideoServerPacket) => void) | undefined;
  private socketReconnectPromise: Promise<void> | null = null;
  private socketReconnectAbortController: AbortController | null = null;
  private telemetryInitialized = false;
  private lastEncodedFrameTimestampUs: number | null = null;
  private lastIdrTimestampUs: number | null = null;
  private idrRequestCount = 0;
  private idrCompletionCount = 0;
  private pendingIdrRequests = 0;
  private encodedAccessUnitCount = 0;
  private serverOutputObserver: ((chunk: Buffer) => void) | null = null;
  private serverOutputBuffer = "";
  private sawStreamingStarted = false;
  private serverStartupInProgress: AdbProcess | null = null;
  private serverStartupFailure: { server: AdbProcess; error: Error } | null = null;
  private serverRelaunchAttempts = 0;
  private relaunching = false;
  private relaunchAbortController: AbortController | null = null;

  constructor(options: PersistentEncoderH264SourceOptions) {
    this.options = options;
    this.adbFactory = options.adbFactory ?? defaultAdbClientFactory;
    this.connector = options.connector ?? defaultConnector;
    this.timer = options.timer ?? defaultTimer;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_LAUNCH_COMMAND_TIMEOUT_MS;
    this.teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_COMMAND_TIMEOUT_MS;
    this.localSocketReconnectWindowMs =
      options.localSocketReconnectWindowMs ?? DEFAULT_LOCAL_SOCKET_RECONNECT_WINDOW_MS;
    this.localSocketReconnectRetryMs =
      options.localSocketReconnectRetryMs ?? DEFAULT_LOCAL_SOCKET_RECONNECT_RETRY_MS;
    this.sessionTokenFactory = options.sessionTokenFactory ?? (() => defaultIdGenerator.next());
    this.socketNameFactory =
      options.socketNameFactory ?? (() => makeOpaqueSocketName(defaultIdGenerator));
    this.activeVideoSessionRegistry =
      options.activeVideoSessionRegistry ?? defaultActiveVideoSessionRegistry;
    this.jarIntegrityProvider = options.jarIntegrityProvider;
    const relaunchPolicy = PersistentEncoderH264Source.resolveRelaunchPolicy(options);
    this.maxServerRelaunchAttempts = relaunchPolicy.maxAttempts;
    this.serverRelaunchBackoff = relaunchPolicy.backoff;
    this.validateTimings();
  }

  /**
   * Resolve the post-start relaunch policy from options, defaulting the budget
   * and backoff. Extracted from the constructor so the option-defaulting `??`
   * branches do not count against the constructor's complexity ratchet.
   */
  private static resolveRelaunchPolicy(options: PersistentEncoderH264SourceOptions): {
    maxAttempts: number;
    backoff: BackoffPolicy;
  } {
    return {
      maxAttempts: options.maxServerRelaunchAttempts ?? DEFAULT_MAX_SERVER_RELAUNCH_ATTEMPTS,
      backoff: normalizeBackoff(options.serverRelaunchBackoff ?? DEFAULT_SERVER_RELAUNCH_BACKOFF),
    };
  }

  /**
   * Fail fast on non-positive timing options. Extracted from the constructor so the constructor
   * stays under the cyclomatic-complexity ratchet; every branch here is a validation guard, not
   * constructor control flow.
   */
  private validateTimings(): void {
    if (this.commandTimeoutMs <= 0 || this.teardownTimeoutMs <= 0) {
      throw new ActionableError("Video server command timeouts must be positive milliseconds.");
    }
    if (this.localSocketReconnectWindowMs <= 0 || this.localSocketReconnectRetryMs <= 0) {
      throw new ActionableError("Local socket reconnect timings must be positive milliseconds.");
    }
    if (!Number.isInteger(this.maxServerRelaunchAttempts) || this.maxServerRelaunchAttempts < 0) {
      throw new ActionableError("Server relaunch attempts must be a non-negative integer.");
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  getTelemetry(): H264CaptureSourceTelemetry {
    if (!this.telemetryInitialized) {
      return {
        lastEncodedFrameTimestampUs: null,
        lastIdrTimestampUs: null,
        idrRequestCount: null,
        idrCompletionCount: null,
        encodedAccessUnitCount: null,
      };
    }
    return {
      lastEncodedFrameTimestampUs: this.lastEncodedFrameTimestampUs,
      lastIdrTimestampUs: this.lastIdrTimestampUs,
      idrRequestCount: this.idrRequestCount,
      idrCompletionCount: this.idrCompletionCount,
      encodedAccessUnitCount: this.encodedAccessUnitCount,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new ActionableError("Persistent encoder H.264 source already started.");
    }
    this.running = true;
    this.serverStartupInProgress = null;
    this.serverStartupFailure = null;
    try {
      await this.launch();
    } catch (error) {
      // Startup failed before we produced anything: tear down and rethrow so the
      // caller (source factory) can fall back to screenrecord.
      this.running = false;
      await this.beginTeardown();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      await this.teardownPromise;
      return;
    }
    this.running = false;
    // Cancel any in-flight relaunch wait/loop so stop() settles promptly instead
    // of blocking on a backoff delay or a relaunch launch attempt.
    this.relaunchAbortController?.abort();
    await this.beginTeardown();
  }

  /**
   * Ask the on-device encoder to emit a fresh IDR by sending the request-keyframe
   * command over the socket. The encoder (MediaCodec) honors it via
   * PARAMETER_KEY_REQUEST_SYNC_FRAME, so a late/recovering WHEP viewer decodes
   * without waiting for the periodic two-second I-frame interval. The publisher
   * throttles calls.
   */
  requestKeyFrame(): boolean {
    const socket = this.socket;
    if (!this.running || !socket) {
      return false;
    }
    this.telemetryInitialized = true;
    this.idrRequestCount++;
    this.pendingIdrRequests++;
    try {
      socket.write(Buffer.from([VIDEO_SERVER_COMMAND_REQUEST_KEY_FRAME]));
      return true;
    } catch (error) {
      this.pendingIdrRequests--;
      // Best-effort: a dropped socket surfaces via its own error/close handler.
      logger.debug(`[PersistentEncoderH264Source] keyframe request write failed: ${error}`);
      return false;
    }
  }

  /**
   * Race `operation` against a deadline driven by the injected `Timer`, so a
   * wedged ADB/USB state cannot block the persistent-encoder lifecycle forever.
   * On timeout the returned promise rejects with an `ActionableError`; launch-path
   * callers let it propagate (falling back to screenrecord) while teardown-path
   * callers catch it and continue. Deterministic under `FakeTimer` in tests.
   */
  private withTimeout<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeout = this.timer.setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        logger.warn(`[PersistentEncoderH264Source] ${label} timed out after ${ms}ms`);
        reject(new ActionableError(`${label} did not complete within ${ms}ms`));
      }, ms);
      operation.then(
        (value) => {
          if (settled) {
            return;
          }
          settled = true;
          this.timer.clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          if (settled) {
            return;
          }
          settled = true;
          this.timer.clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async launch(): Promise<void> {
    const adb = this.adbFactory.create(this.options.device);
    const port = await this.prepareSession(adb);
    if (port === null) {
      return;
    }
    const server = await this.spawnAndWaitForServer(adb);
    if (!server) {
      return;
    }
    await this.connectToServer(server, port);
  }

  private async prepareSession(
    adb: ReturnType<AdbClientFactory["create"]>,
  ): Promise<number | null> {
    if (!this.running) {
      return null;
    }
    const session = this.createSession();
    this.session = session;
    this.deviceProcessId = null;
    this.remoteJarVerified = false;
    // Claim this session's socket name BEFORE reconcile opens/owns any forward,
    // so a sibling session's concurrent orphan sweep can never mistake our
    // about-to-be-created forward for a stranded one. Cleared in teardown().
    this.activeVideoSessionRegistry.add(this.options.device.deviceId, session.socketName);
    await this.reconcileExpiredLeases(adb);
    if (!this.running) {
      return null;
    }
    await this.ensureRemoteJar(adb);
    if (!this.running) {
      return null;
    }
    const forward = await this.withTimeout(
      adb.executeCommand(`forward tcp:0 localabstract:${session.socketName}`),
      this.commandTimeoutMs,
      "adb forward video-server socket",
    );
    const port = Number.parseInt(forward.stdout.trim(), 10);
    if (!Number.isInteger(port) || port <= 0) {
      throw new ActionableError(`adb forward returned an invalid port: "${forward.stdout.trim()}"`);
    }
    if (!this.running) {
      // This forward completed after stop() snapshotted its resources. It is
      // still ours only while it retains this session's destination.
      await this.removeForwardIfMatching(adb, port, session.socketName);
      return null;
    }
    this.forwardedPort = port;
    return port;
  }

  /**
   * Push the jar to `/data/local/tmp` only when the on-device copy does not
   * already match the verified host bytes (issue #4733). The remote jar is
   * sha256summed + sized through the ADB seam and compared against the host-known
   * expected {@link VideoServerJarIntegrity}; a byte-identical remote copy skips
   * the ~2.5 MB USB push (first-frame latency), otherwise the push runs. Any
   * mismatch OR uncertainty (unreadable remote, missing `sha256sum`/`wc`, a probe
   * timeout) pushes — correctness is never traded for the optimization. A skip is
   * recorded in {@link remoteJarVerified} so the pre-launch verify can reuse it
   * (the happy path hashes the remote once). Bounded by the launch-command
   * timeout (issue #4741) like every other launch-path ADB call.
   */
  private async ensureRemoteJar(adb: ReturnType<AdbClientFactory["create"]>): Promise<void> {
    const expected = await this.resolveExpectedJarIntegrity();
    const remote = await this.statAndHashRemoteJar(adb);
    if (remote !== null && remote.size === expected.size && remote.sha256 === expected.sha256) {
      this.remoteJarVerified = true;
      logger.info(
        `[PersistentEncoderH264Source] on-device video-server jar already matches ` +
          `(sha256=${expected.sha256}, size=${expected.size}); skipping push`,
      );
      return;
    }
    if (remote !== null) {
      logger.info(
        `[PersistentEncoderH264Source] on-device video-server jar differs ` +
          `(expected sha256=${expected.sha256} size=${expected.size}, ` +
          `remote sha256=${remote.sha256} size=${remote.size}); pushing`,
      );
    }
    await this.withTimeout(
      adb.executeCommand(`push "${this.options.jarPath}" ${VIDEO_SERVER_REMOTE_JAR_PATH}`),
      this.commandTimeoutMs,
      "adb push video-server jar",
    );
  }

  /**
   * Refuse to `app_process`-launch a jar whose on-device bytes DEFINITIVELY do
   * not match the verified host copy (issue #4733) — a supply-chain / TOCTOU
   * guard, since the jar runs in the screen/audio-capture context. Reuses the
   * pre-push match when the push was skipped ({@link remoteJarVerified}); `adb
   * forward` does not touch the jar, so that match still holds as the launch gate.
   * Otherwise (a push just ran) it re-hashes the remote jar and throws an
   * {@link ActionableError} on a definitive mismatch. An unreadable probe (device
   * without `sha256sum`/`wc`, or a probe timeout) is not a mismatch: the push has
   * already overwritten the remote with our trusted bytes, so — mirroring the
   * handshake graceful-degrade — it logs and proceeds rather than regressing every
   * such device to screenrecord.
   */
  private async verifyRemoteJarBeforeLaunch(
    adb: ReturnType<AdbClientFactory["create"]>,
  ): Promise<void> {
    if (this.remoteJarVerified) {
      return;
    }
    const expected = await this.resolveExpectedJarIntegrity();
    const remote = await this.statAndHashRemoteJar(adb);
    if (remote === null) {
      logger.warn(
        `[PersistentEncoderH264Source] could not hash the on-device jar at ${VIDEO_SERVER_REMOTE_JAR_PATH} ` +
          "before launch; proceeding on the just-pushed trusted bytes (integrity verification degraded)",
      );
      return;
    }
    if (remote.size !== expected.size || remote.sha256 !== expected.sha256) {
      throw new ActionableError(
        `Refusing to launch video-server: the on-device jar at ${VIDEO_SERVER_REMOTE_JAR_PATH} failed ` +
          `integrity verification (expected sha256=${expected.sha256} size=${expected.size}, got ` +
          `sha256=${remote.sha256} size=${remote.size}). The bytes on the device do not match the ` +
          "verified host copy; app_process will not be launched.",
      );
    }
    this.remoteJarVerified = true;
  }

  /**
   * Host-known expected sha256 + size of the local jar, memoized (issue #4733).
   * Delegates to the injected {@link JarIntegrityProbe}, which hashes the actual
   * bytes at {@link PersistentEncoderH264SourceOptions.jarPath} with the canonical
   * calculator — correct for cache, override, and local-build jars alike.
   */
  private async resolveExpectedJarIntegrity(): Promise<VideoServerJarIntegrity> {
    if (this.expectedJarIntegrity === null) {
      const provider = this.jarIntegrityProvider ?? VideoServerJarProvider.getInstance();
      const integrity = await provider.computeLocalJarIntegrity(this.options.jarPath);
      this.expectedJarIntegrity = { sha256: integrity.sha256.toLowerCase(), size: integrity.size };
    }
    return this.expectedJarIntegrity;
  }

  /**
   * Read the on-device jar's sha256 + byte size through the ADB seam, or `null`
   * when it cannot be determined (issue #4733). A single `sh -c` runs
   * `sha256sum` + `wc -c` on the constant remote path (no interpolation), bounded
   * by the launch-command timeout. A missing jar, absent tooling, or a timeout
   * yields `null` — the callers treat that as "push"/"refuse", never as a match.
   */
  private async statAndHashRemoteJar(
    adb: ReturnType<AdbClientFactory["create"]>,
  ): Promise<VideoServerJarIntegrity | null> {
    const probe =
      `sha256sum ${VIDEO_SERVER_REMOTE_JAR_PATH} 2>/dev/null; ` +
      `wc -c < ${VIDEO_SERVER_REMOTE_JAR_PATH} 2>/dev/null`;
    try {
      const result = await this.withTimeout(
        adb.executeCommand(`shell sh -c ${shellQuote(probe)}`),
        this.commandTimeoutMs,
        "adb hash video-server jar",
      );
      return parseRemoteJarIntegrity(result.stdout);
    } catch (error) {
      // Uncertainty is not fatal here: the caller pushes (or refuses to launch)
      // on a null probe, so a wedged/absent probe never yields a false match.
      logger.debug(
        `[PersistentEncoderH264Source] unable to hash on-device video-server jar: ${error}`,
      );
      return null;
    }
  }

  private async spawnAndWaitForServer(
    adb: ReturnType<AdbClientFactory["create"]>,
  ): Promise<AdbProcess | null> {
    await this.verifyRemoteJarBeforeLaunch(adb);
    if (!this.running) {
      return null;
    }
    const server = await this.withTimeout(
      adb.spawn(this.buildServerArgs()),
      this.commandTimeoutMs,
      "adb spawn video-server",
    );
    if (!this.running) {
      server.kill("SIGINT");
      return null;
    }
    this.server = server;
    this.attachServerOutputObserver(server);
    server.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.debug(`[PersistentEncoderH264Source] server stderr: ${text}`);
      }
    });

    const ready = await this.waitForReady(server);
    this.deviceProcessId = ready.pid;
    this.negotiatedHandshakeVersion = this.resolveHandshakeVersion(ready.protocolVersion);
    this.serverStartupInProgress = server;
    this.watchServer(server);
    return this.running ? server : null;
  }

  private async connectToServer(server: AdbProcess, port: number): Promise<void> {
    this.throwIfServerStartupFailed(server);
    const streamingStarted = this.options.audioEnabled
      ? this.waitForStreamingStarted(server)
      : null;
    // The waiter is installed before connecting so a fast server cannot print
    // the marker in the gap between client connect and the later startup await.
    streamingStarted?.catch(() => {});

    // Give the first connect the same deadline+abort treatment the reconnect path
    // uses. A half-open forward with a live server would otherwise hang here
    // forever (the race below only settles on server failure, not a stuck connect).
    const connectController = new AbortController();
    const connectDeadline = this.timer.now() + this.commandTimeoutMs;
    const connection = this.connectBeforeDeadline(port, connectDeadline, connectController.signal);
    let connectionWon = false;
    let rejectServerFailure!: (error: Error) => void;
    const serverFailure = new Promise<never>((_, reject) => {
      rejectServerFailure = reject;
    });
    const onServerExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      rejectServerFailure(new Error(`video-server exited (code=${code}, signal=${signal})`));
    };
    const onServerError = (error: Error): void => {
      rejectServerFailure(error);
    };
    server.once("exit", onServerExit);
    server.once("error", onServerError);
    try {
      const socket = await Promise.race([connection, serverFailure]);
      connectionWon = true;
      if (!this.running) {
        socket.destroy();
        return;
      }
      this.socket = socket;
      // Authenticate the connection before anything reads the stream header.
      this.sendHandshake(socket);
      const startupAudioReady = this.options.audioEnabled ? this.waitForStartupAudioReady() : null;
      let socketFailureMode: "startup" | "post-start" = this.options.audioEnabled
        ? "startup"
        : "post-start";
      let rejectStartupSocketFailure: ((error: Error) => void) | undefined;
      const startupSocketFailure = this.options.audioEnabled
        ? new Promise<never>((_, reject) => {
            rejectStartupSocketFailure = reject;
          })
        : null;
      this.wireSocket(
        socket,
        (error) => {
          if (socketFailureMode === "startup") {
            rejectStartupSocketFailure?.(error);
            return;
          }
          this.reconnectSocket(socket, error);
        },
        (header) => this.resolveStartupAudioHeader?.(header),
      );

      // For audio-enabled streams, REMOTE_SUBMIX initialization happens after the
      // socket client connects. Do not resolve start() until that succeeds, or an
      // unavailable audio source would look like a successful start followed by a
      // reconnect-looping post-start failure.
      if (this.options.audioEnabled) {
        await Promise.race([
          Promise.all([streamingStarted, startupAudioReady]),
          startupSocketFailure,
        ]);
        if (!this.running) {
          return;
        }
      }
      socketFailureMode = "post-start";
    } finally {
      server.removeListener("exit", onServerExit);
      server.removeListener("error", onServerError);
      if (!connectionWon) {
        // Server failure (or teardown) won the race: cancel the bounded connect
        // so a late-resolving local socket is destroyed rather than leaked.
        connectController.abort();
        void connection.catch(() => {});
      }
      if (this.serverStartupInProgress === server) {
        this.serverStartupInProgress = null;
      }
    }
  }

  private throwIfServerStartupFailed(server: AdbProcess): void {
    const failure = this.serverStartupFailure;
    if (failure?.server === server) {
      throw failure.error;
    }
  }

  private watchServer(server: AdbProcess): void {
    server.once("exit", (code, signal) => {
      if (this.server !== server) {
        return;
      }
      this.detachServerOutputObserver(server);
      this.server = null;
      if (this.serverStartupInProgress === server) {
        this.serverStartupFailure = {
          server,
          error: new Error(`video-server exited (code=${code}, signal=${signal})`),
        };
        return;
      }
      this.handlePostStartServerLoss(
        new Error(`video-server exited (code=${code}, signal=${signal})`),
      );
    });
    server.once("error", (error: Error) => {
      if (this.serverStartupInProgress === server) {
        this.serverStartupFailure = { server, error };
        return;
      }
      this.handlePostStartServerLoss(error);
    });
  }

  private buildServerArgs(): string[] {
    const session = this.session;
    if (!session || this.forwardedPort === null) {
      throw new Error("Video server session was not initialized.");
    }
    const args = [
      "shell",
      `CLASSPATH=${VIDEO_SERVER_REMOTE_JAR_PATH}`,
      "app_process",
      "/",
      VIDEO_SERVER_MAIN_CLASS,
      "--quality",
      this.options.quality ?? "medium",
      "--socket-name",
      session.socketName,
      "--session-token",
      session.token,
      "--owner-pid",
      String(session.ownerPid),
      "--device-serial",
      session.deviceSerial,
      "--forward-port",
      String(this.forwardedPort),
    ];
    if (this.options.bitrateBps && this.options.bitrateBps > 0) {
      args.push("--bit-rate", String(Math.round(this.options.bitrateBps)));
    }
    if (Number.isInteger(this.options.fps) && (this.options.fps as number) > 0) {
      args.push("--fps", String(this.options.fps));
    }
    if (this.options.size) {
      args.push("--size", `${this.options.size.width}x${this.options.size.height}`);
    }
    if (this.options.audioEnabled) {
      args.push("--audio");
    }
    return args;
  }

  private createSession(): VideoServerSession {
    const token = this.sessionTokenFactory();
    if (!isSafeSessionToken(token)) {
      throw new Error("Video server session token factory returned an unsafe token.");
    }
    const socketName = this.socketNameFactory();
    if (!SAFE_SOCKET_NAME_PATTERN.test(socketName)) {
      throw new Error("Video server socket-name factory returned an unsafe socket name.");
    }
    return {
      token,
      socketName,
      ownerPid: process.pid,
      deviceSerial: this.options.device.deviceId,
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
  private resolveHandshakeVersion(advertised: number | null): number | null {
    if (advertised === null) {
      logger.warn(
        "[PersistentEncoderH264Source] device advertised no handshake protocol; " +
          "streaming without a token handshake (defense-in-depth degraded, UID gating still applies)",
      );
      return null;
    }
    return Math.min(advertised, VIDEO_SERVER_HANDSHAKE_VERSION);
  }

  private waitForReady(
    server: AdbProcess,
  ): Promise<{ pid: number; protocolVersion: number | null }> {
    const token = this.session?.token;
    if (!token) {
      throw new Error("Video server session token was unavailable.");
    }
    return new Promise<{ pid: number; protocolVersion: number | null }>((resolve, reject) => {
      let settled = false;
      let stdoutBuffer = "";
      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        server.stdout.off("data", onData);
        server.removeListener("exit", onExit);
        server.removeListener("error", onError);
        fn();
      };
      const timeout = this.timer.setTimeout(() => {
        finish(() =>
          reject(
            new ActionableError(
              `video-server did not become session-ready within ${this.readyTimeoutMs}ms. ` +
                "Set AUTOMOBILE_VIDEO_SERVER_JAR to a current automobile-video.jar.",
            ),
          ),
        );
      }, this.readyTimeoutMs);
      const onData = (chunk: Buffer): void => {
        if (settled) {
          return;
        }
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const match = SESSION_READY_PATTERN.exec(line);
          if (!match) {
            continue;
          }
          if (match[1] !== token || match[3] !== this.session?.socketName) {
            finish(() =>
              reject(
                new ActionableError(
                  `video-server session readiness token mismatch (expected=${token}, got=${match[1]})`,
                ),
              ),
            );
            return;
          }
          const pid = Number.parseInt(match[2], 10);
          if (!Number.isInteger(pid) || pid <= 0) {
            finish(() =>
              reject(new ActionableError("video-server returned an invalid session PID")),
            );
            return;
          }
          const protocolVersion = match[4] !== undefined ? Number.parseInt(match[4], 10) : null;
          finish(() => resolve({ pid, protocolVersion }));
          return;
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish(() =>
          reject(new Error(`video-server exited before ready (code=${code}, signal=${signal})`)),
        );
      };
      const onError = (error: Error): void => finish(() => reject(error));

      server.stdout.on("data", onData);
      server.once("exit", onExit);
      server.once("error", onError);
    });
  }

  private waitForStreamingStarted(server: AdbProcess): Promise<void> {
    if (this.sawStreamingStarted) {
      return Promise.resolve();
    }
    return this.waitForServerLine(
      server,
      STREAMING_STARTED_MARKER,
      `video-server did not start streaming within ${this.readyTimeoutMs}ms`,
      "video-server exited before streaming started",
    );
  }

  private waitForStartupAudioReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let muxAudioHeaderSeen = false;
      const timeout = this.timer.setTimeout(() => {
        finish(() =>
          reject(
            new ActionableError(
              `video-server did not produce PCM audio within ${this.readyTimeoutMs}ms`,
            ),
          ),
        );
      }, this.readyTimeoutMs);

      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        this.resolveStartupAudioHeader = undefined;
        this.resolveStartupAudioPacket = undefined;
        fn();
      };

      this.resolveStartupAudioHeader = (header) => {
        if (header.muxed === true && header.audio === true) {
          muxAudioHeaderSeen = true;
          return;
        }
        finish(() => {
          reject(
            new ActionableError(
              "Audio was requested, but video-server did not advertise muxed PCM audio. Rebuild or provide a current automobile-video.jar.",
            ),
          );
        });
      };

      this.resolveStartupAudioPacket = (packet) => {
        if (
          muxAudioHeaderSeen &&
          packet.codecId === VIDEO_SERVER_CODEC_ID_PCM16 &&
          packet.data.length > 0
        ) {
          finish(resolve);
        }
      };
    });
  }

  private waitForServerLine(
    server: AdbProcess,
    marker: string,
    timeoutMessage: string,
    exitMessagePrefix: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let stdoutBuffer = "";
      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.timer.clearTimeout(timeout);
        server.stdout.off("data", onData);
        server.removeListener("exit", onExit);
        server.removeListener("error", onError);
        fn();
      };
      const timeout = this.timer.setTimeout(() => {
        finish(() => reject(new ActionableError(timeoutMessage)));
      }, this.readyTimeoutMs);

      const onData = (chunk: Buffer): void => {
        if (settled) {
          return; // stop accumulating once ready (or failed)
        }
        stdoutBuffer += chunk.toString();
        if (stdoutBuffer.includes(marker)) {
          finish(resolve);
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        finish(() => reject(new Error(`${exitMessagePrefix} (code=${code}, signal=${signal})`)));
      };
      const onError = (error: Error): void => finish(() => reject(error));

      server.stdout.on("data", onData);
      server.once("exit", onExit);
      server.once("error", onError);
    });
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
  private sendHandshake(socket: StreamSocket): void {
    const session = this.session;
    const version = this.negotiatedHandshakeVersion;
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

  private wireSocket(
    socket: StreamSocket,
    onSocketFailure: (error: Error) => void,
    onStreamHeader?: (header: VideoServerStreamHeader) => void,
  ): void {
    const parser = new VideoServerStreamParser({
      onHeader: (header) => {
        onStreamHeader?.(header);
        // Every local client attach, including a replacement socket, triggers a
        // fresh encoder request. The video-server has already replayed cached
        // SPS/PPS + IDR; this makes the next frame current without a GOP wait.
        this.requestKeyFrame();
        logger.info(
          `[PersistentEncoderH264Source] stream ${header.width}x${header.height} codec=0x${header.codecId.toString(16)}`,
        );
      },
      onPacket: (packet) => {
        if (this.socket === socket) {
          if (packet.codecId === VIDEO_SERVER_CODEC_ID_H264) {
            this.observeVideoPacket(packet);
            // A CONFIG packet attests the current display rotation (issue #4786). Surface it before
            // the payload so the relay's rotation is current when the SPS/PPS reaches subscribers.
            if (packet.config && packet.rotation !== undefined) {
              this.options.onRotation?.(packet.rotation);
            }
            this.options.onData(packet.data);
          } else if (packet.codecId === VIDEO_SERVER_CODEC_ID_PCM16) {
            this.options.onAudioData?.(packet.data);
            this.resolveStartupAudioPacket?.(packet);
          }
        }
      },
    });
    let failed = false;
    const reportFailure = (error: Error): void => {
      if (failed || this.socket !== socket) {
        return;
      }
      failed = true;
      onSocketFailure(error);
    };
    socket.on("data", (chunk) => {
      try {
        parser.push(chunk);
      } catch (error) {
        // A bounded parse error (over-cap size/trackCount, i.e. a framing
        // desync) surfaces here instead of the parser buffering forever. Route
        // it through the same failure path as a socket error so the source
        // triggers its bounded reconnect/fallback.
        reportFailure(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", reportFailure);
    socket.on("close", () => reportFailure(new Error("video-server socket closed")));
  }

  private observeVideoPacket(packet: VideoServerPacket): void {
    if (packet.config) {
      return;
    }
    this.telemetryInitialized = true;
    if (packet.replayed) {
      // The cached IDR makes the replacement client decodable, but it was emitted
      // before this request. Preserve its timestamp only when no live observation
      // exists; it cannot complete a pending encoder IDR request or increment the
      // newly encoded access-unit counter.
      this.lastEncodedFrameTimestampUs ??= packet.ptsUs;
      if (packet.keyFrame) {
        this.lastIdrTimestampUs ??= packet.ptsUs;
      }
      return;
    }
    this.lastEncodedFrameTimestampUs = packet.ptsUs;
    this.encodedAccessUnitCount++;
    if (!packet.keyFrame) {
      return;
    }
    this.lastIdrTimestampUs = packet.ptsUs;
    if (this.pendingIdrRequests > 0) {
      this.pendingIdrRequests--;
      this.idrCompletionCount++;
    }
  }

  private reconnectSocket(failedSocket: StreamSocket, error: Error): void {
    if (!this.running || this.socket !== failedSocket || this.socketReconnectPromise !== null) {
      return;
    }
    this.socket = null;
    failedSocket.destroy();
    const controller = new AbortController();
    this.socketReconnectAbortController = controller;
    this.socketReconnectPromise = this.tryReconnectSocket(error, controller.signal).finally(() => {
      if (this.socketReconnectAbortController === controller) {
        this.socketReconnectAbortController = null;
      }
      this.socketReconnectPromise = null;
    });
  }

  private async tryReconnectSocket(initialError: Error, signal: AbortSignal): Promise<void> {
    const port = this.forwardedPort;
    if (port === null) {
      this.failIfRunning(initialError);
      return;
    }

    const deadline = this.timer.now() + this.localSocketReconnectWindowMs;
    let lastError = initialError;
    while (this.running && this.server !== null && !signal.aborted) {
      try {
        const socket = await this.connectBeforeDeadline(port, deadline, signal);
        if (!this.running || this.server === null || signal.aborted) {
          socket.destroy();
          return;
        }
        this.socket = socket;
        // The retained server requires the handshake on every accept, including reconnects.
        this.sendHandshake(socket);
        this.wireSocket(socket, (error) => this.reconnectSocket(socket, error));
        logger.info("[PersistentEncoderH264Source] reconnected to retained video-server socket");
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      const remainingMs = deadline - this.timer.now();
      if (remainingMs <= 0) {
        break;
      }
      await this.waitForReconnectRetry(
        Math.min(this.localSocketReconnectRetryMs, remainingMs),
        signal,
      );
    }

    this.failReconnectIfServerRetained(signal, lastError);
  }

  /**
   * Terminal decision for the socket-reconnect loop. A socket-only drop against a
   * still-retained server that never reconnects is fatal. But an aborted signal
   * (teardown) or a `null` server (the server process itself exited) means this
   * path does not own the outcome: teardown or the post-start relaunch path
   * (handlePostStartServerLoss) does, so it must not also fail the source.
   */
  private failReconnectIfServerRetained(signal: AbortSignal, lastError: Error): void {
    if (signal.aborted || this.server === null) {
      return;
    }
    this.failIfRunning(
      new Error(
        `video-server socket did not reconnect within ${this.localSocketReconnectWindowMs}ms: ${lastError.message}`,
      ),
    );
  }

  private waitForReconnectRetry(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) {
          return;
        }
        finished = true;
        this.timer.clearTimeout(timeout);
        signal.removeEventListener("abort", finish);
        resolve();
      };

      const timeout = this.timer.setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  private async connectBeforeDeadline(
    port: number,
    deadline: number,
    reconnectSignal: AbortSignal,
  ): Promise<StreamSocket> {
    const remainingMs = deadline - this.timer.now();
    if (remainingMs <= 0) {
      throw new Error("video-server socket reconnect deadline elapsed");
    }

    const controller = new AbortController();
    let timedOut = false;
    const abortForTeardown = (): void => controller.abort();
    if (reconnectSignal.aborted) {
      abortForTeardown();
    } else {
      reconnectSignal.addEventListener("abort", abortForTeardown, { once: true });
    }
    const connection = this.connector(port, controller.signal);
    const timeout = this.timer.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remainingMs);
    const timeoutFailure = new Promise<never>((_, reject) => {
      const rejectOnAbort = (): void =>
        reject(
          new Error(
            timedOut
              ? "video-server socket reconnect attempt timed out"
              : "video-server socket reconnect attempt aborted",
          ),
        );
      if (controller.signal.aborted) {
        rejectOnAbort();
      } else {
        controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
      }
    });

    try {
      return await Promise.race([connection, timeoutFailure]);
    } finally {
      this.timer.clearTimeout(timeout);
      reconnectSignal.removeEventListener("abort", abortForTeardown);
      if (controller.signal.aborted) {
        // A connector that ignored cancellation may still resolve. Do not leave
        // that late local socket open after either deadline or source teardown.
        void connection.then(
          (socket) => socket.destroy(),
          () => {},
        );
      }
    }
  }

  /**
   * Handle a post-start loss of the on-device server process. Instead of failing
   * the source immediately, attempt a bounded, backed-off relaunch of the server
   * (issue #4742); when the relaunch budget is spent, hand the stream to
   * screenrecord (or fail via `onError` when no fallback is wired). Re-entrant
   * losses while a relaunch is already in flight are ignored — the in-flight
   * recovery owns the lifecycle.
   */
  private handlePostStartServerLoss(error: Error): void {
    if (!this.running || this.relaunching) {
      return;
    }
    this.relaunching = true;
    this.relaunchAbortController = new AbortController();
    void this.recoverFromServerLoss(error).finally(() => {
      this.relaunching = false;
    });
  }

  private async recoverFromServerLoss(initialError: Error): Promise<void> {
    const signal = this.relaunchAbortController?.signal ?? new AbortController().signal;
    let lastError = initialError;
    while (this.canAttemptRelaunch(signal)) {
      this.serverRelaunchAttempts++;
      const outcome = await this.attemptRelaunch(this.serverRelaunchAttempts, lastError, signal);
      if (outcome.status !== "retry") {
        // "recovered" (streaming again) or "aborted" (stopped mid-relaunch):
        // either way the loop is done and no screenrecord fallback is warranted.
        return;
      }
      lastError = outcome.error;
    }
    if (this.running && !signal.aborted) {
      await this.fallBackAfterRelaunchExhausted(lastError);
    }
  }

  private canAttemptRelaunch(signal: AbortSignal): boolean {
    return (
      this.running &&
      !signal.aborted &&
      this.serverRelaunchAttempts < this.maxServerRelaunchAttempts
    );
  }

  /**
   * Run one relaunch attempt: back off, tear down the dead session, then launch a
   * fresh one. A fresh launch (rather than reusing the retained forward in place)
   * lets the launch-path reconcile sweep any orphan forward/lease the dead server
   * left behind — reuse-in-place is the optional optimization the issue defers.
   */
  private async attemptRelaunch(
    attempt: number,
    lastError: Error,
    signal: AbortSignal,
  ): Promise<{ status: "recovered" | "aborted" | "retry"; error: Error }> {
    const delayMs = this.serverRelaunchBackoff.delayForAttempt(attempt);
    logger.warn(
      `[PersistentEncoderH264Source] on-device server lost post-start (${lastError.message}); ` +
        `relaunch attempt ${attempt}/${this.maxServerRelaunchAttempts} after ${delayMs}ms`,
    );
    await this.delayBeforeRelaunch(delayMs, signal);
    if (!this.running || signal.aborted) {
      return { status: "aborted", error: lastError };
    }
    await this.beginTeardown();
    if (!this.running || signal.aborted) {
      return { status: "aborted", error: lastError };
    }
    try {
      await this.launch();
      if (!this.running) {
        return { status: "aborted", error: lastError };
      }
      logger.info(
        `[PersistentEncoderH264Source] on-device server relaunched after ${attempt} attempt(s)`,
      );
      return { status: "recovered", error: lastError };
    } catch (error) {
      const relaunchError = error instanceof Error ? error : new Error(String(error));
      logger.warn(
        `[PersistentEncoderH264Source] relaunch attempt ${attempt} failed: ${relaunchError.message}`,
        error,
      );
      return { status: "retry", error: relaunchError };
    }
  }

  /**
   * Wait for the backoff interval before the next relaunch, resolving early if
   * the source is torn down. Zero/negative delays resolve immediately so a
   * disabled backoff does not schedule a needless timer. Deterministic under
   * `FakeTimer`.
   */
  private delayBeforeRelaunch(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const finish = (): void => {
        this.timer.clearTimeout(handle);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const handle = this.timer.setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  /**
   * Relaunch budget spent: hand the stream to screenrecord via the injected
   * fallback (the same mechanism the initial-start path uses), or — when no
   * fallback is wired (e.g. the audio path) or the fallback itself fails —
   * surface the loss via `onError`.
   */
  private async fallBackAfterRelaunchExhausted(error: Error): Promise<void> {
    if (!this.running) {
      return;
    }
    const fallback = this.options.onScreenrecordFallback;
    if (!fallback) {
      this.failIfRunning(error);
      return;
    }
    logger.warn(
      `[PersistentEncoderH264Source] relaunch budget of ${this.maxServerRelaunchAttempts} spent; ` +
        `falling back to screenrecord: ${error.message}`,
    );
    // Stop feeding persistent data and release device resources, but do NOT fire
    // onError: the stream continues on the screenrecord source the fallback owns.
    this.running = false;
    await this.beginTeardown();
    try {
      await fallback(error);
    } catch (fallbackError) {
      this.options.onError?.(
        fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError)),
      );
    }
  }

  /** Surface a post-start fatal failure exactly once and stop feeding data. */
  private failIfRunning(error: Error): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    void this.beginTeardown();
    this.options.onError?.(error);
  }

  private beginTeardown(): Promise<void> {
    this.teardownPromise ??= this.teardown().finally(() => {
      this.teardownPromise = null;
    });
    return this.teardownPromise;
  }

  private async teardown(): Promise<void> {
    const reconnectAbortController = this.socketReconnectAbortController;
    this.socketReconnectAbortController = null;
    reconnectAbortController?.abort();

    const socket = this.socket;
    this.socket = null;
    socket?.destroy();

    const server = this.server;
    this.server = null;
    if (server) {
      this.detachServerOutputObserver(server);
    }
    // Terminating the host `adb shell` process closes the exec stream, which
    // stops the device-side server for THIS session. We deliberately do NOT run
    // a device-wide `pkill` (unlike the file-recording backend): it would also
    // kill a concurrent `videoRecording` on the same device.
    server?.kill("SIGINT");

    const session = this.session;
    const port = this.forwardedPort;
    const deviceProcessId = this.deviceProcessId;
    this.forwardedPort = null;
    this.deviceProcessId = null;
    this.session = null;
    if (session) {
      await this.cleanupOwnedSession(session, port, deviceProcessId);
      // Release the socket-name claim only after cleanup removed our forward, so
      // a sibling sweep cannot reclaim it during the stop()-during-spawn window.
      this.activeVideoSessionRegistry.remove(this.options.device.deviceId, session.socketName);
    } else if (port !== null) {
      logger.warn(
        `[PersistentEncoderH264Source] refusing forward cleanup port=${port}: session identity is unavailable`,
      );
    }
  }

  private async reconcileExpiredLeases(adb: ReturnType<AdbClientFactory["create"]>): Promise<void> {
    let leases: VideoServerLease[];
    try {
      const leaseListCommand =
        `for f in ${VIDEO_SERVER_LEASE_DIRECTORY}/*.json; do ` +
        '[ -f "$f" ] || continue; cat "$f"; printf "\\n"; done';
      const result = await this.withTimeout(
        adb.executeCommand(`shell sh -c ${shellQuote(leaseListCommand)}`),
        this.teardownTimeoutMs,
        "adb read video session leases",
      );
      leases = parseLeases(result.stdout);
    } catch (error) {
      logger.debug(`[PersistentEncoderH264Source] unable to read video session leases: ${error}`);
      return;
    }

    // Sweep corrupt/orphaned files regardless of how many leases parsed: a
    // wholly-unparseable directory yields zero leases but still needs cleanup.
    await this.sweepOrphanLeaseFiles(
      adb,
      new Set(leases.map((lease) => `${lease.socketName}.json`)),
    );

    // Sweep host forwards with no backing lease at all (device server
    // self-expired and deleted its own lease, or the daemon was SIGKILLed). Runs
    // regardless of lease count — the whole point is that the lease is gone.
    await this.sweepOrphanForwards(adb, new Set(leases.map((lease) => lease.socketName)));

    if (leases.length === 0) {
      return;
    }
    const deviceElapsedRealtimeMs = await this.readDeviceElapsedRealtimeMs(adb);
    if (deviceElapsedRealtimeMs === null) {
      logger.warn(
        "[PersistentEncoderH264Source] unable to read device uptime; skipping stale-session cleanup",
      );
      return;
    }

    for (const lease of leases) {
      const decision = this.classifyLeaseForReclaim(lease, deviceElapsedRealtimeMs);
      if (decision === null) {
        continue;
      }
      logger.info(
        `[PersistentEncoderH264Source] stale-session-cleanup socket=${lease.socketName} reason=${decision}`,
      );
      await this.removeForwardIfMatching(adb, lease.forwardPort, lease.socketName);
      await this.terminateProcessIfMatching(adb, lease);
      await this.removeLeaseIfMatching(adb, lease);
    }
  }

  /**
   * Decide whether a parsed lease should be reclaimed, returning a short reason
   * string when it should and `null` when it should be left alone.
   *
   * Precedence deliberately puts the reboot check FIRST: emulator serials are
   * port-based (`emulator-5554` -> `emulator-5556` across restarts), so a lease
   * written under a prior serial is on the SAME device filesystem and must not
   * be stranded. A negative elapsed-realtime age proves the lease predates the
   * current boot, which is safe to reclaim regardless of the recorded serial.
   * Only for leases NOT provably from a previous boot do we fall back to the
   * conservative same-serial staleness checks.
   */
  private classifyLeaseForReclaim(
    lease: VideoServerLease,
    deviceElapsedRealtimeMs: number,
  ): string | null {
    const elapsedRealtimeMs = lease.heartbeatElapsedRealtimeMs;
    if (elapsedRealtimeMs !== undefined && deviceElapsedRealtimeMs - elapsedRealtimeMs < 0) {
      // elapsedRealtime resets when Android reboots. A negative age therefore
      // proves this persisted lease belongs to a previous boot.
      return "previous-boot";
    }

    if (lease.deviceSerial !== this.options.device.deviceId) {
      // Same-boot lease under a different serial: too ambiguous to reclaim.
      return null;
    }

    if (elapsedRealtimeMs === undefined) {
      // Legacy/edge lease without the monotonic field. Fall back to the
      // always-written wall clock with a conservative multi-minute threshold so
      // the validator's tolerance and this loop stop disagreeing (issue #4783).
      const wallAgeMs = this.timer.now() - lease.heartbeatAtMs;
      return wallAgeMs >= STALE_LEASE_WALL_CLOCK_MS ? "wall-clock-stale" : null;
    }

    const ageMs = deviceElapsedRealtimeMs - elapsedRealtimeMs;
    return ageMs >= STALE_LEASE_MS ? "elapsed-stale" : null;
  }

  /**
   * Remove lease files that can never be reconciled through the normal path:
   * unparseable `*.json` (basename not among the parsed lease tokens) and
   * orphaned `*.json.tmp` files left by a SIGKILL between `writeText` and
   * `renameTo`. Only files older than `STALE_LEASE_FILE_SWEEP_MS` (by device
   * mtime) are swept, so a file mid-rename by a live server is left alone.
   */
  private async sweepOrphanLeaseFiles(
    adb: ReturnType<AdbClientFactory["create"]>,
    knownLeaseFileNames: ReadonlySet<string>,
  ): Promise<void> {
    let listing: { nowEpochMs: number | null; files: { name: string; mtimeMs: number }[] };
    try {
      const command =
        `printf 'NOW %s\\n' "$(date +%s)"; ` +
        `for f in ${VIDEO_SERVER_LEASE_DIRECTORY}/*.json ${VIDEO_SERVER_LEASE_DIRECTORY}/*.json.tmp; do ` +
        '[ -f "$f" ] || continue; stat -c \'%Y %n\' "$f"; done';
      const result = await this.withTimeout(
        adb.executeCommand(`shell sh -c ${shellQuote(command)}`),
        this.teardownTimeoutMs,
        "adb list stale video session lease files",
      );
      listing = parseLeaseFileListing(result.stdout);
    } catch (error) {
      logger.debug(
        `[PersistentEncoderH264Source] unable to list video session lease files: ${error}`,
      );
      return;
    }

    if (listing.nowEpochMs === null) {
      logger.debug(
        "[PersistentEncoderH264Source] lease-file sweep skipped: no device clock in listing",
      );
      return;
    }

    for (const file of listing.files) {
      const isTmp = file.name.endsWith(".json.tmp");
      // A parseable, known `*.json` lease is handled by the reconcile loop.
      if (!isTmp && knownLeaseFileNames.has(file.name)) {
        continue;
      }
      const ageMs = listing.nowEpochMs - file.mtimeMs;
      if (ageMs < STALE_LEASE_FILE_SWEEP_MS) {
        continue;
      }
      logger.info(
        `[PersistentEncoderH264Source] stale-lease-file-sweep name=${file.name} ageMs=${ageMs}`,
      );
      try {
        await this.withTimeout(
          adb.executeCommand(`shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/${file.name}`),
          this.teardownTimeoutMs,
          "adb remove stale video session lease file",
        );
      } catch (error) {
        logger.debug(
          `[PersistentEncoderH264Source] stale-lease-file sweep failed name=${file.name}: ${error}`,
        );
      }
    }
  }

  /**
   * Sweep host `adb forward` entries pointing at an `automobile_video_*` abstract
   * socket that have no backing lease and are not owned by a live/in-flight
   * session. This is the only path that can reclaim a forward whose lease is
   * already gone — the lease-driven loop above removes only forwards *named in*
   * lease files, so a self-expired server's forward (lease self-deleted) or a
   * SIGKILLed daemon's forward would otherwise leak until the adb server
   * restarts (issue #4753).
   *
   * `removeForwardIfMatching` re-verifies the port↔destination before removing,
   * so a port reused by an unrelated service is never touched.
   */
  private async sweepOrphanForwards(
    adb: ReturnType<AdbClientFactory["create"]>,
    leaseBackedSocketNames: ReadonlySet<string>,
  ): Promise<void> {
    let stdout: string;
    try {
      const listed = await this.withTimeout(
        adb.executeCommand("forward --list"),
        this.teardownTimeoutMs,
        "adb forward --list for orphan sweep",
      );
      stdout = listed.stdout;
    } catch (error) {
      logger.debug(
        `[PersistentEncoderH264Source] unable to list forwards for orphan sweep: ${error}`,
      );
      return;
    }

    const activeSocketNames = this.activeVideoSessionRegistry.active(this.options.device.deviceId);
    const orphans: { port: number; socketName: string }[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const forward = parseVideoForwardLine(line);
      if (forward === null) {
        continue;
      }
      // A lease-backed forward is reclaimed by the lease-driven loop; a forward
      // owned by a live/in-flight session (including this one) is not stranded.
      if (
        leaseBackedSocketNames.has(forward.socketName) ||
        activeSocketNames.has(forward.socketName)
      ) {
        continue;
      }
      orphans.push(forward);
    }

    for (const orphan of orphans) {
      logger.info(
        `[PersistentEncoderH264Source] orphan-forward-sweep port=${orphan.port} socket=${orphan.socketName}`,
      );
      await this.removeForwardIfMatching(adb, orphan.port, orphan.socketName);
    }
  }

  private async cleanupOwnedSession(
    session: VideoServerSession,
    port: number | null,
    expectedProcessId: number | null,
  ): Promise<void> {
    const adb = this.adbFactory.create(this.options.device);
    const lease = await this.readLease(adb, session.socketName);
    if (lease && this.isOwnedSessionLease(lease, session, expectedProcessId)) {
      await this.removeForwardIfMatching(adb, lease.forwardPort, lease.socketName);
      await this.removeOwnedForward(adb, port, session.socketName, lease.forwardPort);
      await this.terminateProcessIfMatching(adb, lease);
      await this.removeLeaseIfMatching(adb, lease);
      return;
    }
    if (lease) {
      logger.warn(
        `[PersistentEncoderH264Source] refusing owned-session process cleanup socket=${session.socketName}: lease identity or PID mismatch`,
      );
      await this.removeOwnedForward(adb, port, session.socketName);
      return;
    }
    await this.removeOwnedForward(adb, port, session.socketName);
  }

  private isOwnedSessionLease(
    lease: VideoServerLease,
    session: VideoServerSession,
    expectedProcessId: number | null,
  ): boolean {
    // A cancellation can arrive after the server persisted its lease but before
    // VIDEO_SESSION_READY handed its PID back to the host. The lease identity
    // plus terminateProcessIfMatching's argv check still make owned cleanup safe.
    // The token itself is no longer on disk (issue #4731), so ownership is confirmed by
    // re-hashing this session's token and matching the persisted hash.
    return (
      lease.sessionTokenHash === hashSessionToken(session.token) &&
      lease.socketName === session.socketName &&
      lease.ownerPid === session.ownerPid &&
      lease.deviceSerial === session.deviceSerial &&
      (expectedProcessId === null || lease.pid === expectedProcessId)
    );
  }

  private async removeOwnedForward(
    adb: ReturnType<AdbClientFactory["create"]>,
    port: number | null,
    socketName: string,
    exceptPort?: number,
  ): Promise<void> {
    if (port !== null && port !== exceptPort) {
      await this.removeForwardIfMatching(adb, port, socketName);
    }
  }

  private async readLease(
    adb: ReturnType<AdbClientFactory["create"]>,
    socketName: string,
  ): Promise<VideoServerLease | null> {
    try {
      const result = await this.withTimeout(
        adb.executeCommand(`shell cat ${VIDEO_SERVER_LEASE_DIRECTORY}/${socketName}.json`),
        this.teardownTimeoutMs,
        "adb read owned video session lease",
      );
      return parseLeases(result.stdout).find((lease) => lease.socketName === socketName) ?? null;
    } catch (error) {
      logger.debug(
        `[PersistentEncoderH264Source] unable to read owned video session lease: ${error}`,
      );
      return null;
    }
  }

  private async terminateProcessIfMatching(
    adb: ReturnType<AdbClientFactory["create"]>,
    lease: VideoServerLease,
  ): Promise<void> {
    try {
      const commandLine = await this.withTimeout(
        adb.executeCommand(`shell cat /proc/${lease.pid}/cmdline`),
        this.teardownTimeoutMs,
        "adb read video-server process cmdline",
      );
      const argv = commandLine.stdout.split("\u0000");
      // Match the non-secret `--socket-name` argv token, not `--session-token` (issue #4731): the
      // lease no longer carries the raw token, and the opaque socket name gives the same PID-reuse
      // protection — a recycled PID running something else will not carry our socket name.
      const ownsSession = argv.some(
        (argument, index) => argument === "--socket-name" && argv[index + 1] === lease.socketName,
      );
      if (!argv.includes(VIDEO_SERVER_MAIN_CLASS) || !ownsSession) {
        logger.warn(
          `[PersistentEncoderH264Source] refusing stale-session process cleanup socket=${lease.socketName}: PID/socket mismatch`,
        );
        return;
      }
      await this.withTimeout(
        adb.executeCommand(`shell kill -2 ${lease.pid}`),
        this.teardownTimeoutMs,
        "adb terminate video-server process",
      );
    } catch (error) {
      logger.debug(
        `[PersistentEncoderH264Source] stale-session process cleanup skipped socket=${lease.socketName}: ${error}`,
      );
    }
  }

  private async removeForwardIfMatching(
    adb: ReturnType<AdbClientFactory["create"]>,
    port: number,
    socketName: string,
  ): Promise<void> {
    try {
      const listed = await this.withTimeout(
        adb.executeCommand("forward --list"),
        this.teardownTimeoutMs,
        "adb forward --list",
      );
      const expectedPort = `tcp:${port}`;
      const expectedDestination = `localabstract:${socketName}`;
      const matches = listed.stdout.split(/\r?\n/).some((line) => {
        const fields = line.trim().split(/\s+/);
        return fields.includes(expectedPort) && fields.includes(expectedDestination);
      });
      if (!matches) {
        logger.warn(
          `[PersistentEncoderH264Source] refusing stale-session forward cleanup port=${port}: destination mismatch`,
        );
        return;
      }
      await this.withTimeout(
        adb.executeCommand(`forward --remove tcp:${port}`),
        this.teardownTimeoutMs,
        "adb forward --remove",
      );
    } catch (error) {
      logger.debug(`[PersistentEncoderH264Source] forward --remove failed: ${error}`);
    }
  }

  private async removeLeaseIfMatching(
    adb: ReturnType<AdbClientFactory["create"]>,
    lease: VideoServerLease,
  ): Promise<void> {
    const current = await this.readLease(adb, lease.socketName);
    if (
      current?.socketName !== lease.socketName ||
      current.sessionTokenHash !== lease.sessionTokenHash ||
      current.pid !== lease.pid
    ) {
      return;
    }
    try {
      await this.withTimeout(
        adb.executeCommand(`shell rm -f ${VIDEO_SERVER_LEASE_DIRECTORY}/${lease.socketName}.json`),
        this.teardownTimeoutMs,
        "adb remove video session lease",
      );
    } catch (error) {
      logger.debug(`[PersistentEncoderH264Source] stale-session lease cleanup failed: ${error}`);
    }
  }

  private attachServerOutputObserver(server: AdbProcess): void {
    this.serverOutputBuffer = "";
    this.sawStreamingStarted = false;
    const observer = (chunk: Buffer): void => {
      this.serverOutputBuffer += chunk.toString();
      const lines = this.serverOutputBuffer.split(/\r?\n/);
      this.serverOutputBuffer = lines.pop() ?? "";
      if (lines.includes(STREAMING_STARTED_MARKER)) {
        this.sawStreamingStarted = true;
      }
      for (const line of lines) {
        if (!line.startsWith("VIDEO_STATS ")) {
          continue;
        }
        const match = VIDEO_STATS_PATTERN.exec(line);
        const droppedFrames = match ? Number(match[1]) : NaN;
        if (Number.isSafeInteger(droppedFrames) && droppedFrames >= 0) {
          this.options.onDroppedFrames?.(droppedFrames);
        }
      }
    };
    this.serverOutputObserver = observer;
    server.stdout.on("data", observer);
  }

  private detachServerOutputObserver(server: AdbProcess): void {
    if (this.serverOutputObserver) {
      server.stdout.off("data", this.serverOutputObserver);
    }
    this.serverOutputObserver = null;
    this.serverOutputBuffer = "";
    this.sawStreamingStarted = false;
  }

  private async readDeviceElapsedRealtimeMs(
    adb: ReturnType<AdbClientFactory["create"]>,
  ): Promise<number | null> {
    try {
      const result = await this.withTimeout(
        adb.executeCommand("shell cat /proc/uptime"),
        this.teardownTimeoutMs,
        "adb read device uptime",
      );
      const uptimeSeconds = Number.parseFloat(result.stdout.trim().split(/\s+/, 1)[0] ?? "");
      if (Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0) {
        return Math.floor(uptimeSeconds * 1_000);
      }
    } catch (error) {
      logger.debug(`[PersistentEncoderH264Source] unable to read device uptime: ${error}`);
    }
    return null;
  }
}
