/** A packet later than this past where the stream had reached is a silent stretch, not jitter. */
const SILENCE_GAP_MIN_US = 50_000;
/**
 * A packet timestamp is trusted as an epoch time when it is within this of the host clock, or of
 * where the stream had reached (a packet that waited out a slow consumer is old but contiguous).
 */
const TIMESTAMP_TRUST_US = 10_000_000;
/** The longest silent stretch filled in one go, so a bad timestamp cannot write gigabytes. */
const SILENCE_GAP_MAX_US = 300_000_000;

/**
 * Keeps a stream's PCM on the wall-clock timeline: a silent guest sends no packets, so the time
 * between packets is filled with silence. Packet timestamps are used when they agree with the
 * host clock, arrival time otherwise.
 */
export class SilenceFiller {
  private nextUs: number;

  constructor(
    private readonly sampleRate: number,
    private readonly nowUs: () => number,
  ) {
    this.nextUs = nowUs();
  }

  /** Bytes of silence to write before `packet`, which then advances the timeline. */
  before(packet: { timestampUs?: number; audio: Uint8Array }): Uint8Array | undefined {
    const now = this.nowUs();
    const stamp = packet.timestampUs ?? 0;
    const trusted =
      stamp > 0 &&
      (Math.abs(stamp - now) < TIMESTAMP_TRUST_US ||
        Math.abs(stamp - this.nextUs) < TIMESTAMP_TRUST_US);
    const atUs = trusted ? stamp : now;
    const gapUs = Math.min(atUs - this.nextUs, SILENCE_GAP_MAX_US);
    this.nextUs =
      Math.max(this.nextUs, atUs) + (packet.audio.byteLength / 2 / this.sampleRate) * 1_000_000;
    if (gapUs < SILENCE_GAP_MIN_US) {
      return undefined;
    }
    return new Uint8Array(Math.round((gapUs * this.sampleRate) / 1_000_000) * 2);
  }
}
