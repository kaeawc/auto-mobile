/**
 * Decoder for the iOS screen-capture-helper wire protocol.
 *
 * Header (16 bytes, little-endian UInt32):
 *   width(4) | height(4) | bytesPerRow(4) | timestampMs(4)
 *
 * Followed by `height * bytesPerRow` bytes of BGRA pixel data. Audio records
 * reserve width=0: height=8000, bytesPerRow=1, timestampMs=payload length,
 * followed by 8 kHz mono PCM16LE bytes.
 *
 * The decoder buffers incoming chunks and emits complete frames as soon as
 * enough bytes have arrived. It tolerates arbitrary chunking from the helper's
 * stdout pipe.
 *
 * Corrupt headers are the interesting case. A corrupt header carries no usable
 * payload length, so the decoder cannot know where the damaged frame ends.
 * Skipping only the 16 header bytes would walk the payload as if it were a
 * sequence of headers, amplifying one bad frame on the wire into thousands of
 * downstream callbacks. Instead the decoder enters a resynchronizing state:
 * it reports the corruption exactly once, then scans forward byte by byte for
 * the next structurally plausible header and resumes there.
 *
 * Structural plausibility is not enough on its own. The payload is BGRA pixel
 * data, so its bytes reflect what is on the captured screen — a byte sequence
 * someone can influence. Probability bounds ("a random offset parses as a
 * header only once in 2^38") say nothing about chosen bytes: a payload can
 * simply contain two header-shaped ranges spaced by the first one's declared
 * payload length, and structural corroboration accepts it. So resync is also
 * bounded by the stream's own geometry, which the decoder cannot be talked out
 * of: see `admissible()`.
 *
 * What that does *not* close: chosen pixels at the geometry the stream is
 * already using. Nothing in the wire format distinguishes a crafted byte
 * sequence from a genuine one — there is no sync marker and no checksum — so
 * only a format change could. It is a much smaller residual: the dimensions
 * the encoder configures on can no longer be influenced, and whoever can choose
 * payload pixels is already drawing on the screen being captured.
 */

export const FRAME_HEADER_SIZE = 16;

/**
 * Structural bounds used to decide whether 16 bytes are a plausible header.
 * These are not protocol limits — they are the sanity envelope that makes
 * resynchronization reliable. Without them roughly one in eight arbitrary
 * offsets in a payload satisfies the header rules, so a forward scan would
 * re-lock onto garbage almost immediately.
 */
/** Largest plausible display dimension, in pixels. */
const MAX_FRAME_DIMENSION = 16_384;
/**
 * Largest row padding accepted beyond the visible `width * 4` BGRA bytes.
 * `CVPixelBufferGetBytesPerRow` aligns rows to a small boundary (real captures
 * observed at exactly `width * 4`), so a full page of slack is generous. This
 * is the constraint that does most of the work during resynchronization: it
 * ties two of the four header words together, which arbitrary payload bytes
 * almost never satisfy.
 */
const MAX_ROW_PADDING_BYTES = 4096;
/** Largest plausible single-frame pixel payload (256 MiB). */
const MAX_FRAME_PAYLOAD_BYTES = 256 * 1024 * 1024;
/** Largest plausible audio record (16 MiB ≈ 17 minutes of 8 kHz PCM16LE). */
const MAX_AUDIO_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface FrameHeader {
  width: number;
  height: number;
  bytesPerRow: number;
  timestampMs: number;
}

export interface DecodedFrame {
  header: FrameHeader;
  pixels: Buffer;
}

export interface DecodedAudio {
  pcm16le: Buffer;
}

type MalformedFrameReason =
  | "header_width_zero"
  | "header_height_zero"
  | "header_bytes_per_row_too_small"
  | "header_bytes_per_row_too_large"
  | "header_dimensions_out_of_range"
  | "header_payload_too_large"
  | "audio_payload_too_large";

export interface MalformedFrameError {
  reason: MalformedFrameReason;
  header: FrameHeader;
}

/**
 * Result of walking past a run of audio records to the next video boundary.
 * `unsettled` carries `at`, the furthest offset the walk reached before running
 * out of bytes, so the next chunk resumes from there instead of restarting.
 */
