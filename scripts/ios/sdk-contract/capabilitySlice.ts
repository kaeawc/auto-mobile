import { sdkCapabilitySnapshotSchema } from "../../../src/features/sdk/sdkCapabilities";
import type { ContractFinding } from "./boundaries";
import type { SdkContractManifest, TransportDescriptor } from "./manifest";

/**
 * Capability slice of the iOS SDK contract suite (#5164 phase C): Playground reads
 * `AutoMobileNetwork.transportCapabilities()` in a fresh process before and after registering
 * URLSession, WebSocket and NWConnection with the host registration API. Each descriptor is
 * compared with what that registration implies, then read back through the host's shared
 * capability parser, which must keep every id, state and reason.
 */
export const CAPABILITY_SLICE = "capabilities";

type ExpectedDescriptor = Required<Pick<TransportDescriptor, "id" | "state">> &
  Pick<TransportDescriptor, "reason" | "faultEnforcement" | "faultActions">;

const URL_SESSION = "network.transport.urlsession";
const BACKGROUND_URL_SESSION = "network.transport.urlsession.background";
const WEB_SOCKET = "network.transport.websocket";
const NW_CONNECTION = "network.transport.nwconnection";
const OTHER = "network.transport.other";

const hostOptIn = (id: string): ExpectedDescriptor => ({
  id,
  state: "DISABLED",
  reason: "HOST_OPT_IN",
  faultEnforcement: "NONE",
  faultActions: [],
});

const unsupportedOther: ExpectedDescriptor = {
  id: OTHER,
  state: "UNSUPPORTED",
  reason: "NO_ADAPTER",
  faultEnforcement: "NONE",
  faultActions: [],
};

const ADAPTER_ACTIONS = ["closeConnection", "error", "latency"];

const registered = (id: string, faultActions: string[]): ExpectedDescriptor => ({
  id,
  state: "SUPPORTED",
  faultEnforcement: "ENFORCED",
  faultActions,
});

/** Network capture is on and nothing is registered yet: every family waits for host opt-in. */
export const EXPECTED_BEFORE_REGISTRATION: readonly ExpectedDescriptor[] = [
  hostOptIn(URL_SESSION),
  hostOptIn(BACKGROUND_URL_SESSION),
  hostOptIn(WEB_SOCKET),
  hostOptIn(NW_CONNECTION),
  unsupportedOther,
];

/**
 * After registering a default URLSession configuration, a WebSocket adapter and an
 * NWConnection adapter in a DEBUG build. The background family stays unregistered.
 */
export const EXPECTED_AFTER_REGISTRATION: readonly ExpectedDescriptor[] = [
  registered(URL_SESSION, [
    "closeConnection",
    "dropBytes",
    "error",
    "latency",
    "response",
    "status",
  ]),
  hostOptIn(BACKGROUND_URL_SESSION),
  registered(WEB_SOCKET, ADAPTER_ACTIONS),
  registered(NW_CONNECTION, ADAPTER_ACTIONS),
  unsupportedOther,
];

function descriptorMismatches(
  expected: ExpectedDescriptor,
  actual: TransportDescriptor | undefined,
): string[] {
  if (!actual) {
    return ["missing"];
  }
  const fields = ["state", "reason", "faultEnforcement"] as const;
  const mismatches = fields
    .filter((field) => actual[field] !== expected[field])
    .map(
      (field) =>
        `${field}: expected ${JSON.stringify(expected[field])}, got ${JSON.stringify(actual[field])}`,
    );
  if (JSON.stringify(actual.faultActions ?? []) !== JSON.stringify(expected.faultActions ?? [])) {
    mismatches.push(
      `faultActions: expected ${JSON.stringify(expected.faultActions)}, got ${JSON.stringify(actual.faultActions)}`,
    );
  }
  return mismatches;
}

function judgeStage(
  stage: string,
  expected: readonly ExpectedDescriptor[],
  actual: readonly TransportDescriptor[],
): ContractFinding[] {
  const sdkFindings = expected.flatMap((want): ContractFinding[] => {
    const mismatches = descriptorMismatches(
      want,
      actual.find((item) => item.id === want.id),
    );
    return mismatches.length === 0
      ? []
      : [
          {
            slice: CAPABILITY_SLICE,
            caseName: `${stage}/${want.id}`,
            boundary: "sdk-adapter",
            message: mismatches.join("; "),
          },
        ];
  });
  const unexpected = actual
    .filter((item) => !expected.some((want) => want.id === item.id))
    .map((item): ContractFinding => ({
      slice: CAPABILITY_SLICE,
      caseName: `${stage}/${item.id}`,
      boundary: "sdk-adapter",
      message: "the SDK reported a transport family the contract does not know",
    }));
  return [...sdkFindings, ...unexpected, ...judgeHostParser(stage, actual)];
}

/** The host's shared parser must read the iOS descriptors without losing id, state or reason. */
export function judgeHostParser(
  stage: string,
  actual: readonly TransportDescriptor[],
): ContractFinding[] {
  const parsed = sdkCapabilitySnapshotSchema.safeParse({
    schemaVersion: 1,
    capabilities: actual,
    policy: {},
  });
  const base = { slice: CAPABILITY_SLICE, caseName: `${stage}/host-parser` } as const;
  if (!parsed.success) {
    return [{ ...base, boundary: "ios-client", message: parsed.error.message }];
  }
  return actual.flatMap((descriptor, index): ContractFinding[] => {
    const read = parsed.data.capabilities[index];
    const same =
      read?.id === descriptor.id &&
      read.state === descriptor.state &&
      (read.reason ?? undefined) === descriptor.reason;
    return same
      ? []
      : [
          {
            ...base,
            boundary: "ios-client",
            message: `${descriptor.id} read back as ${JSON.stringify(read)}`,
          },
        ];
  });
}

export function judgeCapabilities(manifest: SdkContractManifest): ContractFinding[] {
  const observed = manifest.capabilities;
  if (!observed) {
    return [
      {
        slice: CAPABILITY_SLICE,
        caseName: "run",
        boundary: "fixture-host",
        message: "the manifest has no capability observation",
      },
    ];
  }
  return [
    ...judgeStage("before-registration", EXPECTED_BEFORE_REGISTRATION, observed.beforeRegistration),
    ...judgeStage("after-registration", EXPECTED_AFTER_REGISTRATION, observed.afterRegistration),
  ];
}
