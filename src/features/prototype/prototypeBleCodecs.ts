/**
 * BLE value codecs (#14266): a closed list with no expressions, shared by `ble.read`, `ble.write`
 * and `ble.subscribe`. Kotlin (`PrototypeBleCodecs`) and Swift (`PrototypeBleCodecs`) twins replay
 * `test/fixtures/prototype-spec/ble/codecs.json`.
 */

/** ATT attribute values are at most 512 bytes. */
export const MAX_PROTOTYPE_BLE_VALUE_BYTES = 512;

export const PROTOTYPE_BLE_CODECS = [
  "utf8",
  "hex",
  "base64",
  "uint8",
  "uint16le",
  "int16le",
  "uint32le",
  "float32le",
  "gatt.battery_level",
  "gatt.heart_rate_measurement",
] as const;

export type PrototypeBleCodec = (typeof PROTOTYPE_BLE_CODECS)[number];

/** `length` and `range` are about the bytes or number; `format` is a value of the wrong shape. */
export type PrototypeBleCodecError = "unknown" | "length" | "range" | "format" | "decodeOnly";

export type PrototypeBleCodecResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: PrototypeBleCodecError };

type Json = string | number | Record<string, unknown>;

const ok = <T>(value: T): PrototypeBleCodecResult<T> => ({ ok: true, value });
const fail = <T>(error: PrototypeBleCodecError): PrototypeBleCodecResult<T> => ({
  ok: false,
  error,
});
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$(?![\s\S])/;
const hexPattern = /^(?:[0-9A-Fa-f]{2})*$(?![\s\S])/;

/** Fixed-width integers: byte count and inclusive range. */
const integers: Record<string, { bytes: number; min: number; max: number }> = {
  uint8: { bytes: 1, min: 0, max: 0xff },
  uint16le: { bytes: 2, min: 0, max: 0xffff },
  int16le: { bytes: 2, min: -0x8000, max: 0x7fff },
  uint32le: { bytes: 4, min: 0, max: 0xffffffff },
};

function isCodec(codec: string): codec is PrototypeBleCodec {
  return (PROTOTYPE_BLE_CODECS as readonly string[]).includes(codec);
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decodeInteger(name: string, bytes: Uint8Array): PrototypeBleCodecResult<Json> {
  const { bytes: width } = integers[name]!;
  if (bytes.length !== width) {
    return fail("length");
  }
  const data = view(bytes);
  switch (name) {
    case "uint8":
      return ok(data.getUint8(0));
    case "uint16le":
      return ok(data.getUint16(0, true));
    case "int16le":
      return ok(data.getInt16(0, true));
    default:
      return ok(data.getUint32(0, true));
  }
}

function decodeHeartRate(bytes: Uint8Array): PrototypeBleCodecResult<Json> {
  if (bytes.length < 2) {
    return fail("length");
  }
  const flags = bytes[0]!;
  const data = view(bytes);
  const wide = (flags & 0x01) !== 0;
  let offset = wide ? 3 : 2;
  if (bytes.length < offset) {
    return fail("length");
  }
  const result: Record<string, unknown> = {
    heartRate: wide ? data.getUint16(1, true) : bytes[1]!,
    sensorContact:
      (flags & 0x04) === 0 ? "unsupported" : (flags & 0x02) !== 0 ? "detected" : "notDetected",
  };
  if ((flags & 0x08) !== 0) {
    if (bytes.length < offset + 2) {
      return fail("length");
    }
    result.energyExpended = data.getUint16(offset, true);
    offset += 2;
  }
  const rest = bytes.length - offset;
  if ((flags & 0x10) === 0 ? rest !== 0 : rest % 2 !== 0) {
    return fail("length");
  }
  if ((flags & 0x10) !== 0) {
    // RR intervals are in 1/1024 s; report whole milliseconds.
    result.rrIntervalsMs = Array.from({ length: rest / 2 }, (_, index) =>
      Math.round((data.getUint16(offset + index * 2, true) * 1000) / 1024),
    );
  }
  return ok(result);
}

function decodeKnown(codec: PrototypeBleCodec, bytes: Uint8Array): PrototypeBleCodecResult<Json> {
  switch (codec) {
    case "utf8": {
      // Invalid UTF-8 decodes to replacement characters, so it does not round-trip.
      const text = new TextDecoder().decode(bytes);
      return Buffer.from(text, "utf8").equals(bytes) ? ok(text) : fail("format");
    }
    case "hex":
      return ok(Buffer.from(bytes).toString("hex"));
    case "base64":
      return ok(Buffer.from(bytes).toString("base64"));
    case "float32le": {
      if (bytes.length !== 4) {
        return fail("length");
      }
      const value = view(bytes).getFloat32(0, true);
      return Number.isFinite(value) ? ok(value) : fail("range");
    }
    case "gatt.battery_level":
      return bytes.length !== 1 ? fail("length") : bytes[0]! > 100 ? fail("range") : ok(bytes[0]!);
    case "gatt.heart_rate_measurement":
      return decodeHeartRate(bytes);
    default:
      return decodeInteger(codec, bytes);
  }
}

export function decodePrototypeBleValue(
  codec: string,
  bytes: Uint8Array,
): PrototypeBleCodecResult<Json> {
  if (!isCodec(codec)) {
    return fail("unknown");
  }
  return bytes.length > MAX_PROTOTYPE_BLE_VALUE_BYTES ? fail("length") : decodeKnown(codec, bytes);
}

function encodeText(codec: string, value: string): PrototypeBleCodecResult<Uint8Array> {
  if (codec === "utf8") {
    return ok(new TextEncoder().encode(value));
  }
  const pattern = codec === "hex" ? hexPattern : base64Pattern;
  return pattern.test(value)
    ? ok(new Uint8Array(Buffer.from(value, codec === "hex" ? "hex" : "base64")))
    : fail("format");
}

function encodeNumber(codec: string, value: number): PrototypeBleCodecResult<Uint8Array> {
  if (codec === "float32le") {
    if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
      return fail("range");
    }
    const bytes = new Uint8Array(4);
    view(bytes).setFloat32(0, value, true);
    return ok(bytes);
  }
  const { bytes: width, min, max } = integers[codec]!;
  if (!Number.isInteger(value) || value < min || value > max) {
    return fail("range");
  }
  const bytes = new Uint8Array(width);
  const data = view(bytes);
  const write: Record<string, () => void> = {
    uint8: () => data.setUint8(0, value),
    uint16le: () => data.setUint16(0, value, true),
    int16le: () => data.setInt16(0, value, true),
    uint32le: () => data.setUint32(0, value, true),
  };
  write[codec]!();
  return ok(bytes);
}

function encodeKnown(
  codec: PrototypeBleCodec,
  value: unknown,
): PrototypeBleCodecResult<Uint8Array> {
  if (codec.startsWith("gatt.")) {
    return fail("decodeOnly");
  }
  const text = codec === "utf8" || codec === "hex" || codec === "base64";
  if (text) {
    return typeof value === "string" ? encodeText(codec, value) : fail("format");
  }
  return typeof value === "number" ? encodeNumber(codec, value) : fail("format");
}

export function encodePrototypeBleValue(
  codec: string,
  value: unknown,
): PrototypeBleCodecResult<Uint8Array> {
  if (!isCodec(codec)) {
    return fail("unknown");
  }
  const result = encodeKnown(codec, value);
  return result.ok && result.value.length > MAX_PROTOTYPE_BLE_VALUE_BYTES ? fail("length") : result;
}
