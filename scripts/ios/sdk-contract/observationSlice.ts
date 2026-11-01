import type { ContractFinding } from "./boundaries";
import type { ObservationHostLog, SdkContractManifest } from "./manifest";

/**
 * Observation slice of the iOS SDK contract suite (#5164 phase B): Playground registers a
 * contract `AutoMobileObservationBridge` (`SdkContractObservationScenario.swift`), and the
 * harness drives `observe`, `tapOn` and `sendKeys` through the MCP tools against its nodes. The
 * host's own log of what its executor ran is the ground truth each tool result is judged against.
 */
export const OBSERVATION_SLICE = "observe";

/** Node ids the contract bridge publishes; keep in step with the Swift host. */
export const OBSERVATION_NODES = {
  save: "contract-save",
  tapCount: "contract-tap-count",
  email: "contract-email",
  armStale: "contract-arm-stale",
  hold: "contract-hold",
} as const;

export const TYPED_TEXT = "contract typed";

type JsonRecord = Record<string, unknown>;

/** A tool call's structured result, or the error it failed with. */
export interface ToolOutcome {
  result?: JsonRecord;
  error?: string;
}

/** One harness step: the tool, its arguments, and the case it is judged as. */
export interface ObservationStep {
  caseName: string;
  tool: "observe" | "tapOn" | "sendKeys";
  args: Record<string, string>;
}

const selector = (elementId: string) => JSON.stringify({ elementId });

/** In order: the long press precedes the stale trap, which spoils every later action. */
export const OBSERVATION_STEPS: readonly ObservationStep[] = [
  { caseName: "observe", tool: "observe", args: { platform: "ios" } },
  {
    caseName: "tap",
    tool: "tapOn",
    args: { platform: "ios", selector: selector(OBSERVATION_NODES.save), action: "tap" },
  },
  {
    caseName: "send-keys",
    tool: "sendKeys",
    args: {
      platform: "ios",
      selector: selector(OBSERVATION_NODES.email),
      commands: JSON.stringify([{ action: "type", text: TYPED_TEXT, operation: "replace" }]),
    },
  },
  {
    caseName: "unsupported-long-press",
    tool: "tapOn",
    // Reuse the visible tap target: contract-hold is under the status bar and fails geometry
    // validation before the bridge can reject the unsupported action.
    args: { platform: "ios", selector: selector(OBSERVATION_NODES.save), action: "longPress" },
  },
  {
    caseName: "arm-stale",
    tool: "tapOn",
    args: { platform: "ios", selector: selector(OBSERVATION_NODES.armStale), action: "tap" },
  },
  {
    caseName: "stale-tap",
    tool: "tapOn",
    args: { platform: "ios", selector: selector(OBSERVATION_NODES.save), action: "tap" },
  },
];

function finding(
  caseName: string,
  boundary: ContractFinding["boundary"],
  message: string,
): ContractFinding {
  return { slice: OBSERVATION_SLICE, caseName, boundary, message };
}

function hostCount(
  log: ObservationHostLog,
  kind: string,
  elementId: string,
  text?: string,
): number {
  return log.actions.filter(
    (action) =>
      action.kind === kind &&
      action.elementId === elementId &&
      (text === undefined || action.text === text),
  ).length;
}

/** `backend` / `fallbackReason` as a tool reported them (a sendKeys command carries its own). */
function backendOf(step: ObservationStep, result: JsonRecord | undefined) {
  const source =
    step.tool === "sendKeys" && Array.isArray(result?.commands)
      ? (result.commands[0] as JsonRecord | undefined)
      : result;
  return { backend: source?.backend, fallbackReason: source?.fallbackReason };
}

function describe(outcome: ToolOutcome, step: ObservationStep): string {
  if (outcome.error !== undefined) {
    return `failed: ${outcome.error}`;
  }
  const { backend, fallbackReason } = backendOf(step, outcome.result);
  return `success=${String(outcome.result?.success)} backend=${String(backend)} fallbackReason=${String(fallbackReason)}`;
}

function succeeded(outcome: ToolOutcome): boolean {
  return outcome.error === undefined && outcome.result?.success !== false;
}

/** Judge the public skeleton; internal bridge attributes are intentionally not serialized. */
export function judgeObserve(step: ObservationStep, outcome: ToolOutcome): ContractFinding[] {
  if (outcome.error !== undefined) {
    return [finding(step.caseName, "ios-client", `observe ${describe(outcome, step)}`)];
  }
  const { backend, fallbackReason } = backendOf(step, outcome.result);
  if (backend !== "sdk") {
    return [
      finding(
        step.caseName,
        "sdk-endpoint",
        `observe did not use the registered bridge (backend=${String(backend)}, fallbackReason=${String(fallbackReason)})`,
      ),
    ];
  }
  const skeleton = outcome.result?.skeleton;
  return Array.isArray(skeleton) &&
    skeleton.some(
      (row: unknown) =>
        row !== null &&
        typeof row === "object" &&
        "elementId" in row &&
        row.elementId === OBSERVATION_NODES.save &&
        "testTag" in row &&
        row.testTag === OBSERVATION_NODES.save,
    )
    ? []
    : [
        finding(
          step.caseName,
          "ios-client",
          "observe reported backend sdk without the bridge nodes",
        ),
      ];
}

