import { decisionReasons, type ServiceDecision } from "../attestationSchema";
export {
  decisionReasons,
  type ServiceDecision,
  type ServiceDecisionReason,
  type AttestationVerdict,
  type Clock,
} from "../attestationSchema";

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

export interface ServiceDecisionSource {
  decide(query: AttestationQuery): Promise<ServiceDecision>;
}

export class NoopAttestationUploader implements AttestationUploader {
  upload(_req: AttestationUploadRequest): Promise<AttestationUploadResult> {
    return Promise.resolve({ ok: false, reason: "uploads-disabled" });
  }
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

export function isServiceDecision(value: unknown): value is ServiceDecision {
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