type AudioSkip =
  | { kind: "video"; header: FrameHeader }
  | { kind: "unsettled"; at: number }
  | { kind: "reject" };

/** A resync candidate awaiting corroboration, with its audio-skip resume point. */
interface Candidate {
  offset: number;
  resumeAt: number;
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private pendingHeader: FrameHeader | null = null;
  /**
   * True while the decoder has lost frame alignment and is scanning for the
   * next plausible header. Malformed callbacks are suppressed in this state so
   * one corrupt frame produces one report, not one per 16 discarded bytes.
   */
  private resynchronizing: boolean = false;
  /**
   * Candidates into `buffer`, ascending by `offset`, whose corroboration is
   * still pending because the bytes that would settle them have not arrived.
   * These are the only already-examined offsets a later chunk can change the
   * verdict of. `resumeAt` carries how far the audio-skip walk to this
   * candidate's successor has already progressed, so re-asking it after each
   * chunk parses only the newly arrived records rather than re-walking a
   * growing audio run from the start — the difference between linear and
   * quadratic when a recovered frame is followed by a long audio-only gap.
   */
  private unsettled: Candidate[] = [];
  /**
   * How many leading bytes of `buffer` the forward scan has already examined.
   * Offsets below this are settled for good: a 16-byte window is immutable once
   * buffered, so an implausible header stays implausible, and a candidate
   * rejected by its successor stays rejected. Carrying this cursor across
   * pushes is what keeps resynchronization linear in the bytes received rather
   * than re-parsing the whole retained buffer on every chunk.
   */
  private scanned: number = 0;
  /**
   * Geometry of the most recently decoded frame — the geometry this stream is
   * using. Resync is locked to it, so the point where the decoder re-enters
   * synchronized decoding can never be a frame of a size the stream was not
   * already producing, however many header-shaped ranges a damaged payload
   * contains.
   *
   * That bounds the resync *boundary*, which is what the fabrication cases
   * exploited; it is not a guarantee that no chosen-size frame can ever be
   * emitted. The synchronized path deliberately does not consult the anchor,
   * because a genuine mid-stream reconfigure has to be honored, so an attacker
   * who can supply a long enough run of chosen bytes still gets there
   * eventually. Only a wire-format marker closes that — see #4270.
   */
  private anchor: FrameHeader | null = null;

  /**
   * Append bytes from the helper's stdout stream and return any frames that
   * have completed. A malformed header is surfaced via `onMalformed` exactly
   * once; the decoder then discards bytes until it finds the next plausible
   * header and resumes decoding there.
   */
  push(
    chunk: Buffer,
    onMalformed?: (error: MalformedFrameError) => void,
    onAudio?: (audio: DecodedAudio) => void
  ): DecodedFrame[] {
    if (chunk.length > 0) {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    }

    const frames: DecodedFrame[] = [];

    while (true) {
      if (this.resynchronizing && !this.resynchronize()) {break;}

      if (this.pendingHeader === null) {
        const outcome = this.takeHeader(onMalformed);
        if (outcome === "starved") {break;}
        if (outcome === "malformed") {continue;}
        this.pendingHeader = outcome;
      }

      const pending = this.pendingHeader;
      const expected = payloadSize(pending);
      if (this.buffer.length < expected) {break;}

      // Copy pixels to release the underlying chunk allocation; otherwise
      // every emitted frame pins the entire upstream buffer in memory.
      const payload = Buffer.from(this.buffer.subarray(0, expected));
      this.buffer = this.buffer.subarray(expected);
      if (isAudioHeader(pending)) {
        onAudio?.({ pcm16le: payload });
      } else {
        frames.push({ header: pending, pixels: payload });
        this.anchor = pending;
      }
      this.pendingHeader = null;
    }

    return frames;
  }

  /**
   * Consume the next header from the front of the buffer. On a malformed
   * header the bytes are deliberately left in place — the decoder switches to
   * resynchronizing and the forward scan steps past them itself — and the
   * corruption is reported once.
   */
  private takeHeader(
    onMalformed?: (error: MalformedFrameError) => void
  ): FrameHeader | "starved" | "malformed" {
    if (this.buffer.length < FRAME_HEADER_SIZE) {return "starved";}
    const header = parseHeader(this.buffer, 0);
    const malformed = headerError(header);
    if (malformed) {
      this.resynchronizing = true;
      this.resetScan();
      onMalformed?.({ reason: malformed, header });
      return "malformed";
    }
    this.buffer = this.buffer.subarray(FRAME_HEADER_SIZE);
    return header;
  }

