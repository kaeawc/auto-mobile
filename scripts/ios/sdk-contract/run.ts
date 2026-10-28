/**
 * iOS SDK contract suite, phase A (#5164): drives the network capture adapters inside
 * Playground on a booted simulator, then follows each event through CtrlProxy, the daemon's
 * iOS client and the MCP network resources. Every failure names the boundary that disagreed.
 *
 * Usage: bun scripts/ios/sdk-contract/run.ts --device <udid> --app <Playground.app> [--report <file>]
 * Prefer scripts/ios/sdk-contract-integration.sh, which builds Playground first.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { DaemonManager } from "../../../src/daemon/manager";
import {
  decodeSdkEventBatches,
  type SdkEventBatchWire,
} from "../../../src/features/observe/ios/decodeSdkEventBatches";
import { defaultIdGenerator } from "../../../src/utils/IdGenerator";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { NetworkState } from "../../../src/utils/NetworkState";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import { formatFindings, type ContractFinding } from "./boundaries";
import { parseSdkContractManifest, type SdkContractManifest } from "./manifest";
import { NETWORK_SLICE, judgeManifest, judgeNetworkCase, matchSdkPayload } from "./networkSlice";
import { createReferenceDatabase, replayNetworkBatch } from "./referencePipeline";
import {
  parseResourceJson,
  parseToolOutput,
  queuedRequestIds,
  readAcquisition,
  trafficIdsByRequestId,
} from "./toolOutput";

const execFileAsync = promisify(execFile);

export const PLAYGROUND_BUNDLE_ID = "dev.jasonpearson.automobile.Playground";
/** The scenario's Authorization value; it must never appear unredacted on any surface. */
const FORBIDDEN_SUBSTRINGS = ["contract-secret"];
const MANIFEST_WAIT_MS = 90_000;
const LIVE_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;
const TOOL_TIMEOUT_MS = 180_000;
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
    { maxBuffer: 64 * 1024 * 1024, timeout: TOOL_TIMEOUT_MS },
  );
  return parseToolOutput(stdout);
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

/** Polls the MCP traffic resource until every request id appears, then reads each detail. */
async function collectLiveDetails(
  context: LiveContext,
  requestIds: readonly string[],
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
    const traffic = parseResourceJson(
      await context.readResource(`automobile:network/traffic?${query}`),
    );
    ids = trafficIdsByRequestId(traffic);
    if (requestIds.every((id) => ids.has(id))) {
      break;
    }
    await defaultTimer.sleep(POLL_INTERVAL_MS);
  }
  const details = new Map<string, JsonRecord>();
  for (const requestId of requestIds) {
    const id = ids.get(requestId);
    if (id !== undefined) {
      details.set(
        requestId,
        parseResourceJson(await context.readResource(`automobile:network/request/${id}`)),
      );
    }
  }
  return details;
}

/** Drains CtrlProxy's queue (destructive) to tell an undrained event from an undelivered one. */
async function probeCtrlProxyQueue(port: number): Promise<Set<string>> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/sdk-events`);
    return queuedRequestIds(await response.text(), () => defaultTimer.now());
  } catch (error) {
    console.warn(`warning: CtrlProxy queue probe failed: ${String(error)}`);
    return new Set();
  }
}

async function judgeNetworkSlice(
  manifest: SdkContractManifest,
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
  const requestIds = payloads
    .map((payload) => payload.requestId)
    .filter((id): id is string => typeof id === "string");
  const live = await collectLiveDetails(context, requestIds);
  const queued = requestIds.some((id) => !live.has(id))
    ? await probeCtrlProxyQueue(context.ctrlProxyPort)
    : new Set<string>();
  return manifest.network.flatMap((expected) => {
    const sdkPayload = matchSdkPayload(expected, payloads);
    const requestId = typeof sdkPayload?.requestId === "string" ? sdkPayload.requestId : "";
    const replayed = reference.get(requestId);
    const result = judgeNetworkCase(
      {
        expected,
        sdkPayload,
        reference: replayed && {
          row: Object.fromEntries(Object.entries(replayed.row)),
          detail: replayed.detail,
        },
        live: live.get(requestId),
        queuedInCtrlProxy: queued.has(requestId),
      },
      FORBIDDEN_SUBSTRINGS,
    );
    return result ? [result] : [];
  });
}

async function runScenario(
  options: Options,
  sessionUuid: string,
  ctrlProxyPort: number,
): Promise<ContractFinding[]> {
  const simctl = new SimCtlClient();
  const { deviceId } = options;
  const runId = `c${defaultIdGenerator.next().replaceAll("-", "").slice(0, 20)}`;
  await callTool("network", { capture: true, platform: "ios" }, sessionUuid);
  await simctl.installApp(options.appPath, deviceId, { timeoutMs: 120_000 });
  const container = (
    await simctl.executeCommandArgs(["get_app_container", deviceId, PLAYGROUND_BUNDLE_ID, "data"])
  ).stdout.trim();
  const launchedAt = defaultTimer.now();
  const launch = await simctl.launchApp(
    PLAYGROUND_BUNDLE_ID,
    {
      environment: {
        SIMCTL_CHILD_PLAYGROUND_SDK_CONTRACT: NETWORK_SLICE,
        SIMCTL_CHILD_PLAYGROUND_SDK_CONTRACT_RUN_ID: runId,
      },
    },
    deviceId,
  );
  if (!launch.success) {
    return [fixtureFailure(`Playground did not launch: ${launch.error ?? "unknown error"}`)];
  }
  // Binds this session's CtrlProxy client so it drains the SDK events into this daemon.
  await callTool("observe", { platform: "ios" }, sessionUuid);
  const manifestText = await waitForManifest(
    join(container, "Documents", "sdk-contract", `${runId}.json`),
  );
  if (manifestText === undefined) {
    return [fixtureFailure(`no manifest for run ${runId} after ${MANIFEST_WAIT_MS} ms`)];
  }
  const parsed = parseSdkContractManifest(manifestText);
  if (!parsed.success) {
    return [fixtureFailure(parsed.error)];
  }
  const manifestFindings = judgeManifest(parsed.manifest);
  if (parsed.manifest.status === "failed") {
    return manifestFindings;
  }
  const client = new DaemonManager().createClient();
  await client.connect();
  try {
    const caseFindings = await judgeNetworkSlice(parsed.manifest, {
      deviceId,
      sessionUuid,
      ctrlProxyPort,
      sinceMs: launchedAt - CLOCK_SKEW_MS,
      readResource: (uri) => client.readResource(uri),
    });
    return [...manifestFindings, ...caseFindings];
  } finally {
    await client.close();
  }
}

function fixtureFailure(message: string): ContractFinding {
  return { slice: NETWORK_SLICE, caseName: "run", boundary: "fixture-host", message };
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseOptions(argv);
  const { sessionUuid, ctrlProxyPort } = readAcquisition(
    await callTool("getApple", { deviceId: options.deviceId }),
  );
  let findings: ContractFinding[];
  try {
    findings = await runScenario(options, sessionUuid, ctrlProxyPort);
  } finally {
    await new SimCtlClient()
      .terminateApp(PLAYGROUND_BUNDLE_ID, options.deviceId)
      .catch((error: unknown) => console.warn(`warning: terminate failed: ${String(error)}`));
    await releaseSession(sessionUuid);
  }
  console.log(formatFindings(findings));
  if (options.reportPath) {
    await writeFile(options.reportPath, `${JSON.stringify({ findings }, null, 2)}\n`);
  }
  return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
