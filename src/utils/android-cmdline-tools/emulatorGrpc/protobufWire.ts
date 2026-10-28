/**
 * The protobuf wire format subset the emulator audio RPCs need: varints and length-delimited
 * fields. Hand-written because the messages are three small, stable structs from
 * `emulator_controller.proto` and no protobuf runtime is a dependency.
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

/** Encodes a non-negative integer up to 2^53 as a base-128 varint. */
export function encodeVarint(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`varint must be a non-negative safe integer, got ${value}`);
  }
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining % 0x80) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return bytes;
}

/** Builds one message. proto3 omits scalar fields equal to their default (zero). */
export class ProtoWriter {
  private readonly chunks: Uint8Array[] = [];

  varint(field: number, value: number): this {
    if (value !== 0) {
      this.chunks.push(
        Uint8Array.from([...encodeVarint(field * 8 + WIRE_VARINT), ...encodeVarint(value)]),
      );
    }
    return this;
  }

  bytes(field: number, value: Uint8Array): this {
    if (value.byteLength > 0) {
      const key = [
        ...encodeVarint(field * 8 + WIRE_LENGTH_DELIMITED),
        ...encodeVarint(value.byteLength),
      ];
      this.chunks.push(Uint8Array.from(key), value);
    }
    return this;
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

export type ProtoFieldValue =
  | { kind: "varint"; value: number }
  | { kind: "bytes"; value: Uint8Array };

export interface ProtoField {
  field: number;
  value: ProtoFieldValue;
}

interface ReadCursor {
  bytes: Uint8Array;
  offset: number;
}

function readVarint(cursor: ReadCursor): number {
  let result = 0;
  let scale = 1;
  for (;;) {
    if (cursor.offset >= cursor.bytes.byteLength) {
      throw new RangeError("truncated varint");
    }
    const byte = cursor.bytes[cursor.offset++];
    result += (byte & 0x7f) * scale;
    if (byte < 0x80) {
      return result;
    }
    scale *= 0x80;
  }
}

function take(cursor: ReadCursor, length: number): Uint8Array {
  if (cursor.offset + length > cursor.bytes.byteLength) {
    throw new RangeError("truncated field");
  }
  const slice = cursor.bytes.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return slice;
}

function readValue(cursor: ReadCursor, wireType: number): ProtoFieldValue | undefined {
  switch (wireType) {
    case WIRE_VARINT:
      return { kind: "varint", value: readVarint(cursor) };
    case WIRE_LENGTH_DELIMITED:
      return { kind: "bytes", value: take(cursor, readVarint(cursor)) };
    case WIRE_FIXED64:
      take(cursor, 8);
      return undefined;
    case WIRE_FIXED32:
      take(cursor, 4);
      return undefined;
    default:
      throw new RangeError(`unsupported wire type ${wireType}`);
  }
}

/** Decodes the top-level fields of one message, skipping fixed-width fields the codec ignores. */
export function decodeFields(bytes: Uint8Array): ProtoField[] {
  const cursor: ReadCursor = { bytes, offset: 0 };
  const fields: ProtoField[] = [];
  while (cursor.offset < bytes.byteLength) {
    const key = readVarint(cursor);
    const value = readValue(cursor, key % 8);
    if (value) {
      fields.push({ field: Math.floor(key / 8), value });
    }
  }
  return fields;
}
