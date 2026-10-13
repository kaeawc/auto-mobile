import { ActionableError } from "../../models/ActionableError";

const NEWLINE = 0x0a;

/*
 * Inbound frame limits (bytes of one frame, newline excluded). Audit of every
 * server on a `BaseSocketServer` and the largest frame a legitimate client sends:
 *
 * | Server (file)                              | Limit   | Largest legitimate inbound frame                                   |
 * | ------------------------------------------ | ------- | ------------------------------------------------------------------ |
 * | Control socket (`socketServer.ts`)         | 256 MiB | `tools/call` carrying `putAppFile`/fixture `contentBase64`; no tool |
 * |                                            |         | caps it, so it matches the 256 MiB HTTP body cap. Plan YAML and    |
 * |                                            |         | prototype asset bytes are far smaller (prototype assets never cross    |
 * |                                            |         | this socket; the daemon sends them to the device).                 |
 * | FailuresStream (`failuresStreamSocket...`) | 8 MiB   | `acknowledge` with `notificationIds`: unbounded by the protocol    |
 * |                                            |         | (polls return at most 500 ids, ~6 KB); 8 MiB holds ~800k ids.      |
 * | VideoStream (`videoStreamSocketServer.ts`) | 1 MiB   | one subscribe line (~200 B); later lines are ignored               |
 * | WebRtcStream (`webrtcStreamSocketServer`)  | 1 MiB   | start with `iceServers` + WHIP endpoint/token (a few KB)           |
 * | DeviceGestureRecording (`deviceGestureRecordingSocket...`)   | 1 MiB   | command + ids/plan name (<1 KB); plan YAML is only in responses    |
 * | PerformanceStream, Appearance              | 1 MiB   | scalar query / toggle request (<1 KB)                              |
 * | DeviceSnapshot, VideoRecording (config)    | 1 MiB   | `config/set` of scalar settings (<1 KB)                            |
 * | DeviceDataStream, FailuresPush,            | 1 MiB   | subscribe / unsubscribe / pong / cadence / storage-subscribe       |
 * | PerformancePush, TelemetryPush (push)      |         | commands with string ids and filters (<1 KB)                       |
 *
 * | Client inbound                           | Limit   | Largest legitimate answer                                         |
 * | ---------------------------------------- | ------- | ----------------------------------------------------------------- |
 * | DaemonClient (`client.ts`)                | 256 MiB | app/shared-storage reads (~86 MiB base64), video (~134 MiB default), screenshots/hierarchies (a few MiB) |
 * | Lease owner (`deviceLeaseOwnerQuery.ts`)  | 1 MiB   | scalar lease status/relinquish envelope (<1 KB)                     |
 * | Prototype agent (`prototypeAgentClient.ts`) | 8 MiB | 1 MiB state x2 slash escaping; change copies total ~4 MiB, multi-key test-hook keys ~6 MiB |
 * | WebRTC control (`webrtcStreamClient.ts`)  | 1 MiB   | stream descriptors/ICE settings (a few KB per device; no media)     |
 */

/**
 * Largest single inbound frame the control socket accepts. It matches the
 * loopback HTTP body cap in `daemon.ts` (`HTTP_BODY_MAX_BYTES`): a request that
 * the HTTP hop admits must also be admissible as one socket frame, so neither
 * transport accepts a payload the other refuses. Unlike the outbound queue bound
 * (#6508, which always admits one whole frame) this is a hard per-frame ceiling,
 * because an inbound peer controls the frame size.
 */
export const CONTROL_SOCKET_MAX_FRAME_BYTES = 256 * 1024 * 1024;

/**
 * Default inbound frame limit for auxiliary sockets, which only receive small
 * commands (see the table above). A server whose legitimate frames can approach
 * this overrides `maxFrameBytes` with its own justified constant.
 */
export const AUX_SOCKET_MAX_FRAME_BYTES = 1024 * 1024;

/**
 * Symmetric with the control socket's 256 MiB limit. App-file reads in
 * `src/server/appFileService.ts` cap raw files at 64 MiB (ANDROID_APP_FILE_MAX_BUFFER
 * and the stats.size check); `src/server/sharedStorageReadService.ts` also uses
 * SHARED_STORAGE_MAX_BUFFER = 64 MiB (~86 MiB base64). Whole-file video blobs in
 * `src/server/videoRecordingResources.ts` use a default 100 MiB archive budget in
 * `src/features/video/VideoRecorderService.ts` (~134 MiB base64). Screenshots are
 * uncapped but ordinarily a few MiB, as are observe hierarchies. The limit admits
 * these ordinary answers while bounding oversized/configured-larger output.
 */
