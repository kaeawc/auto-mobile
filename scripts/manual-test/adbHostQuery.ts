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
