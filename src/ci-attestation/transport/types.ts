export type AttestationDecisionKind = "skip" | "advisory" | "ignore";

export const decisionReasons = [
  "verified-match",
  "no-attestation",
  "hash-mismatch",
  "stale",
  "env-mismatch",
  "policy-tier",
  "transport-unavailable",
  "invalid-response",
  "unauthenticated",
] as const;

export type AttestationDecisionReason = (typeof decisionReasons)[number];

export interface AttestationDecision {
  kind: AttestationDecisionKind;
  reason: AttestationDecisionReason;
  detail?: string;
}

export interface AttestationUploadRequest {
  inputHash: string;
  tier: number;
  /** Signed envelope JSON; only the service interprets or verifies it. */
  envelope: unknown;
}

export type AttestationUploadResult = { ok: true; id?: string } | { ok: false; reason: string };

export interface AttestationUploader {
  upload(req: AttestationUploadRequest): Promise<AttestationUploadResult>;
}

export interface AttestationQuery {
  owner: string;
  repo: string;
  sha: string;
  tier: number;
  inputHash: string;
}

export interface AttestationDecisionSource {
  decide(query: AttestationQuery): Promise<AttestationDecision>;
}

export class NoopAttestationUploader implements AttestationUploader {
  upload(_req: AttestationUploadRequest): Promise<AttestationUploadResult> {
    return Promise.resolve({ ok: false, reason: "uploads-disabled" });
  }
}

export interface Clock {
  nowMs(): number;
}

export type InstallationTokenPurpose = "service" | "checks";

export interface InstallationTokenProvider {
  getInstallationToken(
    owner: string,
    repo: string,
    purpose: InstallationTokenPurpose,
  ): Promise<string>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAttestationDecision(value: unknown): value is AttestationDecision {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !decisionReasons.some((reason) => reason === value.reason) ||
    (value.detail !== undefined && typeof value.detail !== "string")
  ) {
    return false;
  }
  switch (value.kind) {
    case "skip":
      return value.reason === "verified-match";
    case "advisory":
      return [
        "policy-tier",
        "verified-match",
        "stale",
        "env-mismatch",
        "hash-mismatch",
        "no-attestation",
      ].some((reason) => reason === value.reason);
    case "ignore":
      return true;
    default:
      return false;
  }
}
