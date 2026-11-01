import type { ContractFinding } from "./boundaries";
import type { ExpectedNetworkEvent, FaultCaseObservation, SdkContractManifest } from "./manifest";

/**
 * Fault slice of the iOS SDK contract suite (#5163, #5164): the harness sends delay and fail
 * rules through CtrlProxy's `set_network_fault_rules` command, Playground drives one exchange
 * per case through the adapters the host registration API returns, and each case is judged on
 * what the client saw and on the record the SDK emitted for the decision.
 */
export const FAULT_SLICE = "faults";
export const FAULT_DELAY_MS = 400;

/** One rule in the `set_network_fault_rules` wire shape (`NetworkFaultRuleDTO`). */
export interface NetworkFaultRuleWire {
  faultId: string;
  transport: "urlSession" | "webSocket" | "nwConnection";
  path: string;
  method?: string;
  action: "latency" | "error";
  errorType?: string;
  delayMs?: number;
  limit: number;
  dryRun: false;
}

type Transport = NetworkFaultRuleWire["transport"];

interface FaultCase {
  caseName: string;
  /** The case whose rule this case exercises; an expired case reuses an earlier one-shot rule. */
  ruleCase: string;
  transport: Transport;
  /** What the client must see: `null` for a completed exchange. */
  clientError: string | null;
  /** Whether the client must have waited at least `FAULT_DELAY_MS`. */
  delayed: boolean;
}

/**
 * The cases Playground's fault scenario runs (`SdkContractFaultScenario`); keep the names in
 * step. Client errors: a URLSession `timeout` fail is `URLError.timedOut`, a WebSocket fail
 * closes the task with `URLError.networkConnectionLost`, and an NWConnection `reset` fail
 * reports `NWError.posix(ECONNRESET)` (54 on Darwin).
 */
export const FAULT_CASES: readonly FaultCase[] = [
  {
    caseName: "fault-urlsession-delay",
    ruleCase: "fault-urlsession-delay",
    transport: "urlSession",
    clientError: null,
    delayed: true,
  },
  {
    caseName: "fault-urlsession-fail",
    ruleCase: "fault-urlsession-fail",
    transport: "urlSession",
    clientError: "NSURLErrorDomain:-1001",
    delayed: false,
  },
  {
    caseName: "fault-urlsession-fail-expired",
    ruleCase: "fault-urlsession-fail",
    transport: "urlSession",
    clientError: null,
    delayed: false,
  },
  {
    caseName: "fault-websocket-delay",
    ruleCase: "fault-websocket-delay",
    transport: "webSocket",
    clientError: null,
    delayed: true,
  },
  {
    caseName: "fault-websocket-fail",
    ruleCase: "fault-websocket-fail",
    transport: "webSocket",
    clientError: "NSURLErrorDomain:-1005",
    delayed: false,
  },
  {
    caseName: "fault-nwconnection-delay",
    ruleCase: "fault-nwconnection-delay",
    transport: "nwConnection",
    clientError: null,
    delayed: true,
  },
  {
    caseName: "fault-nwconnection-fail",
    ruleCase: "fault-nwconnection-fail",
    transport: "nwConnection",
    clientError: "posix:54",
    delayed: false,
  },
];

export function faultId(ruleCase: string, runId: string): string {
  return `${ruleCase}-${runId}`;
}

/** The rules the harness installs before Playground runs the fault cases. */
export function faultRules(runId: string): NetworkFaultRuleWire[] {
  const path = (caseName: string, exact: boolean) =>
    `^/contract/${runId}/${caseName}${exact ? "$" : ""}`;
  const rule = (
    caseName: string,
    transport: Transport,
    fields: Partial<NetworkFaultRuleWire>,
  ): NetworkFaultRuleWire => ({
    faultId: faultId(caseName, runId),
    transport,
    // The URLSession fail rule is a prefix so its one-shot expiry case hits the same rule.
    path: path(caseName, caseName !== "fault-urlsession-fail"),
    action: "latency",
    limit: 1,
    dryRun: false,
    ...fields,
  });
  return [
    rule("fault-urlsession-delay", "urlSession", { delayMs: FAULT_DELAY_MS }),
    rule("fault-urlsession-fail", "urlSession", { action: "error", errorType: "timeout" }),
    rule("fault-websocket-delay", "webSocket", { method: "SEND", delayMs: FAULT_DELAY_MS }),
    rule("fault-websocket-fail", "webSocket", { method: "SEND", action: "error" }),
    rule("fault-nwconnection-delay", "nwConnection", { delayMs: FAULT_DELAY_MS }),
    rule("fault-nwconnection-fail", "nwConnection", { action: "error", errorType: "reset" }),
  ];
}

