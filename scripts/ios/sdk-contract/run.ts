/**
 * iOS SDK contract suite (#5164): launches Playground once per scenario on a booted simulator
 * and follows what the SDK did through CtrlProxy, the daemon's iOS client and the MCP network
 * resources. Scenarios: `network` (capture through each registered transport), `capabilities`
 * (the host registration capability matrix), `faults` (delay and fail rules sent through
 * CtrlProxy and applied by the registered transports), `observe` (observe, tapOn and sendKeys
 * through the SDK observation bridge) and `storage-default` / `storage` (the storage capability
 * resource for the default and a registered storage configuration). Every failure names the
 * boundary that disagreed.
 *
 * Usage: bun scripts/ios/sdk-contract/run.ts --device <udid> --app <Playground.app> [--report <file>]
 * Prefer scripts/ios/sdk-contract-integration.sh, which builds Playground first.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  decodeSdkEventBatches,
  type SdkEventBatchWire,
} from "../../../src/features/observe/ios/decodeSdkEventBatches";
import { defaultIdGenerator } from "../../../src/utils/IdGenerator";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { NetworkState } from "../../../src/utils/NetworkState";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import { formatFindings, type ContractBoundary, type ContractFinding } from "./boundaries";
import { CAPABILITY_SLICE, judgeCapabilities } from "./capabilitySlice";
import { setFaultRulesThroughCtrlProxy } from "./ctrlProxyFaultRules";
import {
  FAULT_SLICE,
  expectedFaultRecords,
  faultRules,
  judgeFaultClientOutcomes,
} from "./faultSlice";
import {
  parseSdkContractManifest,
  type ExpectedNetworkEvent,
  type SdkContractManifest,
} from "./manifest";
import {
  NETWORK_SLICE,
  PLAYGROUND_BUNDLE_ID,
  FORBIDDEN_SUBSTRINGS,
  judgeManifest,
  judgeNetworkCase,
  matchSdkPayload,
  networkRecordKey,
} from "./networkSlice";
import {
  OBSERVATION_SLICE,
  OBSERVATION_STEPS,
  judgeObservationCases,
  type ToolOutcome,
} from "./observationSlice";
import { createReferenceDatabase, replayNetworkBatch } from "./referencePipeline";
import {
  STORAGE_DEFAULT_SLICE,
  STORAGE_SLICE,
  judgeStorageReport,
  judgeUnreachableStorageReport,
} from "./storageSlice";
import {
  parseResourceJson,
  parseToolOutput,
  queuedRecordKeys,
  readAcquisition,
  trafficIdsByKey,
} from "./toolOutput";

const execFileAsync = promisify(execFile);

export { PLAYGROUND_BUNDLE_ID } from "./networkSlice";
const MANIFEST_WAIT_MS = 90_000;
const LIVE_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const TOOL_TIMEOUT_MS = 180_000;
/**
 * The CLI idle window each call declares for the session. The default (2 min) is shorter than the
 * harness's quiet stretches between tool calls (app install, launch, the manifest wait), and a
 * session that idles past it is released and cannot be reused.
 */
const CLI_SESSION_IDLE_TIMEOUT_MS = 15 * 60_000;
const CLI_ENV = {
  ...process.env,
  AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS: String(CLI_SESSION_IDLE_TIMEOUT_MS),
};
/** Traffic rows older than the launch minus this skew belong to earlier runs. */
const CLOCK_SKEW_MS = 60_000;

interface Options {
  deviceId: string;
  appPath: string;
  reportPath: string | undefined;
}

type JsonRecord = Record<string, unknown>;

export function parseOptions(argv: readonly string[]): Options {
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const deviceId = value("--device");
  const appPath = value("--app");
  if (!deviceId || !appPath) {
    throw new Error(
      "Usage: run.ts --device <simulator-udid> --app <Playground.app> [--report <file>]",
    );
  }
  return { deviceId, appPath, reportPath: value("--report") };
}

/** Tool calls use the auto-mobile CLI, as the other simulator-lane scripts do. */
async function callTool(
  tool: string,
  args: Record<string, string | boolean>,
  sessionUuid?: string,
): Promise<JsonRecord> {
  const flags = Object.entries(args).flatMap(([key, val]) => [`--${key}`, String(val)]);
  const session = sessionUuid ? ["--session-uuid", sessionUuid] : [];
  const { stdout } = await execFileAsync(
    "auto-mobile",
    ["--debug", "--embedded-sdk", "--cli", ...session, tool, ...flags],
    { maxBuffer: 64 * 1024 * 1024, timeout: TOOL_TIMEOUT_MS, env: CLI_ENV },
  );
  return parseToolOutput(stdout);
}

