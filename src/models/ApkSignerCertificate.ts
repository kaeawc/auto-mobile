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
