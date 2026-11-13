import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COLON = 0x3a;
const COMMA = 0x2c;

/** A top-level key longer than this cannot be `"id"`, so its bytes are not kept. */
const MAX_KEY_BYTES = 64;
/** A JSON-RPC id is a short string or number; a longer value is not recorded. */
const MAX_ID_VALUE_BYTES = 1024;

type Phase = "key" | "colon" | "value";

/**
 * Streams the bytes of one JSON object and records the value of its top-level
 * `id` member, without holding the object. The stdio transport uses it on a
 * request it refuses for size: the frame is discarded as it arrives, and the
 * scanner keeps only the id needed to answer that request with an error.
 *
 * It tracks strings (with escapes) and nesting depth, so an `"id"` inside
 * `params` or inside a string never matches. The captured value is decoded with
 * `JSON.parse`; only a string or a number is accepted as an id. Bytes inside a
 * string that is not being captured are skipped with `indexOf`, so a large
 * base64 member costs one native scan rather than a per-byte loop.
 */
export class JsonRpcTopLevelIdScanner {
  private depth = 0;
  private inString = false;
  private escape = false;
  private phase: Phase = "key";
  private notAnObject = false;
  private keyBytes: number[] | null = null;
  private currentKey: string | null = null;
  private valueBytes: number[] | null = null;
  private found: string | number | undefined;

  /** The top-level `id`, once its value has ended; undefined if absent or not a string/number. */
  get id(): string | number | undefined {
    return this.found;
  }

  push(chunk: Buffer): void {
    let index = 0;
    while (index < chunk.length && !this.notAnObject) {
      if (this.inString && !this.capturing()) {
        index = this.skipStringRun(chunk, index);
        continue;
      }
      this.consume(chunk[index]);
      index++;
    }
  }

  /** True while a string's bytes matter: a top-level key, or the id value. */
  private capturing(): boolean {
    return this.keyBytes !== null || this.valueBytes !== null;
  }

  /** Jumps to the next quote or backslash of an uncaptured string; returns the index to consume next. */
  private skipStringRun(chunk: Buffer, from: number): number {
    if (this.escape) {
      this.escape = false;
      return from + 1;
    }
    const quote = chunk.indexOf(QUOTE, from);
    const backslash = chunk.indexOf(BACKSLASH, from);
    const candidates = [quote, backslash].filter((position) => position !== -1);
    if (candidates.length === 0) {
      return chunk.length;
    }
    const next = Math.min(...candidates);
    if (next === backslash) {
      this.escape = true;
    } else {
      this.inString = false;
    }
    return next + 1;
  }

  private consume(byte: number): void {
    this.record(byte);
    if (this.inString) {
      this.consumeStringByte(byte);
      return;
    }
    if (byte === QUOTE) {
      this.inString = true;
      if (this.depth === 1 && this.phase === "key") {
        this.keyBytes = [];
      }
      return;
    }
    this.consumeStructural(byte);
  }

  private consumeStringByte(byte: number): void {
    if (this.escape) {
      this.escape = false;
      this.recordKeyByte(byte);
    } else if (byte === BACKSLASH) {
      this.escape = true;
      this.recordKeyByte(byte);
    } else if (byte === QUOTE) {
      this.inString = false;
      this.finishKey();
    } else {
      this.recordKeyByte(byte);
    }
  }

  private consumeStructural(byte: number): void {
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      this.open(byte);
    } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      this.close();
    } else if (this.depth === 1) {
      this.consumeTopLevelSeparator(byte);
    }
  }

  private open(byte: number): void {
    if (this.depth === 0 && byte === OPEN_BRACKET) {
      this.notAnObject = true;
    }
    this.depth++;
  }

  private close(): void {
    this.depth--;
    if (this.depth === 0) {
      this.finishValue();
    }
  }

  private consumeTopLevelSeparator(byte: number): void {
    if (byte === COLON && this.phase === "colon") {
      this.phase = "value";
      this.valueBytes = this.currentKey === "id" && this.found === undefined ? [] : null;
    } else if (byte === COMMA) {
      this.finishValue();
      this.phase = "key";
    }
  }

  /** Appends a byte to the id value being captured, dropping the capture once it is too long. */
  private record(byte: number): void {
    if (this.valueBytes === null || this.depth !== 1 || this.phase !== "value") {
      return;
    }
    if (!this.inString && (byte === COMMA || byte === CLOSE_BRACE || byte === COLON)) {
      return;
    }
    this.valueBytes.push(byte);
    if (this.valueBytes.length > MAX_ID_VALUE_BYTES) {
      this.valueBytes = null;
    }
  }

  private recordKeyByte(byte: number): void {
    if (this.keyBytes === null) {
      return;
    }
    // Past the cap the key cannot be "id"; one extra byte marks it as too long.
    if (this.keyBytes.length <= MAX_KEY_BYTES) {
      this.keyBytes.push(byte);
    }
  }

  private finishKey(): void {
    if (this.depth !== 1 || this.phase !== "key") {
      return;
    }
    const bytes = this.keyBytes;
    this.keyBytes = null;
    const key =
      bytes === null || bytes.length > MAX_KEY_BYTES
        ? undefined
        : decodeJson(`"${Buffer.from(bytes).toString("utf8")}"`);
    this.currentKey = typeof key === "string" ? key : null;
    this.phase = "colon";
  }

  private finishValue(): void {
    if (this.valueBytes !== null) {
      const value = decodeJson(Buffer.from(this.valueBytes).toString("utf8"));
      if (typeof value === "string" || typeof value === "number") {
        this.found = value;
      }
    }
    this.valueBytes = null;
  }
}

function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    // A malformed key or id only means the oversized request is answered without an id.
    logger.debug(`[stdio] oversized request id not decodable: ${errorMessage(error)}`);
    return undefined;
  }
}
