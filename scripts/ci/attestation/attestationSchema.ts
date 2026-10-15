import { createHash } from "node:crypto";

export const ATTESTATION_ENVELOPE_VERSION = 1 as const;
export type AttestationTier = 1 | 2 | 3;
export type AttestationLane = "node" | "android" | "ios";
export const LANE_TIER: Record<AttestationLane, AttestationTier> = { node: 1, android: 2, ios: 3 };
export interface GateResult {
  name: string;
  status: "pass" | "fail" | "skip";
  durationSeconds: number;
}
export interface AttestationPayload {
  payloadType: string;
  payloadVersion: number;
  tier: AttestationTier;
  lane: AttestationLane;
  inputHash: string;
  inputHashAlgorithm: string;
  commitId: string;
  scope: "full" | "partial";
  scopeNote: string;
  gates: GateResult[];
  overall: "pass" | "fail";
  environment: {
    os: string;
    arch: string;
    bunVersion: string | null;
    toolVersions: Record<string, string>;
  };
  producedAt: string;
}
export interface AttestationSignature {
  keyId: string;
  algorithm: string;
  value: string;
}
export interface AttestationEnvelope {
  envelopeVersion: 1;
  payload: AttestationPayload;
  signature: AttestationSignature | null;
}

export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}
export function canonicalizePayload(p: AttestationPayload): string {
  return JSON.stringify(sortValue(p));
}
export function attestationId(env: AttestationEnvelope): string {
  return createHash("sha256").update(canonicalizePayload(env.payload)).digest("hex");
}

type ParseResult =
  | { ok: true; envelope: AttestationEnvelope; signed: boolean }
  | { ok: false; reason: string };
const objectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function isSha256Hex(value: string): boolean {
  if (value.length !== 64) {
    return false;
  }
  for (const character of value) {
    if (!(character >= "0" && character <= "9") && !(character >= "a" && character <= "f")) {
      return false;
    }
  }
  return true;
}
export function parseEnvelope(raw: unknown): ParseResult {
  if (
    !objectRecord(raw) ||
    !hasExactKeys(raw, ["envelopeVersion", "payload", "signature"]) ||
    raw.envelopeVersion !== ATTESTATION_ENVELOPE_VERSION ||
    !objectRecord(raw.payload)
  ) {
    return { ok: false, reason: "invalid envelope or version" };
  }
  const p = raw.payload;
  if (
    !hasExactKeys(p, [
      "payloadType",
      "payloadVersion",
      "tier",
      "lane",
      "inputHash",
      "inputHashAlgorithm",
      "commitId",
      "scope",
      "scopeNote",
      "gates",
      "overall",
      "environment",
      "producedAt",
    ])
  ) {
    return { ok: false, reason: "invalid payload shape" };
  }
  const lanes: AttestationLane[] = ["node", "android", "ios"];
  if (
    typeof p.lane !== "string" ||
    !lanes.includes(p.lane as AttestationLane) ||
    p.tier !== LANE_TIER[p.lane as AttestationLane]
  ) {
    return { ok: false, reason: "lane and tier mismatch" };
  }
  if (
    typeof p.payloadType !== "string" ||
    p.payloadType !== `auto-mobile.prepush.${p.lane}` ||
    typeof p.payloadVersion !== "number" ||
    !Number.isInteger(p.payloadVersion) ||
    p.payloadVersion !== 1 ||
    typeof p.inputHash !== "string" ||
    !isSha256Hex(p.inputHash) ||
    typeof p.inputHashAlgorithm !== "string" ||
    typeof p.commitId !== "string" ||
    !p.commitId ||
    !p.inputHashAlgorithm ||
    (p.scope !== "full" && p.scope !== "partial") ||
    typeof p.scopeNote !== "string" ||
    !Array.isArray(p.gates) ||
    p.gates.length === 0 ||
    (p.overall !== "pass" && p.overall !== "fail") ||
    typeof p.producedAt !== "string" ||
    !objectRecord(p.environment)
  ) {
    return { ok: false, reason: "invalid payload fields" };
  }
  for (const gate of p.gates) {
    if (
      !objectRecord(gate) ||
      !hasExactKeys(gate, ["name", "status", "durationSeconds"]) ||
      typeof gate.name !== "string" ||
      !gate.name.trim() ||
      typeof gate.status !== "string" ||
      !["pass", "fail", "skip"].includes(gate.status) ||
      typeof gate.durationSeconds !== "number" ||
      !Number.isFinite(gate.durationSeconds) ||
      gate.durationSeconds < 0
    ) {
      return { ok: false, reason: "invalid gate" };
    }
  }
  const timestamp = Date.parse(p.producedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== p.producedAt) {
    return { ok: false, reason: "invalid producedAt" };
  }
  if ((p.overall === "fail") !== p.gates.some((gate) => gate.status === "fail")) {
    return { ok: false, reason: "overall inconsistent with gates" };
  }
  const e = p.environment;
  if (
    !hasExactKeys(e, ["os", "arch", "bunVersion", "toolVersions"]) ||
    typeof e.os !== "string" ||
    typeof e.arch !== "string" ||
    (e.bunVersion !== null && typeof e.bunVersion !== "string") ||
    !objectRecord(e.toolVersions) ||
    Object.values(e.toolVersions).some((v) => typeof v !== "string")
  ) {
    return { ok: false, reason: "invalid environment" };
  }
  const signature = raw.signature;
  if (
    signature !== null &&
    (!objectRecord(signature) ||
      !hasExactKeys(signature, ["keyId", "algorithm", "value"]) ||
      typeof signature.keyId !== "string" ||
      typeof signature.algorithm !== "string" ||
      typeof signature.value !== "string")
  ) {
    return { ok: false, reason: "invalid signature" };
  }
  return { ok: true, envelope: raw as AttestationEnvelope, signed: signature !== null };
}
