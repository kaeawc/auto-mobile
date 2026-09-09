/**
 * Chunked byte storage for incremental stream parsers.
 *
 * Storing incoming chunks in a list and advancing a head offset avoids the
 * repeated whole-buffer `Buffer.concat` copies that make per-chunk accumulation
 * quadratic in payload size when a large frame arrives split across many small
 * TCP/pipe segments. Reads over the head are contiguous views when they fit in a
 * single chunk and copy only when they span a boundary; {@link takeDetached}
 * performs the single detached copy needed when a decoded payload must outlive
 * the chunks it was assembled from.
 *
 * Consumed chunks are retired by advancing a head-chunk index rather than
 * `Array.shift()`, which would reindex the whole array on every fully-consumed
 * chunk and reintroduce quadratic reference movement under the exact
 * high-fragmentation shape this class exists to handle. The consumed prefix is
 * spliced away only when it grows past half the backing array, keeping discard
 * amortized O(1) while still releasing consumed chunk references promptly.
 */
export class BufferQueue {
  private chunks: Buffer[] = [];
  // Index of the first live chunk in `chunks`; entries before it are consumed.
  private headChunk = 0;
  // Consumed-byte offset within `chunks[headChunk]`.
  private headOffset = 0;
  length = 0;

  // Total backing-array elements moved by compaction over this queue's lifetime.
  // Exposed via {@link compactionWorkUnits} purely as a test seam so consumption
  // can be shown to stay linear without a flaky wall-clock benchmark.
  private compactionWork = 0;

  /** Test seam: number of backing-array slots currently retained. */
  get retainedChunkCount(): number {
    return this.chunks.length;
  }

  /** Test seam: cumulative array elements moved by compaction (see class doc). */
  get compactionWorkUnits(): number {
    return this.compactionWork;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  peek(length: number): Buffer {
    if (length > this.length) {
      throw new RangeError(`cannot peek ${length} bytes from ${this.length}-byte queue`);
    }
    if (length === 0) {
      return Buffer.alloc(0);
    }
    const first = this.chunks[this.headChunk];
    const firstAvailable = first.length - this.headOffset;
    if (firstAvailable >= length) {
      return first.subarray(this.headOffset, this.headOffset + length);
    }
    const out = Buffer.allocUnsafe(length);
    this.copyTo(out, length);
    return out;
  }

  takeDetached(length: number): Buffer {
    if (length > this.length) {
      throw new RangeError(`cannot take ${length} bytes from ${this.length}-byte queue`);
    }
    if (length === 0) {
      return Buffer.alloc(0);
    }
    const out = Buffer.allocUnsafe(length);
    this.copyTo(out, length);
    this.discard(length);
    return out;
  }

  discard(length: number): void {
    if (length > this.length) {
      throw new RangeError(`cannot discard ${length} bytes from ${this.length}-byte queue`);
    }
    let remaining = length;
    while (remaining > 0) {
      const first = this.chunks[this.headChunk];
      const available = first.length - this.headOffset;
      if (remaining < available) {
        this.headOffset += remaining;
        this.length -= remaining;
        remaining = 0;
        break;
      }
      this.headChunk++;
      this.headOffset = 0;
      this.length -= available;
      remaining -= available;
    }
    this.compact();
  }

  toBuffer(): Buffer {
    if (this.length === 0) {
      return Buffer.alloc(0);
    }
    const first = this.chunks[this.headChunk];
    if (this.headChunk === this.chunks.length - 1) {
      return first.subarray(this.headOffset);
    }
    const out = Buffer.allocUnsafe(this.length);
    this.copyTo(out, this.length);
    return out;
  }

  replace(bytes: Buffer): void {
    this.chunks = bytes.length === 0 ? [] : [bytes];
    this.headChunk = 0;
    this.headOffset = 0;
    this.length = bytes.length;
  }

  private compact(): void {
    if (this.headChunk === this.chunks.length) {
      // Fully drained: drop all references at once and reset to a pristine state.
      this.chunks.length = 0;
      this.headChunk = 0;
      return;
    }
    // Amortized O(1): only reindex once the consumed prefix is at least half the
    // array, so total elements moved across a full drain stays linear in chunk
    // count rather than the quadratic cost of an Array.shift() per chunk.
    if (this.headChunk * 2 >= this.chunks.length) {
      this.chunks.splice(0, this.headChunk);
      this.compactionWork += this.chunks.length;
      this.headChunk = 0;
    }
  }

  private copyTo(destination: Buffer, length: number): void {
    let copied = 0;
    for (let index = this.headChunk; copied < length; index++) {
      const chunk = this.chunks[index];
      const start = index === this.headChunk ? this.headOffset : 0;
      const available = chunk.length - start;
      const count = Math.min(available, length - copied);
      chunk.copy(destination, copied, start, start + count);
      copied += count;
    }
  }
}
