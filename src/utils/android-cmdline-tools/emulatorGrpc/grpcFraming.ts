import { errorMessage } from "../../../models/describeUnknownError";
import { logger } from "../../logger";

/**
 * gRPC-over-HTTP/2 length-prefixed message framing: a 1-byte compressed flag, a 4-byte
 * big-endian length, then the message. The client never compresses and rejects compressed frames.
 */

const HEADER_BYTES = 5;

export function frameMessage(message: Uint8Array): Uint8Array {
  const framed = new Uint8Array(HEADER_BYTES + message.byteLength);
  new DataView(framed.buffer).setUint32(1, message.byteLength, false);
  framed.set(message, HEADER_BYTES);
  return framed;
}

/** Reassembles framed messages from arbitrarily split DATA chunks. */
export class GrpcFrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  constructor(private readonly maxMessageBytes = 16 * 1024 * 1024) {}

  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer = concat(this.buffer, chunk);
    const messages: Uint8Array[] = [];
    while (this.buffer.byteLength >= HEADER_BYTES) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      if (view.getUint8(0) !== 0) {
        throw new Error("received a compressed gRPC message; compression was not negotiated");
      }
      const length = view.getUint32(1, false);
      if (length > this.maxMessageBytes) {
        throw new Error(
          `gRPC message of ${length} bytes exceeds the ${this.maxMessageBytes}-byte limit`,
        );
      }
      if (this.buffer.byteLength < HEADER_BYTES + length) {
        break;
      }
      messages.push(this.buffer.slice(HEADER_BYTES, HEADER_BYTES + length));
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
    }
    return messages;
  }

  /** Bytes of an incomplete trailing frame; non-zero at stream end means truncation. */
  get pendingBytes(): number {
    return this.buffer.byteLength;
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) {
    return right;
  }
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

/** The gRPC status codes the audio client distinguishes. */
export const GrpcStatus = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  PERMISSION_DENIED: 7,
  FAILED_PRECONDITION: 9,
  UNIMPLEMENTED: 12,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

export interface GrpcStatusResult {
  code: number;
  message: string;
}

function decodeGrpcMessage(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    // grpc-message is percent-encoded; a malformed escape still carries a readable message.
    logger.debug(`grpc-message was not valid percent-encoding: ${errorMessage(error)}`);
    return raw;
  }
}

type HeaderValue = string | string[] | number | undefined;

function headerText(value: HeaderValue): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value[0] : String(value);
}

/**
 * Reads `grpc-status`/`grpc-message` from trailers, or from headers for a trailers-only
 * response. Undefined when neither carries a status.
 */
export function readGrpcStatus(
  ...sources: ReadonlyArray<Readonly<Record<string, HeaderValue>> | undefined>
): GrpcStatusResult | undefined {
  for (const source of sources) {
    const status = headerText(source?.["grpc-status"]);
    if (status !== undefined) {
      const code = Number.parseInt(status, 10);
      return {
        code: Number.isNaN(code) ? GrpcStatus.UNKNOWN : code,
        message: decodeGrpcMessage(headerText(source?.["grpc-message"]) ?? ""),
      };
    }
  }
  return undefined;
}
