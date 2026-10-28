import { decodeFields, ProtoWriter } from "./protobufWire";

/**
 * `AudioFormat` and `AudioPacket` from the emulator's `emulator_controller.proto`
 * (package `android.emulation.control`). Field numbers and enum values must match that file.
 */

export type AudioSampleFormat = "u8" | "s16";
export type AudioChannels = "mono" | "stereo";
/** `unspecified` lets the emulator pull packets at its own pace; `realtime` overwrites its buffer. */
export type AudioDeliveryMode = "unspecified" | "realtime";

export interface EmulatorAudioFormat {
  samplingRate: number;
  channels: AudioChannels;
  format: AudioSampleFormat;
  mode?: AudioDeliveryMode;
}

export interface EmulatorAudioPacket {
  format?: EmulatorAudioFormat;
  /** Unix epoch in microseconds. */
  timestampUs?: number;
  audio: Uint8Array;
}

/** The emulator rejects higher rates with INVALID_ARGUMENT. */
export const EMULATOR_MAX_SAMPLING_RATE = 48_000;

const FORMAT_FIELD = { samplingRate: 1, channels: 2, format: 3, mode: 4 } as const;
const PACKET_FIELD = { format: 1, timestamp: 2, audio: 3 } as const;

export function encodeAudioFormat(format: EmulatorAudioFormat): Uint8Array {
  return new ProtoWriter()
    .varint(FORMAT_FIELD.samplingRate, format.samplingRate)
    .varint(FORMAT_FIELD.channels, format.channels === "stereo" ? 1 : 0)
    .varint(FORMAT_FIELD.format, format.format === "s16" ? 1 : 0)
    .varint(FORMAT_FIELD.mode, format.mode === "realtime" ? 1 : 0)
    .finish();
}

export function encodeAudioPacket(packet: EmulatorAudioPacket): Uint8Array {
  const writer = new ProtoWriter();
  if (packet.format) {
    writer.bytes(PACKET_FIELD.format, encodeAudioFormat(packet.format));
  }
  return writer
    .varint(PACKET_FIELD.timestamp, packet.timestampUs ?? 0)
    .bytes(PACKET_FIELD.audio, packet.audio)
    .finish();
}

export function decodeAudioFormat(bytes: Uint8Array): EmulatorAudioFormat {
  const format: EmulatorAudioFormat = {
    samplingRate: 44_100,
    channels: "mono",
    format: "u8",
    mode: "unspecified",
  };
  for (const { field, value } of decodeFields(bytes)) {
    if (value.kind !== "varint") {
      continue;
    }
    if (field === FORMAT_FIELD.samplingRate) {
      format.samplingRate = value.value;
    } else if (field === FORMAT_FIELD.channels) {
      format.channels = value.value === 1 ? "stereo" : "mono";
    } else if (field === FORMAT_FIELD.format) {
      format.format = value.value === 1 ? "s16" : "u8";
    } else if (field === FORMAT_FIELD.mode) {
      format.mode = value.value === 1 ? "realtime" : "unspecified";
    }
  }
  return format;
}

export function decodeAudioPacket(bytes: Uint8Array): EmulatorAudioPacket {
  const packet: EmulatorAudioPacket = { audio: new Uint8Array(0) };
  for (const { field, value } of decodeFields(bytes)) {
    if (field === PACKET_FIELD.format && value.kind === "bytes") {
      packet.format = decodeAudioFormat(value.value);
    } else if (field === PACKET_FIELD.timestamp && value.kind === "varint") {
      packet.timestampUs = value.value;
    } else if (field === PACKET_FIELD.audio && value.kind === "bytes") {
      packet.audio = value.value;
    }
  }
  return packet;
}
