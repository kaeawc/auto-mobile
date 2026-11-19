import { readFile } from "node:fs/promises";
import { isRecord } from "../../../src/server/pipeline/isRecord";
import {
  WEB_VIEW_ID_ATTRIBUTE,
  WEB_ELEMENT_ID_ATTRIBUTE,
  WEB_SNAPSHOT_ID_ATTRIBUTE,
  WEB_DOCUMENT_ID_ATTRIBUTE,
  WEB_ROLE_ATTRIBUTE,
} from "../../../src/features/observe/ios/iosSdkWebMerge";
import type { Timer } from "../../../src/utils/SystemTimer";
import type { ContractFinding } from "./boundaries";
import type { SdkContractManifest, WebViewHostLog } from "./manifest";
import type { ToolOutcome } from "./observationSlice";
import { parseToolOutput, toolFailureMessage } from "./toolOutput";

/** Phase E (#5164): real WKWebView DOM merging and bounded actions through public MCP tools. */
export const WEB_VIEW_SLICE = "web-view";
/** Keep these in step with SdkContractWebViewScenario.swift. DOM ids are per document. */
export const WEB_VIEW_NODES = {
  webView: "contract-web-view",
  button: "contract-web-button",
  input: "contract-web-input",
  allowed: "contract-web-allowed",
  disallowed: "contract-web-disallowed",
} as const;
export const WEB_VIEW_LABELS = {
  button: "Contract web increment",
  input: "Contract web input",
} as const;
export const WEB_VIEW_TEXT = "contract web typed";

export const WEB_VIEW_STEPS = [
  { caseName: "observe", tool: "observe", args: { platform: "ios", project: "full" } },
  {
    caseName: "tap",
    tool: "tapOn",
    args: {
      platform: "ios",
      selector: JSON.stringify({ text: WEB_VIEW_LABELS.button }),
      action: "tap",
      exactText: true,
    },
  },
  {
    caseName: "input",
    tool: "sendKeys",
    args: {
      platform: "ios",
      selector: JSON.stringify({ text: WEB_VIEW_LABELS.input }),
      commands: JSON.stringify([{ action: "type", text: WEB_VIEW_TEXT, operation: "replace" }]),
    },
  },
  // Fallback contract: text selectors re-resolve after navigation. Staleness is proved by the
  // host's old-snapshot SDK probe, not by pretending a public text selector is a snapshot handle.
  { caseName: "stale-handle", tool: "tapOn", args: { platform: "ios", action: "tap" } },
] as const;
// No no-arbitrary-js step: public MCP tools expose no JavaScript evaluation action.

interface WebNode {
  attributes: Record<string, unknown>;
  underWebView: boolean;
}

