import { describe, expect, test } from "bun:test";
import {
  FAULT_CASES,
  FAULT_DELAY_MS,
  expectedFaultRecord,
  expectedFaultRecords,
  faultRules,
  judgeFaultClientOutcomes,
} from "../../../scripts/ios/sdk-contract/faultSlice";
import type {
  FaultCaseObservation,
  SdkContractManifest,
} from "../../../scripts/ios/sdk-contract/manifest";

const runId = "c0123";
const host = "http://127.0.0.1:5000";

function observationFor(caseName: string): FaultCaseObservation {
  const faultCase = FAULT_CASES.find((item) => item.caseName === caseName)!;
  return {
    caseName,
    url: `${host}/contract/${runId}/${caseName}`,
    elapsedMs: faultCase.delayed ? FAULT_DELAY_MS + 12 : 3,
    ...(faultCase.clientError ? { clientError: faultCase.clientError } : {}),
    ...(faultCase.transport === "webSocket" ? { connectionId: `conn-${caseName}` } : {}),
    ...(faultCase.transport === "nwConnection"
      ? { connectionId: `conn-${caseName}`, requestId: `req-${caseName}` }
      : {}),
  };
}

function manifest(faults: FaultCaseObservation[]): SdkContractManifest {
  return {
    schemaVersion: 2,
    runId,
    scenario: "faults",
    status: "complete",
    network: [],
    faults,
    events: [],
    undecodableBatches: 0,
  };
}

const allObservations = FAULT_CASES.map((item) => observationFor(item.caseName));

describe("faultRules", () => {
  test("installs one one-shot delay and fail rule per transport, scoped to this run", () => {
    const rules = faultRules(runId);
    expect(rules.map((rule) => [rule.transport, rule.action])).toEqual([
      ["urlSession", "latency"],
      ["urlSession", "error"],
      ["webSocket", "latency"],
      ["webSocket", "error"],
      ["nwConnection", "latency"],
      ["nwConnection", "error"],
    ]);
    expect(rules.every((rule) => rule.limit === 1 && rule.dryRun === false)).toBe(true);
    expect(rules.every((rule) => rule.path.startsWith(`^/contract/${runId}/`))).toBe(true);
  });

  test("lets the expiry case hit the URLSession fail rule and pins every other path", () => {
    const rules = faultRules(runId);
    const fail = rules.find((rule) => rule.faultId === `fault-urlsession-fail-${runId}`)!;
    expect(new RegExp(fail.path).test(`/contract/${runId}/fault-urlsession-fail-expired`)).toBe(
      true,
    );
    const delay = rules.find((rule) => rule.faultId === `fault-urlsession-delay-${runId}`)!;
    expect(new RegExp(delay.path).test(`/contract/${runId}/fault-urlsession-delay-x`)).toBe(false);
  });

  test("matches WebSocket rules on sent frames only", () => {
    const socketRules = faultRules(runId).filter((rule) => rule.transport === "webSocket");
    expect(socketRules.map((rule) => rule.method)).toEqual(["SEND", "SEND"]);
  });
});

describe("judgeFaultClientOutcomes", () => {
  test("passes when every case saw its rule", () => {
    expect(judgeFaultClientOutcomes(manifest(allObservations))).toEqual([]);
  });

  test("blames the fixture host for a case Playground did not run", () => {
    const findings = judgeFaultClientOutcomes(manifest(allObservations.slice(1)));
    expect(findings).toEqual([
      {
        slice: "faults",
        caseName: "fault-urlsession-delay",
        boundary: "fixture-host",
        message: "Playground did not run this case",
      },
    ]);
  });

  test("blames the adapter for a delay that finished early", () => {
    const early = allObservations.map((item) =>
      item.caseName === "fault-websocket-delay" ? { ...item, elapsedMs: 20 } : item,
    );
    const [finding] = judgeFaultClientOutcomes(manifest(early));
    expect(finding).toMatchObject({ boundary: "sdk-adapter", caseName: "fault-websocket-delay" });
    expect(finding.message).toContain("before the 400 ms delay");
  });

  test("blames the adapter for a fail rule the client never saw, or an expired one it did", () => {
    const wrong = allObservations.map((item) => {
      if (item.caseName === "fault-nwconnection-fail") {
        return { ...item, clientError: undefined };
      }
      if (item.caseName === "fault-urlsession-fail-expired") {
        return { ...item, clientError: "NSURLErrorDomain:-1001" };
      }
      return item;
    });
    const findings = judgeFaultClientOutcomes(manifest(wrong));
    expect(findings.map((finding) => finding.caseName)).toEqual([
      "fault-urlsession-fail-expired",
      "fault-nwconnection-fail",
    ]);
    expect(findings[1].message).toBe('client saw null, expected "posix:54"');
  });
});

describe("expectedFaultRecord", () => {
  const record = (caseName: string) =>
    expectedFaultRecord(
      FAULT_CASES.find((item) => item.caseName === caseName)!,
      observationFor(caseName),
      runId,
    );

  test("expects the URLProtocol's fault error on URLSession records", () => {
    expect(record("fault-urlsession-delay")).toEqual({
      caseName: "fault-urlsession-delay",
      url: `${host}/contract/${runId}/fault-urlsession-delay`,
      method: "GET",
      error: `fault:fault-urlsession-delay-${runId}:latency`,
      statusCode: 200,
    });
    expect(record("fault-urlsession-fail").error).toBe(
      `fault:fault-urlsession-fail-${runId}:error`,
    );
    expect(record("fault-urlsession-fail-expired")).toMatchObject({ statusCode: 200, error: null });
  });

  test("expects adapter decision metadata on WebSocket and NWConnection records", () => {
    expect(record("fault-websocket-delay")).toMatchObject({
      method: "SEND",
      protocolName: "websocket",
      connectionId: "conn-fault-websocket-delay",
      metadata: { fault_outcome: "delayed", fault_delay_ms: "400" },
      error: null,
    });
    expect(record("fault-nwconnection-fail")).toMatchObject({
      method: "CONNECTION",
      requestId: "req-fault-nwconnection-fail",
      metadata: { fault_action: "error", fault_outcome: "failed", fault_delay_ms: "0" },
      error: `fault:fault-nwconnection-fail-${runId}:error`,
    });
  });

  test("builds records only for the cases Playground reported", () => {
    expect(expectedFaultRecords(manifest(allObservations.slice(0, 2)), runId)).toHaveLength(2);
  });
});
