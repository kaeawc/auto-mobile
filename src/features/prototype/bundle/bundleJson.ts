import { logger } from "../../../utils/logger";
import type { PrototypeJson } from "../prototypeJson";
import { BUNDLE_MAX_JSON_DEPTH, BundleFailure, type BundleErrorCode } from "./bundleContract";

/** JSON.parse owns grammar/escape handling; this token walk adds duplicate-key and depth checks. */
class JsonKeyScanner {
  private offset = 0;
  constructor(private readonly text: string) {}
  private space(): void {
    while (/\s/.test(this.text[this.offset] ?? "") && this.offset < this.text.length) {
      this.offset++;
    }
  }
  private string(): string {
    const start = this.offset++;
    while (this.text[this.offset] !== '"') {
      if (this.text[this.offset++] === "\\") {
        this.offset++;
      }
    }
    return JSON.parse(this.text.slice(start, ++this.offset)) as string;
  }
  value(depth = 0): void {
    this.space();
    if (depth > BUNDLE_MAX_JSON_DEPTH) {
      throw new Error("JSON nesting exceeds bundle depth limit");
    }
    const character = this.text[this.offset];
    if (character === "{") {
      this.object(depth);
    } else if (character === "[") {
      this.array(depth);
    } else if (character === '"') {
      this.string();
    } else {
      while (this.offset < this.text.length && !/[\s,\]}]/.test(this.text[this.offset])) {
        this.offset++;
      }
    }
  }
  private object(depth: number): void {
    this.offset++;
    this.space();
    const keys = new Set<string>();
    while (this.text[this.offset] !== "}") {
      const key = this.string();
      if (keys.has(key)) {
        throw new Error(`Duplicate JSON key: ${key}`);
      }
      keys.add(key);
      this.space();
      this.offset++; // colon, already validated by JSON.parse
      this.value(depth + 1);
      this.space();
      if (this.text[this.offset] === ",") {
        this.offset++;
        this.space();
      }
    }
    this.offset++;
  }
  private array(depth: number): void {
    this.offset++;
    this.space();
    while (this.text[this.offset] !== "]") {
      this.value(depth + 1);
      this.space();
      if (this.text[this.offset] === ",") {
        this.offset++;
      }
    }
    this.offset++;
  }
}
export function parseBundleJson(
  bytes: Uint8Array,
  code: BundleErrorCode,
  path: string,
): PrototypeJson {
  try {
    // Like readPrototypeSpecFile, strip one BOM. Fatal UTF-8 prevents replacement-character aliases.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes)
      .replace(/^\uFEFF/, "");
    const value = JSON.parse(text) as PrototypeJson;
    new JsonKeyScanner(text).value();
    return value;
  } catch (error) {
    // Invalid input is expected at this pure parsing boundary; retain a diagnostic without I/O policy.
    logger.debug("Bundle JSON rejected", error);
    throw new BundleFailure(code, path, "Invalid, duplicate-key or over-depth JSON");
  }
}