  /**
   * Scan forward for the next frame boundary. Returns true when alignment is
   * recovered (the buffer now starts at that header), false when the buffered
   * bytes do not yet settle the question — in which case bytes that can no
   * longer contain a boundary are discarded and the scan resumes on the next
   * chunk.
   *
   * A structurally valid header alone is not enough: payload bytes shifted by
   * one can spell a perfectly plausible header. Each candidate is corroborated
   * by checking that whatever follows its payload is itself a valid header (or
   * that the payload runs exactly to the end of what has arrived).
   *
   * Each byte offset is examined exactly once across the whole resynchronization,
   * not once per chunk. Only offsets still awaiting corroboration are re-asked,
   * and there are almost never more than one of those: post-validation a random
   * offset is a plausible header with probability ~2^-38.
   */
  private resynchronize(): boolean {
    const pending: Candidate[] = [];
    // Ascending offset order overall — every retained candidate sits below the
    // scan cursor, every newly examinable offset at or above it — so this still
    // accepts the lowest-offset candidate that corroborates, as a single
    // whole-buffer pass did. Retained candidates resume their audio-skip walk
    // where it stopped; fresh offsets start it at their payload's end.
    let accepted = this.rescan(this.unsettled, pending);
    if (accepted < 0) {
      // Every retained candidate has already confirmed contiguous audio out to
      // its `resumeAt`; a fresh audio offset below that high-water mark is in
      // the same run and settles identically, so it need not be retained as its
      // own candidate. Without this, a run of N audio records arriving one per
      // chunk retains N equivalent candidates and re-walks them, O(N²) — the
      // exact shape resync exists to avoid.
      const coveredTo = pending.reduce((max, c) => Math.max(max, c.resumeAt), 0);
      accepted = this.scanFresh(
        range(this.scanned, this.buffer.length - FRAME_HEADER_SIZE),
        pending,
        coveredTo
      );
    }

    if (accepted >= 0) {
      this.buffer = this.buffer.subarray(accepted);
      this.resetScan();
      this.resynchronizing = false;
      return true;
    }

    // A corroborated candidate outranks an earlier unproven one — payload
    // bytes one byte before a real boundary can spell a valid header, and only
    // corroboration tells the two apart. So the scan runs to the end before
    // falling back to the earliest candidate more bytes could still confirm;
    // failing that, keep only what could be a header straddling the chunk
    // boundary.
    this.scanned = Math.max(this.scanned, this.buffer.length - FRAME_HEADER_SIZE + 1, 0);
    this.unsettled = pending;
    this.discardSettledPrefix();
    return false;
  }

  /**
   * Re-examine already-retained candidates, resuming each one's audio-skip walk
   * from where it stopped so a growing audio run is never re-walked from the
   * start. Returns the first offset that corroborates, or -1; survivors are
   * appended to `pending` with their advanced resume point.
   */
  private rescan(candidates: Candidate[], pending: Candidate[]): number {
    for (const candidate of candidates) {
      const header = parseHeader(this.buffer, candidate.offset);
      const verdict = this.corroborate(header, candidate.resumeAt);
      if (verdict.kind === "accept") {return candidate.offset;}
      if (verdict.kind === "unsettled") {
        candidate.resumeAt = verdict.resumeAt;
        pending.push(candidate);
      }
    }
    return -1;
  }

  /**
   * Examine fresh byte offsets in order, returning the first that corroborates,
   * or -1. Offsets whose verdict more bytes could still change are appended to
   * `pending`; settled ones are dropped and never looked at again.
   */
  private scanFresh(offsets: Iterable<number>, pending: Candidate[], coveredTo: number): number {
    for (const offset of offsets) {
      const header = parseHeader(this.buffer, offset);
      if (headerError(header) !== null) {continue;}
      if (!this.admissible(header)) {continue;}
      // Subsumed by an already-retained candidate's confirmed audio run: it
      // skips to the same handoff and would settle identically, so retaining it
      // separately only multiplies the re-walk. Video candidates are never
      // skipped this way — a differently-anchored video inside the run is a
      // reject the retained candidate already accounts for.
      if (isAudioHeader(header) && offset < coveredTo) {continue;}
      const from = offset + FRAME_HEADER_SIZE + payloadSize(header);
      const verdict = this.corroborate(header, from);
      if (verdict.kind === "accept") {return offset;}
      if (verdict.kind === "unsettled") {
        pending.push({ offset, resumeAt: verdict.resumeAt });
        coveredTo = Math.max(coveredTo, verdict.resumeAt);
      }
    }
    return -1;
  }