export const DAEMON_CLIENT_MAX_FRAME_BYTES = CONTROL_SOCKET_MAX_FRAME_BYTES;

/**
 * Lease-owner status/relinquish answers contain scalar fields (<1 KB);
 * `webrtcStreamSocketServer.ts` answers with descriptors/ICE settings (a few KB
 * per device), never video bytes. The auxiliary 1 MiB budget leaves ample room.
 */
export const DAEMON_ONESHOT_CLIENT_MAX_FRAME_BYTES = AUX_SOCKET_MAX_FRAME_BYTES;

/** Client-local transport failure: retrying could repeat an already executed tool. */
export class DaemonFrameTooLargeError extends ActionableError {
  constructor(readonly limitBytes: number) {
    super(`Daemon response frame exceeded ${limitBytes} bytes; the daemon connection was closed.`);
    this.name = "DaemonFrameTooLargeError";
  }
}

/** `acknowledge` carries an id list the protocol does not bound; see the table above. */
export const FAILURES_STREAM_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface LineFramerHandlers {
  /** One complete frame, without its trailing newline. May be empty. */
  onLine(line: string): void;
  /** Called once with at most 256 copied head bytes on overflow; all later input is discarded. */
  onOverflow(frameHead?: Buffer): void;
}

/**
 * Splits an inbound byte stream into newline-delimited frames.
 *
 * Work is linear in the bytes received: only the newly arrived chunk is scanned
 * for the delimiter, a partial frame is kept as a list of chunks with a running
 * byte count (never re-concatenated per chunk), and the frame is joined and
 * decoded once when its newline arrives. Decoding the joined bytes, rather than
 * each chunk, keeps a multi-byte UTF-8 sequence that straddles two reads intact
 * (0x0A never occurs inside a multi-byte sequence).
 *
 * A frame larger than `maxFrameBytes` (newline excluded) triggers `onOverflow`
 * once. The pending bytes are dropped and every later byte is ignored, so a peer
 * that never sends a newline cannot grow memory.
 */
export class LineFramer {
  /** Number of delimiter scans performed (one per frame boundary or chunk tail). */
  scanCount = 0;
  /** Total bytes examined by delimiter scans; equals bytes received when work is linear. */
  scannedBytes = 0;

  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private overflowed = false;

  constructor(
    private readonly maxFrameBytes: number,
    private readonly handlers: LineFramerHandlers,
  ) {}

  get hasOverflowed(): boolean {
    return this.overflowed;
  }

  push(data: Buffer | string): void {
    if (this.overflowed) {
      return;
    }
    const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      this.scanCount++;
      if (newline === -1) {
        this.scannedBytes += chunk.length - start;
        this.appendPending(chunk.subarray(start));
        return;
      }
      this.scannedBytes += newline - start;
      if (!this.completeFrame(chunk.subarray(start, newline))) {
        return;
      }
      start = newline + 1;
    }
  }

  private appendPending(piece: Buffer): void {
    if (this.pendingBytes + piece.length > this.maxFrameBytes) {
      this.overflow(piece);
      return;
    }
    this.pendingBytes += piece.length;
    this.pending.push(piece);
  }

  /** Emit the frame ending at a newline. Returns false when it overflowed. */
  private completeFrame(tail: Buffer): boolean {
    const frameBytes = this.pendingBytes + tail.length;
    if (frameBytes > this.maxFrameBytes) {
      this.overflow(tail);
      return false;
    }
    const frame =
      this.pending.length === 0 ? tail : Buffer.concat([...this.pending, tail], frameBytes);
    this.pending = [];
    this.pendingBytes = 0;
    this.handlers.onLine(frame.toString("utf8"));
    return true;
  }

  private overflow(tail: Buffer): void {
    // Only the bounded head is copied; it must not retain an oversized input buffer.
    const head = Buffer.allocUnsafe(Math.min(256, this.pendingBytes + tail.length));
    let offset = 0;
    for (const piece of this.pending) {
      offset += piece.copy(head, offset, 0, head.length - offset);
      if (offset === head.length) {
        break;
      }
    }
    tail.copy(head, offset, 0, head.length - offset);
    this.overflowed = true;
    this.pending = [];
    this.pendingBytes = 0;
    this.handlers.onOverflow(head);
  }
}