/** Read only the public full hierarchy, never a string mention elsewhere in a tool reply. */
function webNodes(outcome: ToolOutcome | undefined): WebNode[] {
  const hierarchy = outcome?.result?.viewHierarchy;
  if (!isRecord(hierarchy) || !isRecord(hierarchy.hierarchy)) {
    return [];
  }
  const nodes: WebNode[] = [];
  const visit = (value: unknown, underWebView: boolean): void => {
    if (Array.isArray(value)) {
      value.forEach((child) => visit(child, underWebView));
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    const attributes = isRecord(value.$) ? value.$ : value;
    if (typeof attributes[WEB_ELEMENT_ID_ATTRIBUTE] === "string") {
      nodes.push({ attributes, underWebView });
    }
    visit(value.node, underWebView || attributes.class === "WKWebView");
  };
  visit(hierarchy.hierarchy.node, false);
  return nodes;
}

function node(outcome: ToolOutcome | undefined, id: string): WebNode | undefined {
  return webNodes(outcome).find(({ attributes }) => attributes[WEB_ELEMENT_ID_ATTRIBUTE] === id);
}

type WebButtonSelector = { text: string };

/** A public selector for the observed DOM button, not an invented snapshot argument. */
export function observedWebButtonSelector(outcome: ToolOutcome): WebButtonSelector | undefined {
  const attributes = node(outcome, WEB_VIEW_NODES.button)?.attributes;
  if (!attributes) {
    return undefined;
  }
  const text = attributes["content-desc"];
  return typeof text === "string" && text ? { text } : undefined;
}

export function webViewObservationReady(outcome: ToolOutcome): boolean {
  return (
    outcome.error === undefined &&
    [WEB_VIEW_NODES.button, WEB_VIEW_NODES.input].every((id) => {
      const entry = node(outcome, id);
      return (
        entry?.underWebView &&
        entry.attributes[WEB_VIEW_ID_ATTRIBUTE] === WEB_VIEW_NODES.webView &&
        [WEB_SNAPSHOT_ID_ATTRIBUTE, WEB_DOCUMENT_ID_ATTRIBUTE, "web-origin"].every(
          (key) => typeof entry.attributes[key] === "string" && entry.attributes[key] !== "",
        )
      );
    })
  );
}

export interface WebViewDriver {
  invoke(tool: string, args: Record<string, string | boolean>): Promise<ToolOutcome>;
  /** Wait for both frame loads and the initial bridge snapshot. */
  ready(): Promise<void>;
  /** Fixed navigation marker and acknowledgement, after the successful tap and input. */
  navigate(): Promise<void>;
  release(): Promise<void>;
  timer: Timer;
  readArtifact?(path: string): Promise<string>;
}

interface WebViewOutcome extends ToolOutcome {
  artifactPointerSeen?: boolean;
}

/** The CLI externalizes large ObserveResults; resolve those before inspecting the hierarchy. */
async function observeWebView(driver: WebViewDriver): Promise<WebViewOutcome> {
  const outcome = await driver.invoke("observe", WEB_VIEW_STEPS[0].args);
  const artifact = outcome.result?.artifact;
  if (!isRecord(artifact) || typeof artifact.path !== "string") {
    return outcome;
  }
  try {
    const text = await (driver.readArtifact ?? ((path) => readFile(path, "utf8")))(artifact.path);
    return { ...outcome, result: parseToolOutput(text), artifactPointerSeen: true };
  } catch (error) {
    console.warn("Could not read web-view observe artifact", error);
    return { ...outcome, error: "could not read observe artifact JSON", artifactPointerSeen: true };
  }
}

function observeDiagnostic(outcome: WebViewOutcome): string {
  const backend = outcome.result?.backend;
  return `backend=${typeof backend === "string" ? backend.slice(0, 40) : "unknown"}, web-element-id nodes=${webNodes(outcome).length}, artifact pointer=${outcome.artifactPointerSeen === true || isRecord(outcome.result?.artifact)}`;
}

/** Retry only readiness reads. Actions execute once. Always release with .actions-done. */
export async function driveWebViewSteps(
  driver: WebViewDriver,
): Promise<Map<string, WebViewOutcome>> {
  const outcomes = new Map<string, WebViewOutcome>();
  try {
    await driver.ready();
    let selector: WebButtonSelector | undefined;
    for (const step of WEB_VIEW_STEPS) {
      if (step.caseName === "stale-handle") {
        await driver.navigate();
        outcomes.set("after-navigation", await observeWebView(driver));
        outcomes.set(
          step.caseName,
          selector
            ? await driver.invoke(step.tool, {
                ...step.args,
                selector: JSON.stringify(selector),
                exactText: true,
              })
            : { error: "fixture has no observed button selector" },
        );
        continue;
      }
      let outcome: WebViewOutcome =
        step.caseName === "observe"
          ? await observeWebView(driver)
          : await driver.invoke(step.tool, step.args);
      let artifactPointerSeen = outcome.artifactPointerSeen === true;
      const deadline = driver.timer.now() + 30_000;
      while (
        step.caseName === "observe" &&
        !webViewObservationReady(outcome) &&
        !(outcome.error && outcome.artifactPointerSeen) &&
        driver.timer.now() < deadline
      ) {
        await driver.timer.sleep(500);
        outcome = await observeWebView(driver);
        artifactPointerSeen ||= outcome.artifactPointerSeen === true;
      }
      if (step.caseName === "observe") {
        outcome = { ...outcome, artifactPointerSeen };
        selector = observedWebButtonSelector(outcome);
      }
      outcomes.set(step.caseName, outcome);
      if (step.caseName === "observe" && !webViewObservationReady(outcome)) {
        return outcomes;
      }
    }
    return outcomes;
  } finally {
    await driver.release();
  }
}

function finding(
  caseName: string,
  boundary: ContractFinding["boundary"],
  message: string,
): ContractFinding[] {
  return [{ slice: WEB_VIEW_SLICE, caseName, boundary, message }];
}

function judgeObserve(outcome: WebViewOutcome, log: WebViewHostLog): ContractFinding[] {
  if (!webViewObservationReady(outcome)) {
    return finding(
      "observe",
      outcome.error && outcome.artifactPointerSeen ? "mcp-surface" : "ios-client",
      `observe did not expose DOM handles beneath the WKWebView in its full hierarchy (${observeDiagnostic(outcome)})${outcome.error ? `: ${outcome.error.slice(0, 160)}` : ""}`,
    );
  }
  const entries = webNodes(outcome);
  if (
    entries.some(
      ({ attributes }) =>
        attributes["web-origin"] !== log.origin ||
        attributes[WEB_ELEMENT_ID_ATTRIBUTE] === WEB_VIEW_NODES.disallowed ||
        attributes[WEB_ELEMENT_ID_ATTRIBUTE] === WEB_VIEW_NODES.allowed,
    )
  ) {
    // The current bridge snapshots only the main document, including for an allowed child frame.
    return finding(
      "observe",
      "sdk-adapter",
      "a child-frame or disallowed-origin DOM element escaped the main-document policy",
    );
  }
  if (
    [WEB_VIEW_NODES.button, WEB_VIEW_NODES.input].some((id) => {
      const attributes = node(outcome, id)?.attributes;
      const role = id === WEB_VIEW_NODES.button ? "button" : "input";
      return (
        attributes?.[WEB_ROLE_ATTRIBUTE] !== role ||
        !log.captures.some(
          (capture) =>
            capture.snapshotId === attributes?.[WEB_SNAPSHOT_ID_ATTRIBUTE] &&
            capture.documentId === attributes?.[WEB_DOCUMENT_ID_ATTRIBUTE],
        )
      );
    })
  ) {
    return finding(
      "observe",
      "ios-client",
      "the DOM role or snapshot/document handle disagrees with the host's bridge captures",
    );
  }
  return [];
}

function actionBackend(caseName: string, outcome: ToolOutcome): boolean {
  if (outcome.error !== undefined || outcome.result?.success !== true) {
    return false;
  }
  if (caseName !== "input") {
    return outcome.result.backend === "sdk";
  }
  const commands = outcome.result.commands;
  return (
    Array.isArray(commands) &&
    commands.length > 0 &&
    commands.every(
      (command: unknown) =>
        isRecord(command) && command.success === true && command.backend === "sdk",
    )
  );
}

/** Keep the real MCP error, including sendKeys' per-command failure, without unbounded output. */
function actionDiagnostic(outcome: ToolOutcome): string {
  const error = toolFailureMessage(outcome.result) ?? outcome.error;
  return typeof error === "string"
    ? ` (MCP: ${error.slice(0, 240)})`
    : ` (MCP success=${String(outcome.result?.success)})`;
}

function judgeEffect(
  caseName: "tap" | "input",
  outcome: ToolOutcome,
  log: WebViewHostLog,
): ContractFinding[] {
  const events = log.pageEvents.filter(
    (event) =>
      event.kind === (caseName === "tap" ? "click" : "input") &&
      event.documentId === log.captures[0]?.documentId,
  );
  if (caseName === "tap" && (events.length > 1 || events.some((event) => event.clicks > 1))) {
    return finding(
      caseName,
      "sdk-adapter",
      `the initial document observed extra clicks; expected exactly one${actionDiagnostic(outcome)}`,
    );
  }
  const hostRan =
    caseName === "tap"
      ? events.length === 1 && events[0].clicks === 1
      : events.some((event) => event.value === "") && events.at(-1)?.value === WEB_VIEW_TEXT;
  const reported = actionBackend(caseName, outcome);
  if (hostRan && reported) {
    return [];
  }
  if (hostRan) {
    return finding(
      caseName,
      "mcp-surface",
      `the page observed the effect but the MCP action did not report SDK success${actionDiagnostic(outcome)}`,
    );
  }
  return finding(
    caseName,
    reported ? "ctrlproxy-command" : "ios-client",
    `the page did not observe the requested bounded action${actionDiagnostic(outcome)}`,
  );
}

function judgeStale(
  outcomes: ReadonlyMap<string, WebViewOutcome>,
  log: WebViewHostLog,
): ContractFinding[] {
  if (log.staleProbeAccepted) {
    return finding(
      "stale-handle",
      "sdk-adapter",
      "the bridge accepted the host's old-snapshot probe after navigation",
    );
  }
  const before = node(outcomes.get("observe"), WEB_VIEW_NODES.button)?.attributes;
  const afterOutcome = outcomes.get("after-navigation");
  if (afterOutcome?.error && afterOutcome.artifactPointerSeen) {
    return finding(
      "stale-handle",
      "mcp-surface",
      `after-navigation observe failed (${observeDiagnostic(afterOutcome)}): ${afterOutcome.error.slice(0, 160)}`,
    );
  }
  const after = node(afterOutcome, WEB_VIEW_NODES.button)?.attributes;
  if (
    !before ||
    !after ||
    !afterOutcome ||
    !webViewObservationReady(afterOutcome) ||
    log.staleProbeAccepted !== false ||
    before[WEB_DOCUMENT_ID_ATTRIBUTE] === after[WEB_DOCUMENT_ID_ATTRIBUTE] ||
    before[WEB_SNAPSHOT_ID_ATTRIBUTE] === after[WEB_SNAPSHOT_ID_ATTRIBUTE] ||
    !log.captures.some(
      (capture) =>
        capture.documentId === after[WEB_DOCUMENT_ID_ATTRIBUTE] &&
        capture.snapshotId === after[WEB_SNAPSHOT_ID_ATTRIBUTE],
    ) ||
    !log.rejections.some(
      (rejection) =>
        rejection.documentId === before[WEB_DOCUMENT_ID_ATTRIBUTE] &&
        log.captures.some(
          (capture) =>
            capture.snapshotId === rejection.snapshotId &&
            capture.documentId === rejection.documentId,
        ) &&
        rejection.domain === "AutoMobileWebViewBridge" &&
        rejection.code === 1,
    )
  ) {
    return finding(
      "stale-handle",
      "fixture-host",
      "navigation did not change the observed document/snapshot and prove the bridge rejected its old snapshot",
    );
  }
  const clicks = log.pageEvents.filter((event) => event.kind === "click");
  if (
    clicks.length !== 2 ||
    clicks[0]?.documentId !== before[WEB_DOCUMENT_ID_ATTRIBUTE] ||
    clicks[0]?.clicks !== 1 ||
    clicks[1]?.documentId !== after[WEB_DOCUMENT_ID_ATTRIBUTE] ||
    clicks[1]?.clicks !== 2
  ) {
    return finding(
      "stale-handle",
      "sdk-adapter",
      "the retained text selector must click each document exactly once, with distinct bridge document ids",
    );
  }
  const outcome = outcomes.get("stale-handle")!;
  return actionBackend("tap", outcome)
    ? []
    : finding(
        "stale-handle",
        "ios-client",
        `the retained text selector did not report SDK success against the new document${actionDiagnostic(outcome)}`,
      );
}

/** Every result is checked against page telemetry or bridge capture/rejection evidence. */
export function judgeWebViewCases(
  manifest: SdkContractManifest,
  outcomes: ReadonlyMap<string, WebViewOutcome>,
): ContractFinding[] {
  const log = manifest.webView;
  if (
    !log ||
    log.origin === log.disallowedOrigin ||
    !["ready", "allowed-frame", "disallowed-frame"].every((kind) =>
      log.pageEvents.some((event) => event.kind === kind),
    )
  ) {
    return finding(
      "run",
      "fixture-host",
      "the manifest lacks the web fixture or proof that both distinct-origin frames loaded",
    );
  }
  return WEB_VIEW_STEPS.flatMap((step) => {
    const outcome = outcomes.get(step.caseName);
    if (!outcome) {
      return finding(step.caseName, "fixture-host", "the harness did not run this step");
    }
    switch (step.caseName) {
      case "observe":
        return judgeObserve(outcome, log);
      case "tap":
      case "input":
        return judgeEffect(step.caseName, outcome, log);
      case "stale-handle":
        return judgeStale(outcomes, log);
    }
  });
}
