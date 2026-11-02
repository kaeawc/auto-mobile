import type { ToolOutcome } from "./observationSlice";
import type { ContractFinding } from "./boundaries";
import type { SdkContractManifest, StorageRegistration } from "./manifest";

/**
 * Storage slice of the iOS SDK contract suite (#5164 phase D): Playground applies a storage
 * registration (`SdkContractStorageScenario.swift`) and the harness reads the MCP resource
 * `automobile:devices/{deviceId}/storage/capabilities?appId=...` while the app runs, then once
 * more after terminating it. The Keychain capability and the store states must match what the
 * host registered, the SDK must be reported unreachable once the app is gone, and no value the
 * host stored may appear anywhere in the resource.
 */
export const STORAGE_SLICE = "storage";
export const STORAGE_DEFAULT_SLICE = "storage-default";

/** Written into a registered suite; a capability never reads values, so it must never appear. */
export const FORBIDDEN_STORAGE_SUBSTRINGS = ["contract-storage-secret"];

type JsonRecord = Record<string, unknown>;

export interface ExpectedKeychain {
  deletion: "enabled" | "disabled" | "unknown";
  reason: string | null;
  deletionScopes: JsonRecord[];
}

export interface ExpectedStore {
  kind: "user_defaults_suite" | "core_data";
  identifier: string;
  sharing: "app_private" | "app_group";
  appGroup?: string;
  coordination: "single_process" | "uncoordinated" | "host_coordinated";
  query: "supported" | "unsupported";
}

/** What the SDK must report for the registration the host applied. */
export function expectedKeychain(registration: StorageRegistration): ExpectedKeychain {
  if (!registration.allowKeychainDeletion) {
    return { deletion: "disabled", reason: "DISABLED", deletionScopes: [] };
  }
  if (registration.keychainEntries.length === 0) {
    return { deletion: "disabled", reason: "NO_ALLOWLISTED_SCOPES", deletionScopes: [] };
  }
  return {
    deletion: "enabled",
    reason: null,
    deletionScopes: registration.keychainEntries.map((entry) => ({
      itemClass: "genericPassword",
      ...entry,
    })),
  };
}

/** Once the app is gone the daemon cannot reach its SDK, and must say so rather than guess. */
export const EXPECTED_UNREACHABLE_KEYCHAIN: ExpectedKeychain = {
  deletion: "unknown",
  reason: "BRIDGE_UNAVAILABLE",
  deletionScopes: [],
};

export function expectedStores(registration: StorageRegistration): {
  keyValue: ExpectedStore[];
  databases: ExpectedStore[];
} {
  const suite = (identifier: string, coordination: ExpectedStore["coordination"]) => ({
    kind: "user_defaults_suite" as const,
    identifier,
    sharing: "app_group" as const,
    appGroup: identifier,
    coordination,
    query: "supported" as const,
  });
  return {
    keyValue: [
      ...registration.uncoordinatedSuites.map((name) => suite(name, "uncoordinated")),
      ...registration.hostCoordinatedSuites.map((name) => suite(name, "host_coordinated")),
    ],
    databases: registration.coreDataStores.map((store) => ({
      kind: "core_data",
      identifier: store.identifier,
      sharing: store.appGroup ? "app_group" : "app_private",
      ...(store.appGroup ? { appGroup: store.appGroup } : {}),
      coordination: store.appGroup
        ? store.coordination === "host_coordinated"
          ? "host_coordinated"
          : "uncoordinated"
        : "single_process",
      query: store.queryable ? "supported" : "unsupported",
    })),
  };
}

function domain(report: JsonRecord, name: string): JsonRecord | undefined {
  const domains = Array.isArray(report.domains) ? (report.domains as JsonRecord[]) : [];
  return domains.find((entry) => entry.domain === name);
}

/** The single `storage.keychain` capability in `secure_state`, if any. */
export function reportedKeychain(report: JsonRecord): JsonRecord | undefined {
  const capabilities = domain(report, "secure_state")?.capabilities;
  return Array.isArray(capabilities)
    ? (capabilities as JsonRecord[]).find((entry) => entry.capability === "storage.keychain")
    : undefined;
}

/** Scopes compared field by field, independent of key order and list order. */
function scopeKeys(value: unknown): string {
  const scopes = Array.isArray(value) ? (value as JsonRecord[]) : [];
  return scopes
    .map((scope) =>
      ["itemClass", "service", "account", "accessGroup"].map((key) => String(scope[key])).join("|"),
    )
    .sort()
    .join(",");
}

function keychainMismatches(expected: ExpectedKeychain, actual: JsonRecord): string[] {
  const mismatches: string[] = [];
  if (actual.inspection !== "unavailable") {
    mismatches.push(`inspection ${String(actual.inspection)} (must stay unavailable)`);
  }
  if (actual.deletion !== expected.deletion) {
    mismatches.push(`deletion ${String(actual.deletion)}, expected ${expected.deletion}`);
  }
  if ((actual.reason ?? null) !== expected.reason) {
    mismatches.push(`reason ${String(actual.reason ?? null)}, expected ${String(expected.reason)}`);
  }
  if (scopeKeys(actual.deletionScopes) !== scopeKeys(expected.deletionScopes)) {
    mismatches.push(
      `deletionScopes ${JSON.stringify(actual.deletionScopes ?? [])}, expected ${JSON.stringify(expected.deletionScopes)}`,
    );
  }
  return mismatches;
}

