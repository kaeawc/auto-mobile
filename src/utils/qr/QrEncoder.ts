/**
 * Self-contained QR Code Model 2 encoder written from ISO/IEC 18004:2015.
 *
 * Scope: byte mode (UTF-8 payloads, no ECI header), error-correction levels
 * L/M/Q/H (M default), versions 1-10, automatic smallest-version selection,
 * and automatic mask selection over all eight masks by the standard penalty
 * rules. Longer payloads are rejected with an ActionableError naming the limit.
 *
 * Matrices are row-major `matrix[row][column]`, `true` = dark module, with no
 * quiet zone (the renderer adds it).
 */
import { ActionableError } from "../../models/ActionableError";
import { qrMaskApplies, qrMaskPenalty, QR_MASK_COUNT, type QrMatrix } from "./QrMask";
import { rsComputeRemainder } from "./ReedSolomon";
import {
  EC_LEVEL_BITS,
  QR_MAX_VERSION,
  QR_MIN_VERSION,
  qrAlignmentCentres,
  qrBlockLayout,
  qrByteCapacity,
  qrByteModeCountBits,
  qrDataCodewordCount,
  qrSymbolSize,
  type QrErrorCorrectionLevel,
} from "./QrTables";

export type { QrMatrix } from "./QrMask";
export type { QrErrorCorrectionLevel } from "./QrTables";

export interface QrEncodeOptions {
  /** Error-correction level; defaults to M (~15% recovery). */
  ecLevel?: QrErrorCorrectionLevel;
  /** Force a mask (0-7) instead of choosing the lowest-penalty one. */
  mask?: number;
}

/** An encoded symbol with the parameters the encoder chose. */
export interface QrSymbol {
  version: number;
  ecLevel: QrErrorCorrectionLevel;
  mask: number;
  modules: QrMatrix;
}

const BYTE_MODE_INDICATOR = 0b0100;
const PAD_CODEWORDS = [0xec, 0x11];
const FORMAT_GENERATOR = 0x537;
const FORMAT_XOR_MASK = 0x5412;
const VERSION_GENERATOR = 0x1f25;
const EC_LEVELS: readonly QrErrorCorrectionLevel[] = ["L", "M", "Q", "H"];

/** Encode `payload` and return the module matrix (no quiet zone). */
export function encodeQr(payload: string | Uint8Array, options: QrEncodeOptions = {}): QrMatrix {
  return encodeQrSymbol(payload, options).modules;
}

/** Encode `payload` and return the matrix plus the chosen version and mask. */
export function encodeQrSymbol(
  payload: string | Uint8Array,
  options: QrEncodeOptions = {},
): QrSymbol {
  const ecLevel = options.ecLevel ?? "M";
  if (!EC_LEVELS.includes(ecLevel)) {
    throw new ActionableError(`Unknown QR error-correction level "${ecLevel}". Use L, M, Q or H.`);
  }
  if (options.mask !== undefined && !isValidMask(options.mask)) {
    throw new ActionableError(`QR mask must be an integer from 0 to 7, got ${options.mask}.`);
  }
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const version = selectQrVersion(bytes.length, ecLevel);
  const data = encodeQrDataCodewords(bytes, version, ecLevel);
  const codewords = buildQrCodewords(data, version, ecLevel);
  const base = buildUnmaskedMatrix(codewords, version);
  const mask = options.mask ?? chooseMask(base, ecLevel);
  return { version, ecLevel, mask, modules: finishSymbol(base, ecLevel, mask) };
}

function isValidMask(mask: number): boolean {
  return Number.isInteger(mask) && mask >= 0 && mask < QR_MASK_COUNT;
}

/** Smallest supported version whose byte-mode capacity holds `byteLength`. */
export function selectQrVersion(byteLength: number, ecLevel: QrErrorCorrectionLevel): number {
  for (let version = QR_MIN_VERSION; version <= QR_MAX_VERSION; version++) {
    if (qrByteCapacity(version, ecLevel) >= byteLength) {
      return version;
    }
  }
  const limit = qrByteCapacity(QR_MAX_VERSION, ecLevel);
  throw new ActionableError(
    `QR payload is ${byteLength} bytes, but the encoder supports at most ${limit} bytes at error-correction level ${ecLevel} (version ${QR_MAX_VERSION}). Shorten the payload or use a lower error-correction level.`,
  );
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) {
    bits.push((value >>> i) & 1);
  }
}