/** A tool call that may fail: the observation slice judges failures as well as results. */
async function invokeTool(
  tool: string,
  args: Record<string, string | boolean>,
  sessionUuid: string,
): Promise<ToolOutcome> {
  try {
    const result = await callTool(tool, args, sessionUuid);
    return result.success === false
      ? { result, error: String(result.error ?? "tool reported success: false") }
      : { result };
  } catch (error) {
    const output = error as { stdout?: unknown; stderr?: unknown };
    return { error: [String(error), output.stdout, output.stderr].filter(Boolean).join("\n") };
  }
}

async function releaseSession(sessionUuid: string): Promise<void> {
  try {
    await execFileAsync("auto-mobile", ["--daemon", "release-session", sessionUuid], {
      env: { ...process.env, AUTOMOBILE_DAEMON_TIMEOUT_MS: "2000" },
      timeout: 30_000,
    });
  } catch (error) {
    console.warn(`warning: could not release session ${sessionUuid}: ${String(error)}`);
  }
}

async function waitForManifest(path: string): Promise<string | undefined> {
  const deadline = defaultTimer.now() + MANIFEST_WAIT_MS;
  while (defaultTimer.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await defaultTimer.sleep(500);
  }
  return undefined;
}

interface LiveContext {
  deviceId: string;
  sessionUuid: string;
  sinceMs: number;
  readResource: (uri: string) => Promise<unknown>;
}

/** Polls the MCP traffic resource until every record key appears, then reads each detail. */
async function collectLiveDetails(
  context: LiveContext,
  keys: readonly string[],
): Promise<Map<string, JsonRecord>> {
  const query = new URLSearchParams({
    deviceId: context.deviceId,
    host: "127.0.0.1",
    since: String(context.sinceMs),
    limit: "200",
  });
  const deadline = defaultTimer.now() + LIVE_WAIT_MS;
  let ids = new Map<string, number>();
  while (defaultTimer.now() < deadline) {
    // observe keeps the session's CtrlProxy client draining /sdk-events.
    await callTool("observe", { platform: "ios" }, context.sessionUuid);
    const traffic = await atBoundary("mcp-surface", async () =>
      parseResourceJson(await context.readResource(`automobile:network/traffic?${query}`)),
    );
    ids = trafficIdsByKey(traffic);
    if (keys.every((key) => ids.has(key))) {
      break;
    }
    await defaultTimer.sleep(POLL_INTERVAL_MS);
  }
  const details = new Map<string, JsonRecord>();
  for (const key of keys) {
    const id = ids.get(key);
    if (id !== undefined) {
      details.set(
        key,
        await atBoundary("mcp-surface", async () =>
          parseResourceJson(await context.readResource(`automobile:network/request/${id}`)),
        ),
      );
    }
  }
  return details;
}

/** Drains CtrlProxy's queue (destructive) to tell an undrained event from an undelivered one. */
export async function probeCtrlProxyQueue(
  port: number,
  fetchQueue: (url: string) => Promise<Pick<Response, "ok" | "status" | "text">> = fetch,
): Promise<Set<string> | undefined> {
  try {
    const response = await fetchQueue(`http://127.0.0.1:${port}/sdk-events`);
    if (!response.ok) {
      throw new Error(`CtrlProxy queue probe returned HTTP ${response.status}`);
    }
    return queuedRecordKeys(await response.text(), () => defaultTimer.now());
  } catch (error) {
    console.warn(`warning: CtrlProxy queue probe failed: ${String(error)}`);
    return undefined;
  }
}

