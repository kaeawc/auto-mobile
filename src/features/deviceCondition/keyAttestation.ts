import {
  derChildren,
  derEnum,
  derUnsigned,
  expectDer,
  singleDer,
  type DerValue,
} from "./attestationDer";

export interface AttestationChainSource {
  exportAttestation(): Promise<string[]>;
}

export interface AttestationFields {
  attestationSecurityLevel: number;
  keymasterSecurityLevel: number;
  deviceLocked: boolean | null;
  verifiedBootState: number | null;
  attestationApplicationId: {
    base64: string;
    packageInfos: { packageName: string; version: string }[];
    signatureDigestsBase64: string[];
  } | null;
}

const ATTESTATION_OID = Buffer.from([0x2b, 6, 1, 4, 1, 0xd6, 0x79, 2, 1, 17]);

function authorizationField(lists: DerValue[][], tag: number): DerValue | undefined {
  const fields = lists.flat().filter((v) => v.tagClass === 2 && v.tag === tag);
  if (fields.length > 1) {
    throw new Error(`Duplicate attestation authorization ${tag}`);
  }
  if (!fields.length) {
    return undefined;
  }
  const children = derChildren(fields[0], tag, 2);
  if (children.length !== 1) {
    throw new Error("Invalid explicit authorization");
  }
  return children[0];
}

function applicationId(value: DerValue | undefined): AttestationFields["attestationApplicationId"] {
  if (!value) {
    return null;
  }
  const bytes = expectDer(value, 4).bytes;
  const fields = derChildren(singleDer(bytes));
  if (fields.length !== 2) {
    throw new Error("Invalid attestation application ID");
  }
  const packageInfos = derChildren(fields[0], 17).map((item) => {
    const pair = derChildren(item);
    if (pair.length !== 2) {
      throw new Error("Invalid attestation package info");
    }
    return {
      packageName: new TextDecoder("utf-8", { fatal: true }).decode(expectDer(pair[0], 4).bytes),
      version: derUnsigned(pair[1]).toString(),
    };
  });
  const signatureDigestsBase64 = derChildren(fields[1], 17).map((item) =>
    expectDer(item, 4).bytes.toString("base64"),
  );
  return { base64: bytes.toString("base64"), packageInfos, signatureDigestsBase64 };
}

function rootOfTrust(value: DerValue | undefined) {
  if (!value) {
    return { deviceLocked: null, verifiedBootState: null };
  }
  const fields = derChildren(value);
  if (fields.length !== 3 && fields.length !== 4) {
    throw new Error("Invalid RootOfTrust");
  }
  expectDer(fields[0], 4);
  if (fields[3]) {
    expectDer(fields[3], 4);
  }
  const locked = expectDer(fields[1], 1).bytes;
  if (locked.length !== 1 || (locked[0] !== 0 && locked[0] !== 255)) {
    throw new Error("Invalid DER boolean");
  }
  return { deviceLocked: locked[0] !== 0, verifiedBootState: derEnum(fields[2]) };
}

/** Decode the leaf's Android attestation extension; absent optional fields stay null.
 * Numeric enum values are preserved, including future Android values. No trust verdict is made.
 */
export function parseKeyAttestationCertificate(certificateDer: Buffer): AttestationFields {
  const certificate = derChildren(singleDer(certificateDer));
  if (certificate.length !== 3) {
    throw new Error("Invalid X.509 certificate envelope");
  }
  const tbs = derChildren(certificate[0]);
  const extensions = tbs.filter((v) => v.tagClass === 2 && v.tag === 3);
  if (extensions.length !== 1) {
    throw new Error("Missing X.509 extensions");
  }
  const wrapper = derChildren(extensions[0], 3, 2);
  if (wrapper.length !== 1) {
    throw new Error("Invalid X.509 extensions");
  }
  const matches = derChildren(wrapper[0])
    .map((v) => derChildren(v))
    .filter((fields) => expectDer(fields[0], 6).bytes.equals(ATTESTATION_OID));
  if (matches.length !== 1) {
    throw new Error("Missing or duplicate Android key attestation extension");
  }
  const extension = matches[0];
  if (extension.length !== 2 && extension.length !== 3) {
    throw new Error("Invalid X.509 extension");
  }
  if (extension.length === 3) {
    expectDer(extension[1], 1);
  }
  const description = derChildren(singleDer(expectDer(extension.at(-1), 4).bytes));
  if (description.length !== 8) {
    throw new Error("Invalid Android KeyDescription");
  }
  derUnsigned(description[0]);
  derUnsigned(description[2]);
  expectDer(description[4], 4);
  expectDer(description[5], 4);
  const lists = [derChildren(description[6]), derChildren(description[7])];
  return {
    attestationSecurityLevel: derEnum(description[1]),
    keymasterSecurityLevel: derEnum(description[3]),
    ...rootOfTrust(authorizationField(lists, 704)),
    attestationApplicationId: applicationId(authorizationField(lists, 709)),
  };
}

export function decodeAttestationCertificate(base64: string): Buffer {
  if (base64.length > 175000) {
    throw new Error("Attestation certificate exceeds size limit");
  }
  const der = Buffer.from(base64, "base64");
  if (!der.length || der.length > 128 * 1024 || der.toString("base64") !== base64) {
    throw new Error("Invalid base64 DER certificate");
  }
  return der;
}