  /**
   * Drop the leading bytes that can no longer begin a frame, rebasing the scan
   * cursor and the retained candidates onto the shortened buffer.
   */
  private discardSettledPrefix(): void {
    const keepFrom =
      this.unsettled.length > 0
        ? this.unsettled[0].offset
        : Math.max(0, this.buffer.length - (FRAME_HEADER_SIZE - 1));
    if (keepFrom === 0) {return;}
    // Copy so the discarded chunk allocation can be freed.
    this.buffer = Buffer.from(this.buffer.subarray(keepFrom));
    this.unsettled = this.unsettled.map(candidate => ({
      offset: candidate.offset - keepFrom,
      resumeAt: candidate.resumeAt - keepFrom,
    }));
    this.scanned = Math.max(0, this.scanned - keepFrom);
  }

  private resetScan(): void {
    this.unsettled = [];
    this.scanned = 0;
  }

  /**
   * Decide whether a candidate header at `offset` really is a frame boundary.
   * The only evidence accepted is a valid header sitting exactly where this
   * candidate's payload ends.
   *
   * Deliberately *not* evidence: the payload ending at the end of the buffer.
   * stdout splits wherever the pipe happens to flush, so a chunk boundary says
   * nothing about frame boundaries — trusting it lets payload bytes that spell
   * a plausible header be emitted as a fabricated frame, which would feed
   * garbage dimensions to the encoder downstream. Waiting costs one chunk of
   * latency, once, on a path that is already degraded.
   *
   * The converse case is a real trade-off: when a recovered frame is followed
   * immediately by a *second* corrupt header, that frame is rejected and
   * dropped even though it was genuine. Accepting it would mean accepting any
   * candidate whose successor is invalid — the exact rule that fabricates
   * frames out of payload bytes. One dropped frame during back-to-back
   * corruption is the cheaper error.
   *
   * "unsettled" means the buffered bytes cannot answer yet; the caller keeps
   * the candidate and re-asks once more data arrives. Retention is bounded by
   * the same payload ceiling that bounds normal decoding.
   */
  private corroborate(
    header: FrameHeader,
    from: number
  ): { kind: "accept" | "reject" } | { kind: "unsettled"; resumeAt: number } {
    // Walk from `from` (a candidate's payload end, or where its earlier walk
    // stopped) to the first *video* header, stepping over self-describing audio
    // records on the way. That video header is where resync hands control back
    // to the synchronized path, which emits video frames without consulting the
    // anchor — so it is the boundary that must match, not merely whatever record
    // sits physically next to the candidate. `SimulatorCaptureSession` writes
    // screen and audio to one queue, so an audio record routinely lands between
    // two video frames; stopping at that audio would either stall recovery on
    // every real stream, or — worse — accept the candidate and hand the
    // unchecked video *after* the audio, of any geometry, straight to the
    // encoder.
    const handoff = this.skipAudio(from);
    if (handoff.kind === "reject") {return { kind: "reject" };}
    if (handoff.kind === "unsettled") {return { kind: "unsettled", resumeAt: handoff.at };}
    // `handoff.header` is the video header resync would hand back at. It must
    // belong to the same stream — before the first frame decodes there is no
    // anchor and whatever arrives first defines the geometry (admissible()
    // allows it), so the candidate and this successor must simply agree.
    if (!this.admissible(handoff.header)) {return { kind: "reject" };}
    // An audio candidate carries no geometry of its own, so a corroborating
    // video handoff is all it needs — that keeps a valid audio record that
    // lands right after a corrupt frame decodable, rather than dropped.
    if (isAudioHeader(header)) {return { kind: "accept" };}
    return { kind: sameGeometry(header, handoff.header) ? "accept" : "reject" };
  }

