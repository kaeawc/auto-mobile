import { createHash } from "node:crypto";

/**
 * Reads the signing certificates of an APK from its APK Signing Block (signature schemes v2, v3
 * and v3.1). Nothing here verifies signatures: the on-device APK was already verified by
 * PackageManager at install time, so this only reports which certificates it carries.
 *
 * Format reference: https://source.android.com/docs/security/features/apksigning/v2 and /v3.
 */

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_LENGTH = 22;
const EOCD_MAX_COMMENT = 0xffff;
const ZIP64_MARKER = 0xffffffff;
const SIGNING_BLOCK_MAGIC = "APK Sig Block 42";
const SIGNING_BLOCK_FOOTER_LENGTH = 24;
/** Upper bound for the signing block we are willing to buffer (it is normally a few KiB). */
const MAX_SIGNING_BLOCK_BYTES = 16 * 1024 * 1024;

const V2_BLOCK_ID = 0x7109871a;
const V3_BLOCK_ID = 0xf05368c0;
const V31_BLOCK_ID = 0x1b93ad61;
const V3_LINEAGE_ATTRIBUTE_ID = 0x3ba06f8c;

export type ApkSignatureScheme = "v2" | "v3" | "v3.1";

export interface ApkSignerCertificate {
  /** Lowercase hex SHA-256 of the DER-encoded signer certificate. */
  sha256: string;
  /** v3/v3.1 only: first platform SDK this signer applies to. */
  minSdkVersion?: number;
  /** v3/v3.1 only: last platform SDK this signer applies to. */
  maxSdkVersion?: number;
  /** v3/v3.1 only: certificate history from the signing-certificate lineage, oldest first. */
  lineage?: string[];
}

export type ApkSigningSchemes = Partial<Record<ApkSignatureScheme, ApkSignerCertificate[]>>;

/** Random-access read of the APK so a large file never has to be buffered whole. */
export interface ApkByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export class ApkSigningParseError extends Error {}

export function bufferByteSource(buffer: Buffer): ApkByteSource {
  return {
    size: buffer.length,
    read: async (offset, length) => buffer.subarray(offset, offset + length),
  };
}

class Cursor {
  private position = 0;
  constructor(private readonly buffer: Buffer) {}

  get remaining(): number {
    return this.buffer.length - this.position;
  }

  u32(): number {
    this.require(4);
    const value = this.buffer.readUInt32LE(this.position);
    this.position += 4;
    return value;
  }

  /** Everything not yet read. */
  rest(): Buffer {
    const slice = this.buffer.subarray(this.position);
    this.position = this.buffer.length;
    return slice;
  }

  /** A u32 length followed by that many bytes. */
  lengthPrefixed(): Buffer {
    const length = this.u32();
    this.require(length);
    const slice = this.buffer.subarray(this.position, this.position + length);
    this.position += length;
    return slice;
  }

  private require(length: number): void {
    if (length > this.remaining) {
      throw new ApkSigningParseError("Truncated APK signing data");
    }
  }
}

function sha256Hex(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex");
}

async function locateCentralDirectory(source: ApkByteSource): Promise<number> {
  const tailLength = Math.min(source.size, EOCD_MIN_LENGTH + EOCD_MAX_COMMENT);
  const tail = await source.read(source.size - tailLength, tailLength);
  for (let index = tail.length - EOCD_MIN_LENGTH; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + EOCD_MIN_LENGTH + commentLength !== tail.length) {
      continue;
    }
    const offset = tail.readUInt32LE(index + 16);
    if (offset === ZIP64_MARKER) {
      throw new ApkSigningParseError("ZIP64 APKs are not supported");
    }
    return offset;
  }
  throw new ApkSigningParseError("Not a ZIP archive: end of central directory not found");
}