function adapterFaultMetadata(id: string, delayed: boolean): Record<string, string> {
  return delayed
    ? {
        fault_id: id,
        fault_action: "latency",
        fault_outcome: "delayed",
        fault_delay_ms: String(FAULT_DELAY_MS),
      }
    : { fault_id: id, fault_action: "error", fault_outcome: "failed", fault_delay_ms: "0" };
}

/**
 * The record the SDK must emit for one case. The URLProtocol records a matched rule with the
 * error `fault:<id>:<action>` (a delay is served as a synthetic 200 after the delay); the
 * adapters add `fault_*` metadata and record a fail as a failed exchange with the same error.
 */
export function expectedFaultRecord(
  faultCase: FaultCase,
  observation: FaultCaseObservation,
  runId: string,
): ExpectedNetworkEvent {
  const id = faultId(faultCase.ruleCase, runId);
  const action = faultCase.delayed ? "latency" : "error";
  const base = { caseName: faultCase.caseName, url: observation.url };
  switch (faultCase.transport) {
    case "urlSession":
      if (faultCase.caseName.endsWith("-expired")) {
        return { ...base, method: "GET", statusCode: 200, error: null };
      }
      return {
        ...base,
        method: "GET",
        error: `fault:${id}:${action}`,
        ...(faultCase.delayed ? { statusCode: 200 } : {}),
      };
    case "webSocket":
      return {
        ...base,
        method: "SEND",
        protocolName: "websocket",
        direction: "response",
        connectionId: observation.connectionId,
        metadata: adapterFaultMetadata(id, faultCase.delayed),
        error: faultCase.delayed ? null : `fault:${id}:error`,
      };
    case "nwConnection":
      return {
        ...base,
        method: "CONNECTION",
        protocolName: "nwconnection",
        direction: "response",
        requestId: observation.requestId,
        connectionId: observation.connectionId,
        metadata: adapterFaultMetadata(id, faultCase.delayed),
        error: faultCase.delayed ? null : `fault:${id}:error`,
      };
  }
}

/** Pairs each case with its observation; a case Playground did not report has none. */
export function faultObservations(
  manifest: SdkContractManifest,
): Array<{ faultCase: FaultCase; observation: FaultCaseObservation | undefined }> {
  return FAULT_CASES.map((faultCase) => ({
    faultCase,
    observation: manifest.faults.find((item) => item.caseName === faultCase.caseName),
  }));
}

function judgeClientSide(
  faultCase: FaultCase,
  observation: FaultCaseObservation,
): string | undefined {
  const sawError = observation.clientError ?? null;
  if (sawError !== faultCase.clientError) {
    return `client saw ${JSON.stringify(sawError)}, expected ${JSON.stringify(faultCase.clientError)}`;
  }
  if (faultCase.delayed && observation.elapsedMs < FAULT_DELAY_MS) {
    return `exchange finished after ${Math.round(observation.elapsedMs)} ms, before the ${FAULT_DELAY_MS} ms delay`;
  }
  return undefined;
}

/**
 * Client-side findings: a case Playground never reported is a fixture failure, and a case
 * whose client outcome or timing differs from the rule is an adapter that did not apply it.
 */
export function judgeFaultClientOutcomes(manifest: SdkContractManifest): ContractFinding[] {
  return faultObservations(manifest).flatMap(({ faultCase, observation }): ContractFinding[] => {
    const base = { slice: FAULT_SLICE, caseName: faultCase.caseName };
    if (!observation) {
      return [{ ...base, boundary: "fixture-host", message: "Playground did not run this case" }];
    }
    const message = judgeClientSide(faultCase, observation);
    return message ? [{ ...base, boundary: "sdk-adapter", message }] : [];
  });
}

/** The SDK records the cases must produce, for the cases Playground reported. */
export function expectedFaultRecords(
  manifest: SdkContractManifest,
  runId: string,
): ExpectedNetworkEvent[] {
  return faultObservations(manifest).flatMap(({ faultCase, observation }) =>
    observation ? [expectedFaultRecord(faultCase, observation, runId)] : [],
  );
}
