/** Side-effect-free ADB smart-socket framing; never invokes an adb client. */
export function encodeAdbHostRequest(request: string): Buffer {
  const payload = Buffer.from(request, "utf8");
  if (payload.length > 0xffff) {
    throw new Error("ADB host request exceeds the four-hex-digit length limit");
  }
  return Buffer.concat([Buffer.from(payload.length.toString(16).padStart(4, "0")), payload]);
}
export type AdbHostResponse = { ok: true; payload: string } | { ok: false; reason: string };
export function decodeAdbHostResponse(bytes: Uint8Array): AdbHostResponse {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 4) {
    return { ok: false, reason: "Incomplete ADB host response" };
  }
  const status = buffer.toString("utf8", 0, 4);
  if (status !== "OKAY" && status !== "FAIL") {
    return { ok: false, reason: "Invalid ADB host response status" };
  }
  if (buffer.length < 8) {
    return { ok: false, reason: "Incomplete ADB host response" };
  }
  const header = buffer.toString("utf8", 4, 8);
  if (!/^[0-9a-fA-F]{4}$/.test(header)) {
    return { ok: false, reason: "Invalid ADB host response length" };
  }
  const expected = 8 + Number.parseInt(header, 16);
  if (buffer.length < expected) {
    return { ok: false, reason: "Incomplete ADB host response" };
  }
  if (buffer.length !== expected) {
    return { ok: false, reason: "ADB host response length mismatch" };
  }
  const payload = buffer.toString("utf8", 8);
  return status === "OKAY" ? { ok: true, payload } : { ok: false, reason: payload };
}

export const ADB_HOST_MAX_RESPONSE_BYTES = 8 + 0xffff;

/**
 * ADB uses status + four hex length digits, not newline framing, so LineFramer
 * does not apply. Keep chunks and a byte count up to 8 + 0xffff bytes; join only
 * on completion/end. The small header is copied once as its bytes arrive.
 */
export class AdbHostResponseAccumulator {
  private chunks: Buffer[] = [];
  private byteCount = 0;
  private readonly header = Buffer.alloc(8);
  private overflowed = false;

  push(chunk: Buffer): AdbHostResponse | undefined {
    if (this.overflowed) {
      return this.finish();
    }
    if (this.byteCount + chunk.length > ADB_HOST_MAX_RESPONSE_BYTES) {
      this.overflowed = true;
      this.chunks = [];
      return this.finish();
    }
    if (this.byteCount < 8) {
      chunk.copy(this.header, this.byteCount, 0, Math.min(chunk.length, 8 - this.byteCount));
    }
    this.byteCount += chunk.length;
    if (chunk.length) {
      this.chunks.push(chunk);
    }
    // Reuse the decoder's status/length validation rather than a second protocol parser.
    const headerResult = decodeAdbHostResponse(
      this.header.subarray(0, Math.min(8, this.byteCount)),
    );
    if (!headerResult.ok && headerResult.reason !== "Incomplete ADB host response") {
      return this.finish();
    }
    if (
      this.byteCount >= 8 &&
      this.byteCount >= 8 + Number.parseInt(this.header.toString("utf8", 4, 8), 16)
    ) {
      return this.finish();
    }
    return undefined;
  }

  finish(): AdbHostResponse {
    return this.overflowed
      ? { ok: false, reason: `ADB host response exceeds ${ADB_HOST_MAX_RESPONSE_BYTES} bytes` }
      : decodeAdbHostResponse(Buffer.concat(this.chunks, this.byteCount));
  }
}
