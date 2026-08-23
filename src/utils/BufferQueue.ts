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
 */
export class BufferQueue {
  private chunks: Buffer[] = [];
  private headOffset = 0;
  length = 0;

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
    const first = this.chunks[0];
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
      const first = this.chunks[0];
      const available = first.length - this.headOffset;
      if (remaining < available) {
        this.headOffset += remaining;
        this.length -= remaining;
        return;
      }
      this.chunks.shift();
      this.headOffset = 0;
      this.length -= available;
      remaining -= available;
    }
  }

  toBuffer(): Buffer {
    if (this.length === 0) {
      return Buffer.alloc(0);
    }
    const first = this.chunks[0];
    if (this.chunks.length === 1) {
      return first.subarray(this.headOffset);
    }
    const out = Buffer.allocUnsafe(this.length);
    this.copyTo(out, this.length);
    return out;
  }

  replace(bytes: Buffer): void {
    this.chunks = bytes.length === 0 ? [] : [bytes];
    this.headOffset = 0;
    this.length = bytes.length;
  }

  private copyTo(destination: Buffer, length: number): void {
    let copied = 0;
    for (let index = 0; copied < length; index++) {
      const chunk = this.chunks[index];
      const start = index === 0 ? this.headOffset : 0;
      const available = chunk.length - start;
      const count = Math.min(available, length - copied);
      chunk.copy(destination, copied, start, start + count);
      copied += count;
    }
  }
}