  /**
   * Follow the chain of audio records starting at `cursor` to the first video
   * header. Returns that terminal video header; `unsettled` with the furthest
   * offset reached if the run runs off the end of the buffer before a video
   * (so the caller resumes there next chunk rather than restarting); or
   * `reject` if a malformed header interrupts the run. Iterative so a long
   * audio run cannot overflow the stack.
   */
  private skipAudio(cursor: number): AudioSkip {
    for (;;) {
      if (this.buffer.length - cursor < FRAME_HEADER_SIZE) {return { kind: "unsettled", at: cursor };}
      const header = parseHeader(this.buffer, cursor);
      if (headerError(header) !== null) {return { kind: "reject" };}
      if (!isAudioHeader(header)) {return { kind: "video", header };}
      cursor += FRAME_HEADER_SIZE + payloadSize(header);
    }
  }

  /**
   * Whether a resync candidate may be considered at all. Audio records are
   * self-describing and carry no geometry. A video candidate must match the
   * geometry the stream is already using; before the first frame decodes there
   * is nothing to match, and nothing downstream to poison either — whatever
   * geometry arrives first *is* the stream's geometry, corrupt or not.
   *
   * The trade, pinned by a test so it stays deliberate: the helper does change
   * geometry mid-stream (`SimulatorCaptureSession` reconfigures `SCStream` when
   * the simulator window resizes), and if that change lands inside a corruption
   * window the decoder will not resynchronize — the stream needs a restart.
   * There is no way to allow it safely: a genuine reconfigure and a crafted run
   * of frames at a new size are byte-identical on a wire with no sync marker,
   * so any rule permitting the first permits the second. Preferring the
   * observable failure (no frames, corruption already reported) over silent
   * injection into the encoder is the same trade this decoder already makes
   * when it drops an uncorroborated recovered frame.
   */
  private admissible(header: FrameHeader): boolean {
    if (isAudioHeader(header) || this.anchor === null) {return true;}
    return sameGeometry(header, this.anchor);
  }
}

function sameGeometry(a: FrameHeader, b: FrameHeader): boolean {
  return a.width === b.width && a.height === b.height && a.bytesPerRow === b.bytesPerRow;
}

/** Lazily yields `from..toInclusive`, so a scan never materializes the range. */
function* range(from: number, toInclusive: number): Generator<number> {
  for (let value = from; value <= toInclusive; value++) {yield value;}
}

function isAudioHeader(header: FrameHeader): boolean {
  return header.width === 0 && header.height === 8_000 && header.bytesPerRow === 1;
}

function payloadSize(header: FrameHeader): number {
  return isAudioHeader(header)
    ? header.timestampMs
    : header.height * header.bytesPerRow;
}

function parseHeader(buffer: Buffer, offset: number): FrameHeader {
  return {
    width: buffer.readUInt32LE(offset),
    height: buffer.readUInt32LE(offset + 4),
    bytesPerRow: buffer.readUInt32LE(offset + 8),
    timestampMs: buffer.readUInt32LE(offset + 12),
  };
}

/** Returns the reason these 16 bytes are not a usable header, or null. */
function headerError(header: FrameHeader): MalformedFrameReason | null {
  if (isAudioHeader(header)) {
    return header.timestampMs > MAX_AUDIO_PAYLOAD_BYTES ? "audio_payload_too_large" : null;
  }
  if (header.width === 0) {return "header_width_zero";}
  if (header.height === 0) {return "header_height_zero";}
  // BGRA is 4 bytes per pixel; bytesPerRow may include padding but must fit
  // at least the visible pixels.
  if (header.bytesPerRow < header.width * 4) {return "header_bytes_per_row_too_small";}
  if (header.width > MAX_FRAME_DIMENSION || header.height > MAX_FRAME_DIMENSION) {
    return "header_dimensions_out_of_range";
  }
  if (header.bytesPerRow > header.width * 4 + MAX_ROW_PADDING_BYTES) {
    return "header_bytes_per_row_too_large";
  }
  if (header.height * header.bytesPerRow > MAX_FRAME_PAYLOAD_BYTES) {
    return "header_payload_too_large";
  }
  return null;
}