/** Judges each expected record at every boundary, from the SDK payload to the live resource. */
async function judgeNetworkRecords(
  manifest: SdkContractManifest,
  expectedRecords: readonly ExpectedNetworkEvent[],
  slice: string,
  context: LiveContext & { ctrlProxyPort: number },
): Promise<ContractFinding[]> {
  const batch: SdkEventBatchWire = { bundleId: manifest.bundleId, events: manifest.events };
  const payloads = decodeSdkEventBatches([batch], () => defaultTimer.now()).events.map(
    (event) => event.payload,
  );
  NetworkState.getInstance().setCapture(true);
  const reference = await replayNetworkBatch({
    db: await createReferenceDatabase(),
    deviceId: context.deviceId,
    batch,
  });
  const keyed = expectedRecords.map((expected) => {
    const sdkPayload = matchSdkPayload(expected, payloads);
    return { expected, sdkPayload, key: sdkPayload ? networkRecordKey(sdkPayload) : undefined };
  });
  const keys = keyed.flatMap(({ key }) => (key === undefined ? [] : [key]));
  const live = await collectLiveDetails(context, keys);
  const queued = keys.some((key) => !live.has(key))
    ? await probeCtrlProxyQueue(context.ctrlProxyPort)
    : new Set<string>();
  return keyed.flatMap(({ expected, sdkPayload, key }) => {
    const replayed = key === undefined ? undefined : reference.get(key);
    const result = judgeNetworkCase(
      {
        expected,
        sdkPayload,
        reference: replayed && {
          row: Object.fromEntries(Object.entries(replayed.row)),
          detail: replayed.detail,
        },
        live: key === undefined ? undefined : live.get(key),
        queuedInCtrlProxy: key === undefined ? false : queued?.has(key),
        slice,
      },
      FORBIDDEN_SUBSTRINGS,
    );
    return result ? [result] : [];
  });
}

/** Preserves the operation's boundary when an exception crosses the scenario runner. */
class ScenarioError extends Error {
  constructor(
    readonly boundary: ContractBoundary,
    cause: unknown,
  ) {
    super(String(cause), { cause });
  }
}

async function atBoundary<T>(boundary: ContractBoundary, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw error instanceof ScenarioError ? error : new ScenarioError(boundary, error);
  }
}

export async function collectScenarioFindings<T extends string>(
  scenarios: readonly T[],
  run: (scenario: T) => Promise<ContractFinding[]>,
): Promise<ContractFinding[]> {
  const findings: ContractFinding[] = [];
  for (const scenario of scenarios) {
    try {
      findings.push(...(await run(scenario)));
    } catch (error) {
      findings.push({
        slice: scenario,
        caseName: "run",
        boundary: error instanceof ScenarioError ? error.boundary : "ios-client",
        message: String(error),
      });
    }
  }
  return findings;
}

interface ScenarioContext {
  options: Options;
  sessionUuid: string;
  ctrlProxyPort: number;
  container: string;
}

const SCENARIOS = [
  NETWORK_SLICE,
  CAPABILITY_SLICE,
  FAULT_SLICE,
  OBSERVATION_SLICE,
  STORAGE_DEFAULT_SLICE,
  STORAGE_SLICE,
] as const;
/** How long observe may take to report the contract bridge after launch. */
const BRIDGE_READY_WAIT_MS = 30_000;
type Scenario = (typeof SCENARIOS)[number];

function contractDirectory(container: string): string {
  return join(container, "Documents", "sdk-contract");
}

/**
 * Sends the fault rules through CtrlProxy, then releases Playground's fault scenario, which
 * waits for `<runId>.rules-ready` so no case runs before the rules reach the SDK.
 */
async function installFaultRules(
  context: ScenarioContext,
  runId: string,
): Promise<ContractFinding | undefined> {
  const delivery = await atBoundary("ctrlproxy-command", () =>
    setFaultRulesThroughCtrlProxy(context.ctrlProxyPort, faultRules(runId)),
  );
  if (!delivery.success) {
    return {
      slice: FAULT_SLICE,
      caseName: "rules",
      boundary: "ctrlproxy-command",
      message: `set_network_fault_rules did not reach the SDK: ${delivery.error}`,
    };
  }
  const directory = contractDirectory(context.container);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${runId}.rules-ready`), "ready\n");
  return undefined;
}

/**
 * Drives the observation steps while Playground keeps its contract bridge registered, then
 * releases it with `<runId>.actions-done`. observe is retried until the bridge is up.
 */
async function driveObservationSteps(
  context: ScenarioContext,
  runId: string,
): Promise<Map<string, ToolOutcome>> {
  const outcomes = new Map<string, ToolOutcome>();
  const deadline = defaultTimer.now() + BRIDGE_READY_WAIT_MS;
  for (const step of OBSERVATION_STEPS) {
    let outcome = await invokeTool(step.tool, step.args, context.sessionUuid);
    while (
      step.tool === "observe" &&
      outcome.result?.backend !== "sdk" &&
      defaultTimer.now() < deadline
    ) {
      await defaultTimer.sleep(POLL_INTERVAL_MS);
      outcome = await invokeTool(step.tool, step.args, context.sessionUuid);
    }
    outcomes.set(step.caseName, outcome);
  }
  const directory = contractDirectory(context.container);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${runId}.actions-done`), "done\n");
  return outcomes;
}