/** An action the bridge supports: the host ran it once and the tool reported `backend: sdk`. */
function judgeRoutedAction(
  step: ObservationStep,
  outcome: ToolOutcome,
  hostRan: number,
): ContractFinding[] {
  const { backend, fallbackReason } = backendOf(step, outcome.result);
  const toolSaysSdk = succeeded(outcome) && backend === "sdk";
  if (hostRan > 1) {
    return [
      finding(
        step.caseName,
        "sdk-adapter",
        `the host executed the action ${hostRan} times; expected exactly once`,
      ),
    ];
  }
  if (hostRan === 1 && toolSaysSdk) {
    return [];
  }
  if (hostRan > 0) {
    return [
      finding(
        step.caseName,
        "mcp-surface",
        `the host ran the action but ${step.tool} ${describe(outcome, step)}`,
      ),
    ];
  }
  if (backend === "xctest" && fallbackReason === "unavailable") {
    return [
      finding(
        step.caseName,
        "sdk-endpoint",
        `the bridge did not answer: ${describe(outcome, step)}`,
      ),
    ];
  }
  if (toolSaysSdk) {
    return [
      finding(
        step.caseName,
        "ctrlproxy-command",
        `${step.tool} reported an SDK action the host never ran`,
      ),
    ];
  }
  return [
    finding(
      step.caseName,
      "ios-client",
      `${step.tool} did not route the bridge node through the bridge: ${describe(outcome, step)}`,
    ),
  ];
}

/** The bridge does not support long press: XCTest stands in and says so; the host runs nothing. */
function judgeUnsupported(
  step: ObservationStep,
  outcome: ToolOutcome,
  log: ObservationHostLog,
): ContractFinding[] {
  const { backend, fallbackReason } = backendOf(step, outcome.result);
  if (hostCount(log, "longPress", OBSERVATION_NODES.save) > 0 || backend === "sdk") {
    return [
      finding(step.caseName, "sdk-adapter", "the bridge accepted an action it did not declare"),
    ];
  }
  if (succeeded(outcome) && backend === "xctest" && fallbackReason === "unsupported") {
    return [];
  }
  if (backend === "xctest" && fallbackReason === "unavailable") {
    return [
      finding(
        step.caseName,
        "sdk-endpoint",
        `the bridge did not answer: ${describe(outcome, step)}`,
      ),
    ];
  }
  return [
    finding(
      step.caseName,
      "ios-client",
      `an unsupported bridge action must fall back to XCTest with fallbackReason unsupported: ${describe(outcome, step)}`,
    ),
  ];
}

/** After the trap is armed, the tap's observation is stale on arrival: it must fail closed. */
function judgeStale(
  step: ObservationStep,
  outcome: ToolOutcome,
  log: ObservationHostLog,
): ContractFinding[] {
  if (hostCount(log, "tap", OBSERVATION_NODES.armStale) === 0) {
    return [finding(step.caseName, "fixture-host", "the stale trap was never armed")];
  }
  if (hostCount(log, "tap", OBSERVATION_NODES.save) > 1) {
    return [
      finding(step.caseName, "sdk-adapter", "the bridge ran an action against a stale observation"),
    ];
  }
  if (succeeded(outcome)) {
    return [
      finding(
        step.caseName,
        "ios-client",
        `a stale bridge target did not fail closed: ${describe(outcome, step)}`,
      ),
    ];
  }
  const message = outcome.error ?? String(outcome.result?.error ?? "");
  return message.includes("stale_observation")
    ? []
    : [
        finding(
          step.caseName,
          "ios-client",
          `the stale tap failed without the bridge's stale_observation reason: ${message}`,
        ),
      ];
}

/** Judges every step's tool outcome against the host log in the manifest. */
export function judgeObservationCases(
  manifest: SdkContractManifest,
  outcomes: ReadonlyMap<string, ToolOutcome>,
): ContractFinding[] {
  const log = manifest.observation;
  if (!log) {
    return [finding("run", "fixture-host", "the manifest has no observation host log")];
  }
  return OBSERVATION_STEPS.flatMap((step) => {
    const outcome = outcomes.get(step.caseName);
    if (!outcome) {
      return [finding(step.caseName, "fixture-host", "the harness did not run this step")];
    }
    switch (step.caseName) {
      case "observe":
        return judgeObserve(step, outcome);
      case "tap":
        return judgeRoutedAction(step, outcome, hostCount(log, "tap", OBSERVATION_NODES.save));
      case "send-keys":
        return judgeRoutedAction(
          step,
          outcome,
          hostCount(log, "insertText", OBSERVATION_NODES.email, TYPED_TEXT),
        );
      case "arm-stale":
        return judgeRoutedAction(step, outcome, hostCount(log, "tap", OBSERVATION_NODES.armStale));
      case "unsupported-long-press":
        return judgeUnsupported(step, outcome, log);
      default:
        return judgeStale(step, outcome, log);
    }
  });
}
