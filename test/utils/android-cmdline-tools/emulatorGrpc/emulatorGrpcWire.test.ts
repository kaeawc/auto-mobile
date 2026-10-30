import { describe, expect, test } from "bun:test";
import {
  decodeAudioPacket,
  encodeAudioFormat,
  encodeAudioPacket,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorAudioMessages";
import {
  frameMessage,
  GrpcFrameDecoder,
  readGrpcStatus,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/grpcFraming";
import {
  decodeFields,
  encodeVarint,
} from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/protobufWire";

describe("protobuf wire", () => {
  test("varints match the protobuf spec examples", () => {
    expect(encodeVarint(1)).toEqual([0x01]);
    expect(encodeVarint(150)).toEqual([0x96, 0x01]);
    expect(encodeVarint(300)).toEqual([0xac, 0x02]);
  });

  test("varints above 2^32 round-trip (microsecond timestamps)", () => {
    const timestampUs = 1_761_667_200_123_456;
    const [field] = decodeFields(Uint8Array.from([0x10, ...encodeVarint(timestampUs)]));
    expect(field).toEqual({ field: 2, value: { kind: "varint", value: timestampUs } });
  });

  test("rejects negative and truncated input", () => {
    expect(() => encodeVarint(-1)).toThrow(RangeError);
    expect(() => decodeFields(Uint8Array.from([0x08, 0x96]))).toThrow(/truncated varint/);
    expect(() => decodeFields(Uint8Array.from([0x1a, 0x05, 0x01]))).toThrow(/truncated field/);
  });

  test("skips fixed-width fields", () => {
    const bytes = Uint8Array.from([0x09, 1, 2, 3, 4, 5, 6, 7, 8, 0x08, 0x07]);
    expect(decodeFields(bytes)).toEqual([{ field: 1, value: { kind: "varint", value: 7 } }]);
  });
});

describe("emulator audio messages", () => {
  test("AudioFormat encodes enum values from emulator_controller.proto", () => {
    // samplingRate=48000 (field 1), channels Stereo=1 (field 2), format S16=1 (field 3), mode REAL_TIME=1 (field 4)
    const bytes = encodeAudioFormat({
      samplingRate: 48_000,
      channels: "stereo",
      format: "s16",
      mode: "realtime",
    });
    expect(Array.from(bytes)).toEqual([0x08, 0x80, 0xf7, 0x02, 0x10, 0x01, 0x18, 0x01, 0x20, 0x01]);
  });

  test("AudioFormat omits proto3 defaults (mono, U8, unspecified mode)", () => {
    const bytes = encodeAudioFormat({ samplingRate: 8_000, channels: "mono", format: "u8" });
    expect(Array.from(bytes)).toEqual([0x08, 0xc0, 0x3e]);
  });

  test("AudioPacket round-trips format, timestamp and audio", () => {
    const packet = {
      format: {
        samplingRate: 44_100,
        channels: "mono" as const,
        format: "s16" as const,
        mode: "unspecified" as const,
      },
      timestampUs: 1_700_000_000_000_000,
      audio: Uint8Array.from([1, 2, 3, 4]),
    };
    expect(decodeAudioPacket(encodeAudioPacket(packet))).toEqual(packet);
  });

  test("a packet without a format decodes with format undefined", () => {
    const decoded = decodeAudioPacket(encodeAudioPacket({ audio: Uint8Array.from([9, 9]) }));
    expect(decoded.format).toBeUndefined();
    expect(Array.from(decoded.audio)).toEqual([9, 9]);
  });
});

describe("gRPC framing", () => {
  test("frames carry a zero compression flag and big-endian length", () => {
    expect(Array.from(frameMessage(Uint8Array.from([7, 8])))).toEqual([0, 0, 0, 0, 2, 7, 8]);
  });

  test("the decoder reassembles messages split across chunks", () => {
    const stream = new Uint8Array([
      ...frameMessage(Uint8Array.from([1, 2, 3])),
      ...frameMessage(Uint8Array.from([4])),
    ]);
    const decoder = new GrpcFrameDecoder();
    const messages = [stream.subarray(0, 2), stream.subarray(2, 7), stream.subarray(7)].flatMap(
      (chunk) => decoder.push(chunk),
    );
    expect(messages.map((message) => Array.from(message))).toEqual([[1, 2, 3], [4]]);
    expect(decoder.pendingBytes).toBe(0);
  });

  test("the decoder rejects compressed and oversized frames", () => {
    expect(() => new GrpcFrameDecoder().push(Uint8Array.from([1, 0, 0, 0, 0]))).toThrow(
      /compressed/,
    );
    expect(() => new GrpcFrameDecoder(4).push(Uint8Array.from([0, 0, 0, 0, 5]))).toThrow(/exceeds/);
  });

  test("status comes from trailers, then trailers-only headers, with percent-decoding", () => {
    expect(
      readGrpcStatus({ "grpc-status": "9", "grpc-message": "mic%20busy" }, { "grpc-status": "0" }),
    ).toEqual({
      code: 9,
      message: "mic busy",
    });
    expect(readGrpcStatus(undefined, { "grpc-status": "12" })).toEqual({ code: 12, message: "" });
    expect(readGrpcStatus({ "grpc-status": "2", "grpc-message": "100%" })?.message).toBe("100%");
    expect(readGrpcStatus({}, {})).toBeUndefined();
  });
});