/** The storage capability resource for Playground, as an MCP client reads it. */
export async function readStorageCapabilities(
  deviceId: string,
  connect: () => Promise<Pick<Client, "readResource" | "close">> = connectMcpClient,
): Promise<JsonRecord> {
  const client = await atBoundary("mcp-surface", connect);
  try {
    const uri = `automobile:devices/${deviceId}/storage/capabilities?appId=${PLAYGROUND_BUNDLE_ID}`;
    return await atBoundary("mcp-surface", async () =>
      parseResourceJson(await client.readResource({ uri }, { timeout: TOOL_TIMEOUT_MS })),
    );
  } finally {
    await atBoundary("mcp-surface", () => client.close());
  }
}

/**
 * Reads the storage resource while Playground serves its registration and, for the registered
 * scenario, again after terminating Playground, when the SDK must be reported unreachable.
 */
async function judgeStorage(
  manifest: SdkContractManifest,
  deviceId: string,
): Promise<ContractFinding[]> {
  const findings = judgeStorageReport(manifest, await readStorageCapabilities(deviceId));
  if (manifest.scenario !== STORAGE_SLICE) {
    return findings;
  }
  await new SimCtlClient().terminateApp(PLAYGROUND_BUNDLE_ID, deviceId).catch(() => undefined);
  return [
    ...findings,
    ...judgeUnreachableStorageReport(STORAGE_SLICE, await readStorageCapabilities(deviceId)),
  ];
}

async function judgeScenario(
  scenario: Scenario,
  manifest: SdkContractManifest,
  live: Omit<LiveContext, "readResource"> & {
    ctrlProxyPort: number;
    observationOutcomes?: ReadonlyMap<string, ToolOutcome>;
  },
): Promise<ContractFinding[]> {
  if (scenario === CAPABILITY_SLICE) {
    return judgeCapabilities(manifest);
  }
  if (scenario === OBSERVATION_SLICE) {
    return judgeObservationCases(manifest, live.observationOutcomes ?? new Map());
  }
  if (scenario === STORAGE_SLICE || scenario === STORAGE_DEFAULT_SLICE) {
    return judgeStorage(manifest, live.deviceId);
  }
  const expected =
    scenario === FAULT_SLICE ? expectedFaultRecords(manifest, manifest.runId) : manifest.network;
  const clientFindings = scenario === FAULT_SLICE ? judgeFaultClientOutcomes(manifest) : [];
  const client = await atBoundary("mcp-surface", connectMcpClient);
  try {
    const recordFindings = await judgeNetworkRecords(manifest, expected, scenario, {
      ...live,
      readResource: (uri) =>
        atBoundary("mcp-surface", () => client.readResource({ uri }, { timeout: TOOL_TIMEOUT_MS })),
    });
    return [...clientFindings, ...recordFindings];
  } finally {
    await atBoundary("mcp-surface", () => client.close());
  }
}

async function runScenario(
  context: ScenarioContext,
  scenario: Scenario,
): Promise<ContractFinding[]> {
  let boundary: ContractBoundary = "fixture-host";
  try {
    const simctl = new SimCtlClient();
    const { deviceId } = context.options;
    const runId = `c${defaultIdGenerator.next().replaceAll("-", "").slice(0, 20)}`;
    // A fresh process per scenario: host registration cannot be undone in-process.
    await simctl.terminateApp(PLAYGROUND_BUNDLE_ID, deviceId).catch(() => undefined);
    const launchedAt = defaultTimer.now();
    const launch = await simctl.launchApp(
      PLAYGROUND_BUNDLE_ID,
      {
        environment: {
          SIMCTL_CHILD_PLAYGROUND_SDK_CONTRACT: scenario,
          SIMCTL_CHILD_PLAYGROUND_SDK_CONTRACT_RUN_ID: runId,
        },
      },
      deviceId,
    );
    if (!launch.success) {
      return [
        fixtureFailure(scenario, `Playground did not launch: ${launch.error ?? "unknown error"}`),
      ];
    }
    // Binds this session's CtrlProxy client so it drains the SDK events into this daemon, and
    // makes Playground CtrlProxy's tracked foreground app for the fault-rule command.
    boundary = "ios-client";
    await callTool("observe", { platform: "ios" }, context.sessionUuid);
    boundary = "fixture-host";
    if (scenario === FAULT_SLICE) {
      const failure = await installFaultRules(context, runId);
      if (failure) {
        return [failure];
      }
    }
    const observationOutcomes =
      scenario === OBSERVATION_SLICE ? await driveObservationSteps(context, runId) : undefined;
    const manifestText = await waitForManifest(
      join(contractDirectory(context.container), `${runId}.json`),
    );
    if (manifestText === undefined) {
      return [
        fixtureFailure(scenario, `no manifest for run ${runId} after ${MANIFEST_WAIT_MS} ms`),
      ];
    }
    const parsed = parseSdkContractManifest(manifestText);
    if (!parsed.success) {
      return [fixtureFailure(scenario, parsed.error)];
    }
    const manifestFindings = judgeManifest(parsed.manifest, scenario);
    if (parsed.manifest.status === "failed") {
      return manifestFindings;
    }
    boundary = "ios-client";
    const caseFindings = await judgeScenario(scenario, parsed.manifest, {
      deviceId,
      sessionUuid: context.sessionUuid,
      ctrlProxyPort: context.ctrlProxyPort,
      sinceMs: launchedAt - CLOCK_SKEW_MS,
      observationOutcomes,
    });
    return [...manifestFindings, ...caseFindings];
  } catch (error) {
    throw error instanceof ScenarioError ? error : new ScenarioError(boundary, error);
  }
}

