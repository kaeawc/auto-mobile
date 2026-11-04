/** Bounded DER reader for X.509's extension envelope and Android KeyDescription only.
 * node:crypto.X509Certificate exposes no arbitrary-extension accessor. This reader
 * decodes structure; it does not verify certificate signatures or establish trust.
 */
export interface DerValue {
  tagClass: number;
  tag: number;
  constructed: boolean;
  bytes: Buffer;
}

function readTag(bytes: Buffer, offset: number): { tag: number; offset: number } {
  let tag = 0;
  let next: number;
  do {
    if (offset >= bytes.length || tag > 0x1fffff) {
      throw new Error("Invalid DER tag");
    }
    next = bytes[offset++];
    if (tag === 0 && (next & 127) === 0) {
      throw new Error("Noncanonical DER tag");
    }
    tag = tag * 128 + (next & 127);
  } while (next & 128);
  if (tag < 31) {
    throw new Error("Noncanonical DER tag");
  }
  return { tag, offset };
}

function readLength(bytes: Buffer, offset: number): { length: number; offset: number } {
  if (offset >= bytes.length) {
    throw new Error("Missing DER length");
  }
  let length = bytes[offset++];
  if (!(length & 128)) {
    return { length, offset };
  }
  const count = length & 127;
  if (count === 0 || count > 4 || offset + count > bytes.length || bytes[offset] === 0) {
    throw new Error("Invalid DER length");
  }
  length = 0;
  for (let i = 0; i < count; i++) {
    length = length * 256 + bytes[offset++];
  }
  if (length < 128) {
    throw new Error("Noncanonical DER length");
  }
  return { length, offset };
}

export function readDerValues(bytes: Buffer): DerValue[] {
  const values: DerValue[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const first = bytes[offset++];
    let tag = first & 31;
    if (tag === 31) {
      ({ tag, offset } = readTag(bytes, offset));
    }
    const lengthInfo = readLength(bytes, offset);
    offset = lengthInfo.offset;
    const length = lengthInfo.length;
    if (length > bytes.length - offset) {
      throw new Error("Truncated DER value");
    }
    values.push({
      tagClass: first >> 6,
      tag,
      constructed: (first & 32) !== 0,
      bytes: bytes.subarray(offset, offset + length),
    });
    offset += length;
  }
  return values;
}

export function expectDer(
  value: DerValue | undefined,
  tag: number,
  constructed = false,
  tagClass = 0,
): DerValue {
  if (
    !value ||
    value.tag !== tag ||
    value.tagClass !== tagClass ||
    value.constructed !== constructed
  ) {
    throw new Error(`Expected DER tag ${tagClass}:${tag}`);
  }
  return value;
}

export function derChildren(value: DerValue | undefined, tag = 16, tagClass = 0): DerValue[] {
  return readDerValues(expectDer(value, tag, true, tagClass).bytes);
}

export function singleDer(bytes: Buffer): DerValue {
  const values = readDerValues(bytes);
  if (values.length !== 1) {
    throw new Error("Expected exactly one DER value");
  }
  return values[0];
}

export function derUnsigned(value: DerValue | undefined, tag = 2): bigint {
  const bytes = expectDer(value, tag).bytes;
  if (
    !bytes.length ||
    bytes[0] & 128 ||
    (bytes.length > 1 && bytes[0] === 0 && !(bytes[1] & 128))
  ) {
    throw new Error("Invalid unsigned DER integer");
  }
  return BigInt(`0x${bytes.toString("hex")}`);
}

export function derEnum(value: DerValue | undefined): number {
  const n = derUnsigned(value, 10);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("DER enum out of range");
  }
  return Number(n);
}
