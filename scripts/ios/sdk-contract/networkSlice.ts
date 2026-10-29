import type { ContractBoundary, ContractFinding } from "./boundaries";
import type { ExpectedNetworkEvent, SdkContractManifest } from "./manifest";

export const NETWORK_SLICE = "network";
export const REDACTED = "<redacted>";

type JsonRecord = Record<string, unknown>;

/** One expected case and what each layer reported for it. Absent means "not found there". */
export interface NetworkCaseObservation {
  expected: ExpectedNetworkEvent;
  /** The SDK's own encoded payload, decoded from the manifest's captured envelopes. */
  sdkPayload: JsonRecord | undefined;
  /** The SDK's bytes replayed in-process through the production decoder, ingestor and resource. */
  reference: { row: JsonRecord; detail: JsonRecord } | undefined;
  /** The `automobile:network/request/{id}` detail the live daemon serves. */
  live: JsonRecord | undefined;
  /** Whether CtrlProxy still queued the event; probed only when `live` is absent. */
  queuedInCtrlProxy: boolean | undefined;
}

/** Scalar fields a scenario asserts; the SDK spells `protocol` as `protocolName` on the wire. */
const SCALAR_FIELDS = [
  ["url", "url"],
  ["method", "method"],
  ["protocolName", "protocol"],
  ["direction", "direction"],
  ["requestId", "requestId"],
  ["connectionId", "connectionId"],
  ["statusCode", "statusCode"],
  ["requestBodySize", "requestBodySize"],
  ["responseBodySize", "responseBodySize"],
  ["responseBody", "responseBody"],
] as const satisfies ReadonlyArray<readonly [keyof ExpectedNetworkEvent, string]>;

type FieldSpelling = "wire" | "surface";

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** Lists every asserted field whose value in `actual` differs from the scenario's input. */
export function networkFieldMismatches(
  expected: ExpectedNetworkEvent,
  actual: JsonRecord,
  spelling: FieldSpelling,
): string[] {
  const mismatches: string[] = [];
  for (const [expectedKey, surfaceKey] of SCALAR_FIELDS) {
    const want = expected[expectedKey];
    const key = spelling === "wire" ? expectedKey : surfaceKey;
    if (want !== undefined && actual[key] !== want) {
      mismatches.push(
        `${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(actual[key])}`,
      );
    }
  }
  const metadata = asRecord(actual.metadata) ?? {};
  for (const [key, want] of Object.entries(expected.metadata ?? {})) {
    if (metadata[key] !== want) {
      mismatches.push(
        `metadata.${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(metadata[key])}`,
      );
    }
  }
  const headers = asRecord(actual.requestHeaders) ?? {};
  for (const name of expected.redactedRequestHeaders ?? []) {
    if (headers[name] !== REDACTED) {
      mismatches.push(
        `requestHeaders.${name}: expected ${REDACTED}, got ${JSON.stringify(headers[name])}`,
      );
    }
  }
  return mismatches;
}

/** Fields whose values differ between two records, ignoring the per-database `id`. */
export function recordDifferences(reference: JsonRecord, live: JsonRecord): string[] {
  const keys = new Set([...Object.keys(reference), ...Object.keys(live)]);
  keys.delete("id");
  return [...keys]
    .sort()
    .filter((key) => JSON.stringify(reference[key]) !== JSON.stringify(live[key]))
    .map(
      (key) =>
        `${key}: SDK bytes replay to ${JSON.stringify(reference[key])}, live reports ${JSON.stringify(live[key])}`,
    );
}

function finding(
  expected: ExpectedNetworkEvent,
  boundary: ContractBoundary,
  message: string,
): ContractFinding {
  return { slice: NETWORK_SLICE, caseName: expected.caseName, boundary, message };
}

function judgeDownstreamOfSdk(observation: NetworkCaseObservation): ContractFinding | undefined {
  const { expected, reference, live } = observation;
  if (!reference) {
    return finding(
      expected,
      "ios-client",
      "the production iOS ingestor did not persist the SDK's own bytes",
    );
  }
  const rowMismatches = networkFieldMismatches(expected, reference.row, "surface");
  if (rowMismatches.length > 0) {
    return finding(expected, "ios-client", `persisted row differs: ${rowMismatches.join("; ")}`);
  }
  const detailMismatches = networkFieldMismatches(expected, reference.detail, "surface");
  if (detailMismatches.length > 0) {
    return finding(
      expected,
      "mcp-surface",
      `request resource differs: ${detailMismatches.join("; ")}`,
    );
  }
  if (!live) {
    return observation.queuedInCtrlProxy
      ? finding(
          expected,
          "ios-client",
          "CtrlProxy still holds the event; the iOS client never drained it",
        )
      : finding(
          expected,
          "sdk-endpoint",
          "the SDK encoded the event but neither CtrlProxy's queue nor the daemon has it",
        );
  }
  const transportDifferences = recordDifferences(reference.detail, live);
  if (transportDifferences.length > 0) {
    return finding(expected, "ctrlproxy-command", transportDifferences.join("; "));
  }
  return undefined;
}

/**
 * Judges one case and returns at most one finding: the first boundary that disagrees.
 * Later layers are not judged, because their input is already wrong.
 */
export function judgeNetworkCase(
  observation: NetworkCaseObservation,
  forbiddenSubstrings: readonly string[] = [],
): ContractFinding | undefined {
  const { expected, sdkPayload } = observation;
  if (!sdkPayload) {
    return finding(expected, "sdk-serialization", "the SDK never encoded an event for this case");
  }
  const leaked = forbiddenSubstrings.filter((secret) =>
    JSON.stringify(sdkPayload).includes(secret),
  );
  const mismatches = [
    ...networkFieldMismatches(expected, sdkPayload, "wire"),
    ...leaked.map((secret) => `payload carries the unredacted value ${JSON.stringify(secret)}`),
  ];
  if (mismatches.length > 0) {
    return finding(expected, "sdk-serialization", mismatches.join("; "));
  }
  return judgeDownstreamOfSdk(observation);
}

/** Pairs each expected case with the SDK payload that represents it. */
export function matchSdkPayload(
  expected: ExpectedNetworkEvent,
  payloads: readonly JsonRecord[],
): JsonRecord | undefined {
  if (expected.requestId !== undefined) {
    return payloads.find((payload) => payload.requestId === expected.requestId);
  }
  return payloads.find(
    (payload) =>
      payload.url === expected.url &&
      payload.protocolName === expected.protocolName &&
      payload.direction === expected.direction &&
      payload.connectionId === expected.connectionId,
  );
}

/** Findings that concern the whole run rather than one case. */
export function judgeManifest(manifest: SdkContractManifest): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const runCase = { caseName: "run" } as const;
  if (manifest.status === "failed") {
    findings.push({
      slice: NETWORK_SLICE,
      ...runCase,
      boundary: "fixture-host",
      message: manifest.failure ?? "the scenario failed without a reason",
    });
  } else if (manifest.network.length === 0) {
    findings.push({
      slice: NETWORK_SLICE,
      ...runCase,
      boundary: "fixture-host",
      message: "the scenario completed without any expected network cases",
    });
  }
  if (manifest.undecodableBatches > 0) {
    findings.push({
      slice: NETWORK_SLICE,
      ...runCase,
      boundary: "sdk-serialization",
      message: `the SDK posted ${manifest.undecodableBatches} batch(es) its public SdkEventBatch type cannot decode`,
    });
  }
  return findings;
}