/** Byte-mode segment, terminator, bit padding and pad codewords (sections 7.4.2-7.4.10). */
export function encodeQrDataCodewords(
  bytes: Uint8Array,
  version: number,
  ecLevel: QrErrorCorrectionLevel,
): number[] {
  const capacityBits = qrDataCodewordCount(version, ecLevel) * 8;
  const bits: number[] = [];
  appendBits(bits, BYTE_MODE_INDICATOR, 4);
  appendBits(bits, bytes.length, qrByteModeCountBits(version));
  for (const byte of bytes) {
    appendBits(bits, byte, 8);
  }
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  const codewords = Array.from({ length: bits.length / 8 }, (_unused, index) =>
    bits.slice(index * 8, index * 8 + 8).reduce((byte, bit) => (byte << 1) | bit, 0),
  );
  const padCount = capacityBits / 8 - codewords.length;
  const padding = Array.from({ length: padCount }, (_unused, index) => PAD_CODEWORDS[index % 2]);
  return [...codewords, ...padding];
}

function interleave(blocks: readonly number[][]): number[] {
  const longest = Math.max(...blocks.map((block) => block.length));
  return Array.from({ length: longest }, (_unused, index) =>
    blocks.filter((block) => index < block.length).map((block) => block[index]),
  ).flat();
}

/** Split data into blocks, append Reed-Solomon codewords, and interleave (section 7.6). */
export function buildQrCodewords(
  data: readonly number[],
  version: number,
  ecLevel: QrErrorCorrectionLevel,
): number[] {
  const layout = qrBlockLayout(version, ecLevel);
  const sizes = layout.groups.flatMap((group) =>
    Array.from({ length: group.count }, () => group.dataCodewords),
  );
  const offsets = sizes.map((_size, index) => sizes.slice(0, index).reduce((a, b) => a + b, 0));
  const dataBlocks = sizes.map((size, index) => data.slice(offsets[index], offsets[index] + size));
  const ecBlocks = dataBlocks.map((block) => rsComputeRemainder(block, layout.ecCodewordsPerBlock));
  return [...interleave(dataBlocks), ...interleave(ecBlocks)];
}

function bitLength(value: number): number {
  return 32 - Math.clz32(value);
}

function bchRemainder(value: number, generator: number): number {
  const degree = bitLength(generator) - 1;
  let remainder = value;
  while (bitLength(remainder) > degree) {
    remainder ^= generator << (bitLength(remainder) - 1 - degree);
  }
  return remainder;
}

/** 15-bit format information, MSB first (section 7.9). */
export function qrFormatBits(ecLevel: QrErrorCorrectionLevel, mask: number): number {
  const data = (EC_LEVEL_BITS[ecLevel] << 3) | mask;
  return ((data << 10) | bchRemainder(data << 10, FORMAT_GENERATOR)) ^ FORMAT_XOR_MASK;
}

/** 18-bit version information, MSB first (section 7.10); versions 7+. */
export function qrVersionBits(version: number): number {
  return (version << 12) | bchRemainder(version << 12, VERSION_GENERATOR);
}

function emptyGrid(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

/** Mutable matrix with a parallel map of function-pattern (non-data) modules. */
class QrMatrixBuilder {
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(size: number, modules?: boolean[][], reserved?: boolean[][]) {
    this.size = size;
    this.modules = modules ?? emptyGrid(size);
    this.reserved = reserved ?? emptyGrid(size);
  }

  setFunction(row: number, column: number, dark: boolean): void {
    this.modules[row][column] = dark;
    this.reserved[row][column] = true;
  }

  inBounds(row: number, column: number): boolean {
    return row >= 0 && row < this.size && column >= 0 && column < this.size;
  }
}

function drawFinder(builder: QrMatrixBuilder, top: number, left: number): void {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const distance = Math.max(Math.abs(dy - 3), Math.abs(dx - 3));
      if (builder.inBounds(top + dy, left + dx)) {
        builder.setFunction(top + dy, left + dx, distance !== 2 && distance !== 4);
      }
    }
  }
}

function drawAlignment(builder: QrMatrixBuilder, centreRow: number, centreColumn: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      builder.setFunction(
        centreRow + dy,
        centreColumn + dx,
        Math.max(Math.abs(dy), Math.abs(dx)) !== 1,
      );
    }
  }
}

function drawAlignments(builder: QrMatrixBuilder, version: number): void {
  const centres = qrAlignmentCentres(version);
  const last = centres.length - 1;
  centres.forEach((row, rowIndex) =>
    centres.forEach((column, columnIndex) => {
      const overlapsFinder =
        (rowIndex === 0 && columnIndex === 0) ||
        (rowIndex === 0 && columnIndex === last) ||
        (rowIndex === last && columnIndex === 0);
      if (!overlapsFinder) {
        drawAlignment(builder, row, column);
      }
    }),
  );
}

