// Synthetic schema fixtures, not captured certificates: no attestation capture exists in the repo.
// This DER encoder builds X.509/KeyDescription structures, without keys or valid signatures.
export function der(tag: number | number[], ...parts: Uint8Array[]): Buffer {
  const body = Buffer.concat(parts);
  const length =
    body.length < 128
      ? [body.length]
      : body.length < 256
        ? [0x81, body.length]
        : [0x82, body.length >> 8, body.length & 255];
  return Buffer.concat([
    Buffer.from(typeof tag === "number" ? [tag] : tag),
    Buffer.from(length),
    body,
  ]);
}
export const seq = (...parts: Uint8Array[]) => der(0x30, ...parts);
export const octet = (bytes: Uint8Array) => der(4, bytes);
export const integer = (n: number, tag = 2) => der(tag, Buffer.from([n]));
export const explicit = (n: number, value: Uint8Array) =>
  der([0xbf, 0x80 | (n >> 7), n & 127], value);
export function keyDescription(options: { hardware?: boolean; missing?: boolean } = {}): Buffer {
  const app = seq(
    der(0x31, seq(octet(Buffer.from("dev.test.proxy")), integer(7))),
    der(0x31, octet(Buffer.alloc(32, 1))),
  );
  const fields = options.missing
    ? []
    : [
        explicit(
          704,
          seq(
            octet(Buffer.alloc(32)),
            der(1, Buffer.from([0])),
            integer(2, 10),
            octet(Buffer.alloc(32)),
          ),
        ),
        explicit(709, octet(app)),
      ];
  return seq(
    integer(3),
    integer(0, 10),
    integer(4),
    integer(1, 10),
    octet(Buffer.from("challenge")),
    octet(Buffer.alloc(0)),
    seq(...(options.hardware ? [] : fields)),
    seq(...(options.hardware ? fields : [])),
  );
}
export function certificate(extension: Buffer = keyDescription()): Buffer {
  // Certificate { tbsCertificate { version, serial, signature, issuer, validity, subject,
  // subjectPublicKeyInfo, extensions [3] }, signatureAlgorithm, signatureValue }.
  const oid = der(6, Buffer.from([0x2b, 6, 1, 4, 1, 0xd6, 0x79, 2, 1, 17]));
  return seq(
    seq(
      der(0xa0, integer(2)),
      integer(1),
      seq(),
      seq(),
      seq(),
      seq(),
      seq(),
      der(0xa3, seq(seq(oid, octet(extension)))),
    ),
    seq(),
    der(3, Buffer.from([0])),
  );
}
