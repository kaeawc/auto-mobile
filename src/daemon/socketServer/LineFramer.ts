const NEWLINE = 0x0a;

/*
 * Inbound frame limits (bytes of one frame, newline excluded). Audit of every
 * server on a `BaseSocketServer` and the largest frame a legitimate client sends:
 *
 * | Server (file)                              | Limit   | Largest legitimate inbound frame                                   |
 * | ------------------------------------------ | ------- | ------------------------------------------------------------------ |
 * | Control socket (`socketServer.ts`)         | 256 MiB | `tools/call` carrying `putAppFile`/fixture `contentBase64`; no tool |
 * |                                            |         | caps it, so it matches the 256 MiB HTTP body cap. Plan YAML and    |
 * |                                            |         | overlay asset bytes are far smaller (overlay assets never cross    |
 * |                                            |         | this socket; the daemon sends them to the device).                 |
 * | FailuresStream (`failuresStreamSocket...`) | 8 MiB   | `acknowledge` with `notificationIds`: unbounded by the protocol    |
 * |                                            |         | (polls return at most 500 ids, ~6 KB); 8 MiB holds ~800k ids.      |
 * | VideoStream (`videoStreamSocketServer.ts`) | 1 MiB   | one subscribe line (~200 B); later lines are ignored               |
 * | WebRtcStream (`webrtcStreamSocketServer`)  | 1 MiB   | start with `iceServers` + WHIP endpoint/token (a few KB)           |
 * | TestRecording (`testRecordingSocket...`)   | 1 MiB   | command + ids/plan name (<1 KB); plan YAML is only in responses    |
 * | PerformanceStream, Appearance              | 1 MiB   | scalar query / toggle request (<1 KB)                              |
 * | DeviceSnapshot, VideoRecording (config)    | 1 MiB   | `config/set` of scalar settings (<1 KB)                            |
 * | DeviceDataStream, FailuresPush,            | 1 MiB   | subscribe / unsubscribe / pong / cadence / storage-subscribe       |
 * | PerformancePush, TelemetryPush (push)      |         | commands with string ids and filters (<1 KB)                       |
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

/** `acknowledge` carries an id list the protocol does not bound; see the table above. */
export const FAILURES_STREAM_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface LineFramerHandlers {
  /** One complete frame, without its trailing newline. May be empty. */
  onLine(line: string): void;
  /** The pending frame exceeded the limit. Called once; the framer then discards all input. */
  onOverflow(): void;
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
    this.pendingBytes += piece.length;
    if (this.pendingBytes > this.maxFrameBytes) {
      this.overflow();
      return;
    }
    this.pending.push(piece);
  }

  /** Emit the frame ending at a newline. Returns false when it overflowed. */
  private completeFrame(tail: Buffer): boolean {
    const frameBytes = this.pendingBytes + tail.length;
    if (frameBytes > this.maxFrameBytes) {
      this.overflow();
      return false;
    }
    const frame =
      this.pending.length === 0 ? tail : Buffer.concat([...this.pending, tail], frameBytes);
    this.pending = [];
    this.pendingBytes = 0;
    this.handlers.onLine(frame.toString("utf8"));
    return true;
  }

  private overflow(): void {
    this.overflowed = true;
    this.pending = [];
    this.pendingBytes = 0;
    this.handlers.onOverflow();
  }
}