function drawTiming(builder: QrMatrixBuilder): void {
  for (let i = 8; i < builder.size - 8; i++) {
    builder.setFunction(6, i, i % 2 === 0);
    builder.setFunction(i, 6, i % 2 === 0);
  }
}

/** Write format bits (bit 0 = LSB) into both copies; also reserves the areas. */
function drawFormat(builder: QrMatrixBuilder, format: number): void {
  const size = builder.size;
  const bit = (index: number): boolean => ((format >>> index) & 1) === 1;
  for (let i = 0; i <= 5; i++) {
    builder.setFunction(i, 8, bit(i));
  }
  builder.setFunction(7, 8, bit(6));
  builder.setFunction(8, 8, bit(7));
  builder.setFunction(8, 7, bit(8));
  for (let i = 9; i < 15; i++) {
    builder.setFunction(8, 14 - i, bit(i));
  }
  for (let i = 0; i < 8; i++) {
    builder.setFunction(8, size - 1 - i, bit(i));
  }
  for (let i = 8; i < 15; i++) {
    builder.setFunction(size - 15 + i, 8, bit(i));
  }
  // The single dark module beside the lower-left finder (section 7.9.1).
  builder.setFunction(size - 8, 8, true);
}

function drawVersion(builder: QrMatrixBuilder, version: number): void {
  if (version < 7) {
    return;
  }
  const bits = qrVersionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const near = Math.floor(i / 3);
    const far = builder.size - 11 + (i % 3);
    builder.setFunction(near, far, dark);
    builder.setFunction(far, near, dark);
  }
}

function drawFunctionPatterns(builder: QrMatrixBuilder, version: number): void {
  const size = builder.size;
  drawFinder(builder, 0, 0);
  drawFinder(builder, 0, size - 7);
  drawFinder(builder, size - 7, 0);
  drawTiming(builder);
  drawAlignments(builder, version);
  // Reserve the format areas now; real bits are written per mask.
  drawFormat(builder, 0);
  drawVersion(builder, version);
}

function placeColumnPair(
  builder: QrMatrixBuilder,
  right: number,
  upward: boolean,
  next: () => boolean,
): void {
  for (let step = 0; step < builder.size; step++) {
    const row = upward ? builder.size - 1 - step : step;
    for (const column of [right, right - 1]) {
      if (!builder.reserved[row][column]) {
        builder.modules[row][column] = next();
      }
    }
  }
}

/** Zigzag data placement from the bottom-right corner (section 7.7.3). */
function placeCodewords(builder: QrMatrixBuilder, codewords: readonly number[]): void {
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  const next = (): boolean => {
    const index = bitIndex++;
    // Remainder bits past the last codeword are light (0).
    return index < totalBits && ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) === 1;
  };
  let upward = true;
  for (let right = builder.size - 1; right >= 1; right -= 2) {
    // Column 6 holds the vertical timing pattern and is skipped entirely.
    placeColumnPair(builder, right <= 6 ? right - 1 : right, upward, next);
    upward = !upward;
  }
}

function buildUnmaskedMatrix(codewords: readonly number[], version: number): QrMatrixBuilder {
  const builder = new QrMatrixBuilder(qrSymbolSize(version));
  drawFunctionPatterns(builder, version);
  placeCodewords(builder, codewords);
  return builder;
}

function finishSymbol(
  base: QrMatrixBuilder,
  ecLevel: QrErrorCorrectionLevel,
  mask: number,
): QrMatrix {
  const masked = base.modules.map((row, rowIndex) =>
    row.map((dark, column) => {
      const flip = !base.reserved[rowIndex][column] && qrMaskApplies(mask, rowIndex, column);
      return dark !== flip;
    }),
  );
  const builder = new QrMatrixBuilder(
    base.size,
    masked,
    base.reserved.map((row) => [...row]),
  );
  drawFormat(builder, qrFormatBits(ecLevel, mask));
  return builder.modules;
}

function chooseMask(base: QrMatrixBuilder, ecLevel: QrErrorCorrectionLevel): number {
  const scores = Array.from(
    { length: QR_MASK_COUNT },
    (_unused, mask) => qrMaskPenalty(finishSymbol(base, ecLevel, mask)).total,
  );
  return scores.indexOf(Math.min(...scores));
}

/**
 * Build a symbol from already-computed final codewords with a fixed mask.
 * Exposed so tests can check placement against published codeword vectors.
 */
export function buildQrMatrix(
  codewords: readonly number[],
  version: number,
  ecLevel: QrErrorCorrectionLevel,
  mask: number,
): QrMatrix {
  return finishSymbol(buildUnmaskedMatrix(codewords, version), ecLevel, mask);
}