/** The signing block's id-value pairs, or null when the APK has no signing block (v1-only). */
async function readSigningBlockPairs(source: ApkByteSource): Promise<Map<number, Buffer> | null> {
  const centralDirectoryOffset = await locateCentralDirectory(source);
  if (centralDirectoryOffset < SIGNING_BLOCK_FOOTER_LENGTH) {
    return null;
  }
  const footer = await source.read(
    centralDirectoryOffset - SIGNING_BLOCK_FOOTER_LENGTH,
    SIGNING_BLOCK_FOOTER_LENGTH,
  );
  if (footer.subarray(8).toString("latin1") !== SIGNING_BLOCK_MAGIC) {
    return null;
  }
  const blockSize = Number(footer.readBigUInt64LE(0));
  // blockSize excludes the leading size field but includes the footer's size and magic.
  const blockStart = centralDirectoryOffset - blockSize - 8;
  if (
    blockSize < SIGNING_BLOCK_FOOTER_LENGTH ||
    blockSize > MAX_SIGNING_BLOCK_BYTES ||
    blockStart < 0
  ) {
    throw new ApkSigningParseError("Invalid APK signing block size");
  }
  const block = await source.read(blockStart, blockSize + 8);
  if (Number(block.readBigUInt64LE(0)) !== blockSize) {
    throw new ApkSigningParseError("APK signing block header and footer sizes differ");
  }
  const pairs = new Map<number, Buffer>();
  let position = 8;
  const pairsEnd = block.length - SIGNING_BLOCK_FOOTER_LENGTH;
  while (position < pairsEnd) {
    if (position + 12 > pairsEnd) {
      throw new ApkSigningParseError("Truncated APK signing block pair");
    }
    const pairLength = Number(block.readBigUInt64LE(position));
    if (pairLength < 4 || position + 8 + pairLength > pairsEnd) {
      throw new ApkSigningParseError("Invalid APK signing block pair length");
    }
    const id = block.readUInt32LE(position + 8);
    pairs.set(id, block.subarray(position + 12, position + 8 + pairLength));
    position += 8 + pairLength;
  }
  return pairs;
}

function parseCertificateSequence(sequence: Buffer): Buffer[] {
  const cursor = new Cursor(sequence);
  const certificates: Buffer[] = [];
  while (cursor.remaining > 0) {
    certificates.push(cursor.lengthPrefixed());
  }
  return certificates;
}

function signerCertificate(certificates: Buffer[]): Buffer {
  const first = certificates[0];
  if (!first) {
    throw new ApkSigningParseError("APK signer carries no certificate");
  }
  return first;
}

/** Node layout: [signedData: [certificate, sigAlgorithm]] [flags] [sigAlgorithm] [signature]. */
function parseLineage(value: Buffer): string[] {
  const cursor = new Cursor(value);
  cursor.u32(); // lineage format version
  const history: string[] = [];
  while (cursor.remaining > 0) {
    const node = new Cursor(cursor.lengthPrefixed());
    const signedData = new Cursor(node.lengthPrefixed());
    history.push(sha256Hex(signedData.lengthPrefixed()));
  }
  return history;
}

function parseV2Signers(value: Buffer): ApkSignerCertificate[] {
  const signers = new Cursor(new Cursor(value).lengthPrefixed());
  const result: ApkSignerCertificate[] = [];
  while (signers.remaining > 0) {
    const signer = new Cursor(signers.lengthPrefixed());
    const signedData = new Cursor(signer.lengthPrefixed());
    signedData.lengthPrefixed(); // digests
    const certificates = parseCertificateSequence(signedData.lengthPrefixed());
    result.push({ sha256: sha256Hex(signerCertificate(certificates)) });
  }
  return result;
}

function parseV3Signers(value: Buffer): ApkSignerCertificate[] {
  const signers = new Cursor(new Cursor(value).lengthPrefixed());
  const result: ApkSignerCertificate[] = [];
  while (signers.remaining > 0) {
    const signer = new Cursor(signers.lengthPrefixed());
    const signedData = new Cursor(signer.lengthPrefixed());
    signedData.lengthPrefixed(); // digests
    const certificates = parseCertificateSequence(signedData.lengthPrefixed());
    const minSdkVersion = signedData.u32();
    const maxSdkVersion = signedData.u32();
    const attributes = new Cursor(signedData.lengthPrefixed());
    let lineage: string[] | undefined;
    while (attributes.remaining > 0) {
      const attribute = new Cursor(attributes.lengthPrefixed());
      if (attribute.u32() === V3_LINEAGE_ATTRIBUTE_ID) {
        lineage = parseLineage(attribute.rest());
      }
    }
    result.push({
      sha256: sha256Hex(signerCertificate(certificates)),
      minSdkVersion,
      maxSdkVersion,
      ...(lineage ? { lineage } : {}),
    });
  }
  return result;
}

/**
 * Signer certificates per signature scheme present in the APK, or null when the APK has no APK
 * Signing Block (v1/JAR-only signing is not read). Throws {@link ApkSigningParseError} when the
 * archive or block is malformed.
 */
export async function readApkSigningSchemes(
  source: ApkByteSource,
): Promise<ApkSigningSchemes | null> {
  const pairs = await readSigningBlockPairs(source);
  if (!pairs) {
    return null;
  }
  const schemes: ApkSigningSchemes = {};
  const v2 = pairs.get(V2_BLOCK_ID);
  const v3 = pairs.get(V3_BLOCK_ID);
  const v31 = pairs.get(V31_BLOCK_ID);
  if (v2) {
    schemes.v2 = parseV2Signers(v2);
  }
  if (v3) {
    schemes.v3 = parseV3Signers(v3);
  }
  if (v31) {
    schemes["v3.1"] = parseV3Signers(v31);
  }
  return schemes;
}
