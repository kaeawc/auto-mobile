/**
 * The layers an iOS SDK capability crosses on its way to an MCP client (#5164). A contract
 * finding names the first layer whose output disagrees with what it was given.
 */
export const CONTRACT_BOUNDARIES = {
  "fixture-host": "Playground could not run the scenario or write its manifest",
  "sdk-serialization": "the SDK encoded something other than what its adapter was given",
  "sdk-adapter":
    "the SDK reported or applied something other than what the host registered and the rule asked for",
  "sdk-endpoint": "the SDK encoded the event but it never reached CtrlProxy",
  "ctrlproxy-command": "the bytes the daemon received differ from the bytes the SDK encoded",
  "ios-client": "the iOS TypeScript client did not drain or persist the SDK's bytes correctly",
  "mcp-surface": "the persisted record is right but the MCP resource reports it wrongly",
} as const;

export type ContractBoundary = keyof typeof CONTRACT_BOUNDARIES;

export interface ContractFinding {
  slice: string;
  caseName: string;
  boundary: ContractBoundary;
  message: string;
}

export function formatFindings(findings: readonly ContractFinding[]): string {
  if (findings.length === 0) {
    return "PASS: every contract case matched at every boundary.";
  }
  const lines = findings.map(
    (finding) =>
      `FAIL [${finding.boundary}] ${finding.slice}/${finding.caseName}: ${finding.message}\n` +
      `     (${CONTRACT_BOUNDARIES[finding.boundary]})`,
  );
  return [`${findings.length} contract finding(s):`, ...lines].join("\n");
}
