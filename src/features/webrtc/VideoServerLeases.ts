import { createHash } from "node:crypto";
import type { VideoSourceAdb, VideoSourceAdbFactory } from "./videoSourceAdb";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { type Timer } from "../../utils/SystemTimer";
import type {
  ActiveVideoSessionRegistry,
  PersistentEncoderH264SourceOptions,
  VideoServerSession,
} from "./PersistentEncoderH264Source";

/** Prefix for host-owned per-session LocalSocket names. */
export const VIDEO_SERVER_SOCKET_PREFIX = "automobile_video";

export const VIDEO_SERVER_MAIN_CLASS = "dev.jasonpearson.automobile.video.VideoServer";

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

/** Lowercase SHA-256 hex, the only token-derived value now persisted (issue #4731). */
function isSessionTokenHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Mirrors `VideoSessionArguments.SAFE_SOCKET_NAME` on the device side. */
export const SAFE_SOCKET_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasValidLeaseHeartbeat(elapsedRealtimeMs: unknown): boolean {
  return (
    elapsedRealtimeMs === undefined || (isFiniteNumber(elapsedRealtimeMs) && elapsedRealtimeMs >= 0)
  );
}

function isVideoServerLease(value: unknown): value is RawVideoServerLease {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!hasLeaseFields(value)) {
    return false;
  }
  const lease = value;
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
    hasValidLeaseHeartbeat(
      "heartbeatElapsedRealtimeMs" in lease ? lease.heartbeatElapsedRealtimeMs : undefined,
    ),
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
      // Interrupted writes can leave malformed leases; only validated identities may be reclaimed.
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
/** How lease teardown bounds each adb command. */
export interface VideoServerLeaseTeardown {
  timeoutMs: number;
  withTimeout: <T>(operation: Promise<T>, ms: number, label: string) => Promise<T>;
}

export class VideoServerLeases {
  private readonly teardownTimeoutMs: number;
  private readonly withTimeout: VideoServerLeaseTeardown["withTimeout"];

  private readonly activeVideoSessionRegistry: ActiveVideoSessionRegistry;

  constructor(
    private readonly options: PersistentEncoderH264SourceOptions,
    private readonly adbFactory: VideoSourceAdbFactory,
    private readonly timer: Timer,
    {
      activeVideoSessionRegistry,
      teardown,
    }: {
      activeVideoSessionRegistry: ActiveVideoSessionRegistry;
      teardown: VideoServerLeaseTeardown;
    },
  ) {
    this.activeVideoSessionRegistry = activeVideoSessionRegistry;
    this.teardownTimeoutMs = teardown.timeoutMs;
    this.withTimeout = teardown.withTimeout;
  }

  async reconcileExpiredLeases(adb: VideoSourceAdb): Promise<void> {
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
      // The lease directory may not exist before the first capture; cleanup is best effort.
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
    adb: VideoSourceAdb,
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
      // Lease files can disappear during concurrent cleanup; a later sweep can retry.
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
        // Lease files can disappear during concurrent cleanup; a later sweep can retry.
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
    adb: VideoSourceAdb,
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
      // ADB may be unavailable during best-effort orphan cleanup; a later sweep can retry.
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

  async cleanupOwnedSession(
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
    adb: VideoSourceAdb,
    port: number | null,
    socketName: string,
    exceptPort?: number,
  ): Promise<void> {
    if (port !== null && port !== exceptPort) {
      await this.removeForwardIfMatching(adb, port, socketName);
    }
  }

  private async readLease(
    adb: VideoSourceAdb,
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
      // A session may already have expired and removed its lease.
      logger.debug(
        `[PersistentEncoderH264Source] unable to read owned video session lease: ${error}`,
      );
      return null;
    }
  }

  private async terminateProcessIfMatching(
    adb: VideoSourceAdb,
    lease: VideoServerLease,
  ): Promise<void> {
    try {
      const commandLine = await this.withTimeout(
        adb.executeCommand(`shell cat /proc/${lease.pid}/cmdline`),
        this.teardownTimeoutMs,
        "adb read video-server process cmdline",
      );
      const argv = commandLine.stdout.split("\u0000");
      if (commandLine.stdout.length === 0 || argv.every((argument) => argument.length === 0)) {
        // An exited process needs no signal; forward and lease cleanup can safely continue.
        logger.debug(
          `[PersistentEncoderH264Source] stale-session process cleanup skipped socket=${lease.socketName}: process already exited`,
        );
        return;
      }
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
      // The server may already have exited while its stale lease was being reclaimed.
      logger.debug(
        `[PersistentEncoderH264Source] stale-session process cleanup skipped socket=${lease.socketName}: ${error}`,
      );
    }
  }

  async removeForwardIfMatching(
    adb: VideoSourceAdb,
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
      // A sibling teardown may already have removed the owned forward.
      logger.debug(`[PersistentEncoderH264Source] forward --remove failed: ${error}`);
    }
  }

  private async removeLeaseIfMatching(adb: VideoSourceAdb, lease: VideoServerLease): Promise<void> {
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
      // The device or another teardown may already have removed the lease.
      logger.debug(`[PersistentEncoderH264Source] stale-session lease cleanup failed: ${error}`);
    }
  }

  private async readDeviceElapsedRealtimeMs(adb: VideoSourceAdb): Promise<number | null> {
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
      // Uptime is an optional reclaim probe; an unavailable value must skip reclamation.
      logger.debug(`[PersistentEncoderH264Source] unable to read device uptime: ${error}`);
    }
    return null;
  }
}

function hasLeaseFields(value: object): value is {
  sessionTokenHash: unknown;
  socketName: unknown;
  deviceSerial: unknown;
  ownerPid: unknown;
  pid: unknown;
  forwardPort: unknown;
  startedAtMs: unknown;
  heartbeatAtMs: unknown;
} {
  if (
    !(
      "sessionTokenHash" in value &&
      "socketName" in value &&
      "deviceSerial" in value &&
      "ownerPid" in value &&
      "pid" in value &&
      "forwardPort" in value &&
      "startedAtMs" in value &&
      "heartbeatAtMs" in value
    )
  ) {
    return false;
  }
  return true;
}