function storeMismatches(expected: readonly ExpectedStore[], actualValue: unknown): string[] {
  const actual = Array.isArray(actualValue) ? (actualValue as JsonRecord[]) : [];
  const mismatches = expected.flatMap((store) => {
    const match = actual.find(
      (entry) => entry.kind === store.kind && entry.identifier === store.identifier,
    );
    if (!match) {
      return [`${store.identifier} missing`];
    }
    return (["sharing", "coordination", "query"] as const)
      .filter((field) => match[field] !== store[field])
      .map(
        (field) => `${store.identifier} ${field} ${String(match[field])}, expected ${store[field]}`,
      )
      .concat(
        (match.appGroup ?? undefined) === store.appGroup
          ? []
          : [
              `${store.identifier} appGroup ${String(match.appGroup)}, expected ${String(store.appGroup)}`,
            ],
      );
  });
  const unexpected = actual
    .filter((entry) => !expected.some((store) => store.identifier === entry.identifier))
    .map((entry) => `unexpected store ${String(entry.identifier)}`);
  return [...mismatches, ...unexpected];
}

function finding(
  slice: string,
  caseName: string,
  boundary: ContractFinding["boundary"],
  message: string,
): ContractFinding {
  return { slice, caseName, boundary, message };
}

/**
 * Judges the resource read while the app ran. An unreachable or unparsable SDK is attributed to
 * the endpoint or serialization; a reachable SDK that reports the wrong state, to the adapter.
 */
export function judgeStorageReport(
  manifest: SdkContractManifest,
  report: JsonRecord,
): ContractFinding[] {
  const slice = manifest.scenario;
  const registration = manifest.storage;
  if (!registration) {
    return [finding(slice, "run", "fixture-host", "the manifest has no storage registration")];
  }
  const leak = FORBIDDEN_STORAGE_SUBSTRINGS.find((secret) =>
    JSON.stringify(report).includes(secret),
  );
  const leakFindings = leak
    ? [finding(slice, "redaction", "mcp-surface", `the storage capability carries "${leak}"`)]
    : [];
  const keychain = reportedKeychain(report);
  if (!keychain) {
    return [
      ...leakFindings,
      finding(slice, "keychain", "mcp-surface", "secure_state has no storage.keychain capability"),
    ];
  }
  if (keychain.reason === "BRIDGE_UNAVAILABLE") {
    return [
      ...leakFindings,
      finding(
        slice,
        "keychain",
        "sdk-endpoint",
        "the daemon could not reach the running app's SDK",
      ),
    ];
  }
  if (keychain.reason === "SDK_TOO_OLD") {
    return [
      ...leakFindings,
      finding(slice, "keychain", "sdk-serialization", "the SDK's storage capability did not parse"),
    ];
  }
  const keychainProblems = keychainMismatches(expectedKeychain(registration), keychain);
  const stores = expectedStores(registration);
  const storeProblems = [
    ...storeMismatches(stores.keyValue, domain(report, "key_value")?.stores),
    ...storeMismatches(stores.databases, domain(report, "databases")?.stores),
  ];
  return [
    ...leakFindings,
    ...(keychainProblems.length > 0
      ? [finding(slice, "keychain", "sdk-adapter", keychainProblems.join("; "))]
      : []),
    ...(storeProblems.length > 0
      ? [finding(slice, "stores", "sdk-adapter", storeProblems.join("; "))]
      : []),
  ];
}

/** Judges the resource read after the app was terminated: safe unavailability, no stale states. */
export function judgeUnreachableStorageReport(
  slice: string,
  report: JsonRecord,
): ContractFinding[] {
  const keychain = reportedKeychain(report);
  const problems = [
    ...(keychain
      ? keychainMismatches(EXPECTED_UNREACHABLE_KEYCHAIN, keychain)
      : ["secure_state has no storage.keychain capability"]),
    ...storeMismatches([], domain(report, "key_value")?.stores),
    ...storeMismatches([], domain(report, "databases")?.stores),
  ];
  return problems.length > 0
    ? [finding(slice, "unreachable", "ios-client", problems.join("; "))]
    : [];
}

/** Judge parsed sqlQuery output; the CLI preserves SDK error codes in its error text. */
export function judgeCoreDataQuery(
  queryCase: "limited" | "all" | "unknown-entity",
  outcome: ToolOutcome,
): ContractFinding[] {
  const caseName = `core-data-query-${queryCase}`;
  const result = outcome.result;
  const failed = outcome.error !== undefined || result?.success === false;
  const error = outcome.error ?? String(result?.error ?? "");
  if (queryCase === "unknown-entity") {
    return failed && /\bunknown_core_data_entity\b/.test(error)
      ? []
      : [
          finding(
            STORAGE_SLICE,
            caseName,
            "mcp-surface",
            `expected unknown_core_data_entity, received ${error || JSON.stringify(result)}`,
          ),
        ];
  }
  if (failed || !result) {
    return [
      finding(STORAGE_SLICE, caseName, "mcp-surface", error || "sqlQuery returned no result"),
    ];
  }
  const rows = [
    ["Apples", "1"],
    ["Bread", "2"],
    ["Carrots", "3"],
    ["Dates", "4"],
  ];
  const limited = queryCase === "limited";
  const expectedRows = limited ? rows.slice(0, 2) : rows;
  const problems = [
    ...(JSON.stringify(result.columns) === JSON.stringify(["name", "quantity"])
      ? []
      : ["columns must be name,quantity"]),
    ...(JSON.stringify(result.rows) === JSON.stringify(expectedRows)
      ? []
      : [
          `expected seeded rows ${JSON.stringify(expectedRows)}, received ${JSON.stringify(result.rows)}`,
        ]),
    ...(result.truncated === limited ? [] : [`truncated must be ${limited}`]),
  ];
  return problems.length > 0
    ? [finding(STORAGE_SLICE, caseName, "sdk-adapter", problems.join("; "))]
    : [];
}