async function runScenarios(
  options: Options,
  sessionUuid: string,
  ctrlProxyPort: number,
): Promise<ContractFinding[]> {
  const simctl = new SimCtlClient();
  await callTool("network", { capture: true, platform: "ios" }, sessionUuid);
  await atBoundary("fixture-host", () =>
    simctl.installApp(options.appPath, options.deviceId, { timeoutMs: 120_000 }),
  );
  const container = (
    await atBoundary("fixture-host", () =>
      simctl.executeCommandArgs([
        "get_app_container",
        options.deviceId,
        PLAYGROUND_BUNDLE_ID,
        "data",
      ]),
    )
  ).stdout.trim();
  const context: ScenarioContext = { options, sessionUuid, ctrlProxyPort, container };
  return collectScenarioFindings(SCENARIOS, (scenario) => runScenario(context, scenario));
}

/**
 * Reads MCP resources the way an MCP client does: the official client over stdio to this
 * checkout's built server (as scripts/mcp-drive.ts does), which forwards to the running
 * daemon. A direct daemon-socket client run from source would fail the daemon's build
 * handshake, because its build identity is the script, not dist/src/index.js.
 */
async function connectMcpClient(): Promise<Client> {
  const client = new Client({ name: "ios-sdk-contract", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(fileURLToPath(new URL("../../../dist/src/index.js", import.meta.url)))],
    stderr: "inherit",
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  });
  await client.connect(transport);
  return client;
}

function fixtureFailure(slice: string, message: string): ContractFinding {
  return { slice, caseName: "run", boundary: "fixture-host", message };
}

interface HarnessRuntime {
  acquire: (deviceId: string) => Promise<{ sessionUuid: string; ctrlProxyPort: number }>;
  run: typeof runScenarios;
  cleanup: (deviceId: string, sessionUuid: string) => Promise<void>;
  writeReport: (path: string, contents: string) => Promise<void>;
  output: (text: string) => void;
}

const defaultRuntime: HarnessRuntime = {
  acquire: async (deviceId) => readAcquisition(await callTool("getApple", { deviceId })),
  run: runScenarios,
  cleanup: async (deviceId, sessionUuid) => {
    await new SimCtlClient()
      .terminateApp(PLAYGROUND_BUNDLE_ID, deviceId)
      .catch((error: unknown) => console.warn(`warning: terminate failed: ${String(error)}`));
    await releaseSession(sessionUuid);
  },
  writeReport: async (path, contents) => {
    await writeFile(path, contents);
  },
  output: (text) => console.log(text),
};

export async function main(
  argv: readonly string[],
  runtime: HarnessRuntime = defaultRuntime,
): Promise<number> {
  const options = parseOptions(argv);
  const { sessionUuid, ctrlProxyPort } = await runtime.acquire(options.deviceId);
  let findings: ContractFinding[];
  try {
    findings = await runtime.run(options, sessionUuid, ctrlProxyPort);
  } catch (error) {
    findings = [
      {
        slice: "harness",
        caseName: "run",
        boundary: error instanceof ScenarioError ? error.boundary : "ios-client",
        message: String(error),
      },
    ];
  } finally {
    await runtime.cleanup(options.deviceId, sessionUuid);
  }
  runtime.output(formatFindings(findings));
  if (options.reportPath) {
    await runtime.writeReport(options.reportPath, `${JSON.stringify({ findings }, null, 2)}\n`);
  }
  return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
