import { ApkSigningParseError } from "./ApkSigningParseError";

export class ApkSigningCursor {
  private position = 0;
  constructor(private readonly buffer: Buffer) {}

  get remaining(): number {
    return this.buffer.length - this.position;
  }

  u32(): number {
    this.require(4);
    const value = this.buffer.readUInt32LE(this.position);
    this.position += 4;
    return value;
  }

  /** Everything not yet read. */
  rest(): Buffer {
    const slice = this.buffer.subarray(this.position);
    this.position = this.buffer.length;
    return slice;
  }

  /** A u32 length followed by that many bytes. */
  lengthPrefixed(): Buffer {
    const length = this.u32();
    this.require(length);
    const slice = this.buffer.subarray(this.position, this.position + length);
    this.position += length;
    return slice;
  }

  private require(length: number): void {
    if (length > this.remaining) {
      throw new ApkSigningParseError("Truncated APK signing data");
    }
  }
}
