/**
 * Synchronous, header-only image dimension reader (issue #3348).
 *
 * `ScreenshotComparator.getImageDimensions` is the general-purpose reader, but it is `async` and
 * falls back to a full decode through the image backend for anything that is not PNG. The
 * observation stream needs pixel dimensions on the **synchronous per-frame push path**, where a
 * decode per frame is not affordable and an async call would reorder pushes. This reader parses
 * only the container headers of the two formats CtrlProxy actually emits — JPEG on Android, PNG on
 * iOS and the ADB fallback — and returns null for anything it cannot read with certainty.
 *
 * Returning null is meaningful: callers use it to fail closed rather than to guess.
 */

export interface ImagePixelDimensions {
  width: number;
  height: number;
}

/** PNG signature: the 8-byte magic that opens every PNG. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";

/** Detect the image container from its magic bytes without decoding pixels. */
export function detectImageMimeType(buffer: Buffer): ImageMimeType | null {
  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/** Offset of the IHDR chunk's declared length (immediately after the 8-byte signature). */
const PNG_IHDR_LENGTH_OFFSET = 8;
/** Offset of the IHDR chunk type. */
const PNG_IHDR_TYPE_OFFSET = 12;
/** Offset of the IHDR width field (8-byte signature + 4-byte length + 4-byte "IHDR"). */
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEADER_LENGTH = 24;
/** The IHDR chunk's data length is fixed by the PNG spec. */
const PNG_IHDR_DATA_LENGTH = 13;

/**
 * JPEG start-of-frame markers. Each SOFn (except the DHT/DAC/DNL/RSTn holes below) carries the
 * frame's height and width immediately after its 2-byte segment length and 1-byte precision.
 */
function isStartOfFrameMarker(marker: number): boolean {
  // SOF0..SOF15 occupy 0xC0..0xCF, minus 0xC4 (DHT), 0xC8 (JPG) and 0xCC (DAC), which are not
  // frame headers and carry unrelated payloads.
  if (marker < 0xc0 || marker > 0xcf) {
    return false;
  }
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Read a PNG's pixel dimensions from its IHDR chunk, or null when the buffer is not a PNG. */
function readPngDimensions(buffer: Buffer): ImagePixelDimensions | null {
  if (buffer.length < PNG_IHDR_HEADER_LENGTH) {
    return null;
  }
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return null;
  }
  // The signature alone proves nothing about what follows. IHDR is required by the spec to be the
  // first chunk and to carry exactly 13 bytes; anything else means these are not the dimensions we
  // think they are, and this reader exists precisely so callers do not have to trust a guess.
  if (buffer.toString("ascii", PNG_IHDR_TYPE_OFFSET, PNG_IHDR_TYPE_OFFSET + 4) !== "IHDR") {
    return null;
  }
  if (buffer.readUInt32BE(PNG_IHDR_LENGTH_OFFSET) !== PNG_IHDR_DATA_LENGTH) {
    return null;
  }
  const width = buffer.readUInt32BE(PNG_IHDR_WIDTH_OFFSET);
  const height = buffer.readUInt32BE(PNG_IHDR_WIDTH_OFFSET + 4);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Smallest SOFn segment length that can hold precision, height, width and a component count. */
const SOF_MINIMUM_SEGMENT_LENGTH = 8;

/** Markers that stand alone: SOI, TEM and the restart markers carry no length-prefixed payload. */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/** Read width/height out of an SOFn segment starting at [markerOffset], or null if truncated. */
function readFrameDimensions(buffer: Buffer, markerOffset: number): ImagePixelDimensions | null {
  // An SOFn segment is length(2) + precision(1) + height(2) + width(2) + component count(1) at a
  // minimum, so a declared length below 8 cannot contain the fields we are about to read. Reject
  // rather than reading whatever bytes happen to follow.
  if (buffer.readUInt16BE(markerOffset + 2) < SOF_MINIMUM_SEGMENT_LENGTH) {
    return null;
  }
  // marker(2) + length(2) + precision(1), then height(2), width(2).
  const heightOffset = markerOffset + 5;
  if (heightOffset + 3 >= buffer.length) {
    return null;
  }
  const height = buffer.readUInt16BE(heightOffset);
  const width = buffer.readUInt16BE(heightOffset + 2);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Advance past the segment at [offset], or return null to stop the walk (start-of-scan reached, or
 * a malformed length that would not make progress).
 */
function nextSegmentOffset(buffer: Buffer, offset: number, marker: number): number | null {
  if (isStandaloneMarker(marker)) {
    return offset + 2;
  }
  // Start of scan: entropy-coded data follows and no frame header can appear after it.
  if (marker === 0xda) {
    return null;
  }
  const segmentLength = buffer.readUInt16BE(offset + 2);
  return segmentLength < 2 ? null : offset + 2 + segmentLength;
}

/**
 * Read a JPEG's pixel dimensions by walking its marker segments to the first start-of-frame, or
 * null when the buffer is not a JPEG or is truncated before its frame header.
 */
function readJpegDimensions(buffer: Buffer): ImagePixelDimensions | null {
  // SOI
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 3 < buffer.length) {
    // Segments begin with 0xFF; fill bytes (also 0xFF) are skipped.
    if (buffer[offset] !== 0xff || buffer[offset + 1] === 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    if (isStartOfFrameMarker(marker)) {
      return readFrameDimensions(buffer, offset);
    }
    const next = nextSegmentOffset(buffer, offset, marker);
    if (next === null) {
      return null;
    }
    offset = next;
  }
  return null;
}

/**
 * Return the true pixel dimensions encoded in [buffer]'s header, or null when they cannot be read
 * with certainty (unsupported format, truncated buffer, or a JPEG whose frame header was not found
 * before the scan data).
 */
export function readImageHeaderDimensions(buffer: Buffer): ImagePixelDimensions | null {
  return readPngDimensions(buffer) ?? readJpegDimensions(buffer);
}
