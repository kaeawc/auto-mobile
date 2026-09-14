#!/usr/bin/env bun

import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DaemonClient } from "../src/daemon/client";
import { SOCKET_PATH } from "../src/daemon/constants";
import {
  getAndroidSchema,
  killDeviceSchema,
  provisionDeviceSchema,
  startDeviceSchema,
} from "../src/server/deviceTools";
import { defaultTimer, type Timer } from "../src/utils/SystemTimer";

const ENABLED_TOOLS = ["observe", "getDeviceState"] as const;
const MAX_CLEANUP_RESERVE_MS = 15_000;
const MAX_EVIDENCE_RESERVE_MS = 5_000;

type Platform = "android" | "ios";
type Scenario = "full" | "recovery";
type JsonObject = Record<string, unknown>;
type Budget = "work" | "cleanup" | "evidence";

export interface AcceptanceArgs {
  platform: Platform;
  target: {
    avdName?: string;
    simulatorName?: string;
    simulatorUdid?: string;
  };
  runtime: string;
  deviceType: string;
  osVersionRange: {
    min: string;
    max: string;
  };
  androidConfig?: {
    memoryMb: number;
    cpuCores: number;
  };
  scenario: Scenario;
  evidencePath: string;
  timeoutMs: number;
  confirmLive: boolean;
  testOwnedDevices: boolean;
}

interface RuntimeIdentity {
  stableIdentity: string;
  androidSerial?: string;
  androidConsolePort?: number;
  androidConsoleEndpoint?: string;
}

interface ExactDevice {
  name: string;
  deviceId: string;
  platform: Platform;
}

interface AcquiredSession {
  phase: string;
  client: McpSessionClient;
  sessionUuid: string;
  identity: RuntimeIdentity;
  device: ExactDevice;
}

interface MintedSession {
  phase: string;
  sessionUuid: string;
  released: boolean;
}

interface ToolResponse {
  isError?: boolean;
  structuredContent?: JsonObject;
  content?: Array<{ type?: string; text?: string }>;
}

export interface McpSessionClient {
  callTool(name: string, arguments_: JsonObject): Promise<ToolResponse>;
  close(): Promise<void>;
}

export interface DaemonSessionClient {
  callDaemonMethod(name: string, arguments_: JsonObject): Promise<unknown>;
  close(): Promise<void>;
}

export interface MatrixDependencies {
  /** Explicit test seam; production calls must satisfy the live safeguards below. */
  testOnly?: boolean;
  timer?: Timer;
  spawnCli?: (command: string[], timeoutMs: number) => Promise<void>;
  createMcpClient?: (owner: string) => Promise<McpSessionClient>;
  createDaemonClient?: () => Promise<DaemonSessionClient>;
  restartDaemon?: (timeoutMs: number) => Promise<void>;
  writeFile?: (path: string, content: string, signal: AbortSignal) => Promise<void>;
}

interface Step {
  name: string;
  passed: boolean;
  elapsedMs: number;
  detail: JsonObject;
}

interface Evidence {
  schemaVersion: 5;
  generatedAt: string;
  scenario: Scenario;
  platform: Platform;
  target: JsonObject;
  provision: JsonObject;
  acquisitionRequests: JsonObject[];
  runtimeIdentities: JsonObject[];
  checks: JsonObject;
  cleanup: JsonObject;
  outcome: JsonObject;
  steps: Step[];
}

function requiredFlag(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function parseInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

export function parseArgs(argv: string[]): AcceptanceArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length;) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`Expected --flag value pairs, received ${argv.slice(index).join(" ")}`);
    }
    const name = flag.slice(2);
    if (name === "confirm-live" || name === "test-owned-devices") {
      values.set(name, "true");
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Expected --flag value pairs, received ${argv.slice(index).join(" ")}`);
    }
    values.set(name, value);
    index += 2;
  }

  const platform = requiredFlag(values, "platform");
  if (platform !== "android" && platform !== "ios") {
    throw new Error("--platform must be android or ios");
  }
  const scenario = requiredFlag(values, "scenario");
  if (scenario !== "full" && scenario !== "recovery") {
    throw new Error("--scenario must be full or recovery");
  }
  const target =
    platform === "android"
      ? { avdName: requiredFlag(values, "avd-name") }
      : {
          simulatorName: requiredFlag(values, "simulator-name"),
          simulatorUdid: requiredFlag(values, "simulator-uuid"),
        };
  return {
    platform,
    target,
    runtime: requiredFlag(values, "runtime"),
    deviceType: requiredFlag(values, "device-type"),
    osVersionRange: {
      min: requiredFlag(values, "min-os-version"),
      max: requiredFlag(values, "max-os-version"),
    },
    androidConfig:
      platform === "android"
        ? {
            memoryMb: parseInteger(requiredFlag(values, "android-memory-mb"), "android-memory-mb"),
            cpuCores: parseInteger(requiredFlag(values, "android-cpu-cores"), "android-cpu-cores"),
          }
        : undefined,
    scenario,
    evidencePath: requiredFlag(values, "evidence"),
    timeoutMs: parseInteger(requiredFlag(values, "timeout-ms"), "timeout-ms"),
    confirmLive: values.get("confirm-live") === "true",
    testOwnedDevices: values.get("test-owned-devices") === "true",
  };
}

function asObject(value: unknown, context: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonObject;
}

function stringField(value: JsonObject, field: string, context: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`${context}.${field} must be a non-empty string`);
  }
  return candidate;
}

function toolDiagnostic(response: ToolResponse, tool: string): string {
  const payload = response.structuredContent;
  if (payload) {
    const error = payload.error;
    if (typeof error === "string") {
      return error;
    }
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const message = (error as JsonObject).message;
      if (typeof message === "string") {
        return message;
      }
    }
    if (typeof payload.message === "string") {
      return payload.message;
    }
  }
  for (const item of response.content ?? []) {
    if (item.type !== "text" || !item.text) {
      continue;
    }
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === "object") {
        const object = parsed as JsonObject;
        if (typeof object.message === "string") {
          return object.message;
        }
        const error = object.error;
        if (error && typeof error === "object" && !Array.isArray(error)) {
          const message = (error as JsonObject).message;
          if (typeof message === "string") {
            return message;
          }
        }
      }
    } catch {
      return item.text;
    }
  }
  return `${tool} returned no diagnostic`;
}

function toolPayload(response: ToolResponse, tool: string): JsonObject {
  if (response.isError) {
    throw new Error(`${tool} returned an MCP error: ${toolDiagnostic(response, tool)}`);
  }
  if (!response.structuredContent) {
    throw new Error(`${tool} did not return structuredContent`);
  }
  return response.structuredContent;
}

function targetIdentity(args: AcceptanceArgs): string {
  return args.platform === "android" ? args.target.avdName! : args.target.simulatorUdid!;
}

function targetDeviceName(args: AcceptanceArgs): string {
  return args.platform === "android" ? args.target.avdName! : args.target.simulatorName!;
}

function endpoint(serial: string, consolePort: number | null): string | undefined {
  return consolePort === null ? undefined : `${serial}:${consolePort}`;
}

function acquiredIdentity(
  payload: JsonObject,
  args: AcceptanceArgs,
): {
  identity: RuntimeIdentity;
  device: ExactDevice;
} {
  const deviceIdentity = asObject(payload.deviceIdentity, "acquire.deviceIdentity");
  if (args.platform === "android") {
    const avdName = stringField(deviceIdentity, "avdName", "acquire.deviceIdentity");
    if (avdName !== args.target.avdName) {
      throw new Error(`acquire returned AVD ${avdName}, expected ${args.target.avdName}`);
    }
    const androidSerial = stringField(deviceIdentity, "adbSerial", "acquire.deviceIdentity");
    const rawPort = deviceIdentity.emulatorConsolePort;
    const consolePort =
      typeof rawPort === "number" && Number.isInteger(rawPort) && rawPort > 0 ? rawPort : null;
    return {
      identity: {
        stableIdentity: avdName,
        androidSerial,
        ...(consolePort === null ? {} : { androidConsolePort: consolePort }),
        androidConsoleEndpoint: endpoint(androidSerial, consolePort),
      },
      device: { name: avdName, deviceId: androidSerial, platform: "android" },
    };
  }

  const simulatorUdid = stringField(deviceIdentity, "simulatorUdid", "acquire.deviceIdentity");
  if (simulatorUdid !== args.target.simulatorUdid) {
    throw new Error(
      `acquire returned simulator ${simulatorUdid}, expected ${args.target.simulatorUdid}`,
    );
  }
  const simulatorName = stringField(deviceIdentity, "simulatorName", "acquire.deviceIdentity");
  if (simulatorName !== args.target.simulatorName) {
    throw new Error(
      `acquire returned simulator name ${simulatorName}, expected ${args.target.simulatorName}`,
    );
  }
  return {
    identity: { stableIdentity: simulatorUdid },
    device: { name: simulatorName, deviceId: simulatorUdid, platform: "ios" },
  };
}

function provisionRequest(args: AcceptanceArgs): JsonObject {
  return {
    operationId: crypto.randomUUID(),
    device:
      args.platform === "android"
        ? {
            platform: "android",
            name: args.target.avdName,
            spec: {
              runtime: args.runtime,
              deviceType: args.deviceType,
              configuration: {
                memoryMb: args.androidConfig!.memoryMb,
                cpuCores: args.androidConfig!.cpuCores,
              },
            },
          }
        : {
            platform: "ios",
            name: args.target.simulatorName,
            deviceId: args.target.simulatorUdid,
            spec: {
              runtime: args.runtime,
              deviceType: args.deviceType,
            },
          },
    boot: true,
    readiness: "automation",
    timeoutMs: args.timeoutMs,
    enableTools: [...ENABLED_TOOLS],
  };
}

function acquisitionTool(args: AcceptanceArgs): "getAndroid" | "startDevice" {
  return args.platform === "android" ? "getAndroid" : "startDevice";
}

function acquisitionRequest(args: AcceptanceArgs, range: "exact" | "min" | "max"): JsonObject {
  if (args.platform === "android") {
    return { avdName: args.target.avdName, enableTools: [...ENABLED_TOOLS] };
  }
  const request: JsonObject = {
    platform: "ios",
    deviceId: args.target.simulatorUdid,
    preferRunning: true,
  };
  if (range === "min") {
    request.minOsVersion = args.osVersionRange.min;
  }
  if (range === "max") {
    request.maxOsVersion = args.osVersionRange.max;
  }
  return request;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return `hash:${value.length}`;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([key, item]) => [key, redact(item)]),
    );
  }
  return value;
}

function recordStep(
  steps: Step[],
  timer: Timer,
  name: string,
  start: number,
  detail: JsonObject,
  passed = true,
): void {
  steps.push({
    name,
    passed,
    elapsedMs: timer.now() - start,
    detail: redact(detail) as JsonObject,
  });
}

function assertProvisionSchemaMatrix(args: AcceptanceArgs): void {
  const provision = provisionDeviceSchema.safeParse(provisionRequest(args));
  if (!provision.success) {
    throw new Error(`provisionDevice schema rejected harness request: ${provision.error.message}`);
  }
  if (args.platform === "android") {
    const android = getAndroidSchema.safeParse(acquisitionRequest(args, "exact"));
    if (!android.success) {
      throw new Error(`getAndroid schema rejected exact AVD request: ${android.error.message}`);
    }
    return;
  }
  const exact = startDeviceSchema.safeParse(acquisitionRequest(args, "exact"));
  const min = startDeviceSchema.safeParse(acquisitionRequest(args, "min"));
  const max = startDeviceSchema.safeParse(acquisitionRequest(args, "max"));
  if (!exact.success || !min.success || !max.success) {
    throw new Error("startDevice schema rejected an exact, min, or max iOS request");
  }
  if (
    min.data.minOsVersion !== args.osVersionRange.min ||
    max.data.maxOsVersion !== args.osVersionRange.max ||
    exact.data.deviceId !== args.target.simulatorUdid
  ) {
    throw new Error("startDevice schema did not preserve the exact iOS selector and OS bounds");
  }
}

async function defaultSpawnCli(command: string[], timeoutMs: number): Promise<void> {
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode })),
    Bun.sleep(timeoutMs).then(() => ({ timedOut: true })),
  ]);
  if ("timedOut" in outcome) {
    child.kill();
    throw new Error(`CLI timed out after ${timeoutMs}ms`);
  }
  if (outcome.exitCode !== 0) {
    throw new Error(`CLI exited with ${outcome.exitCode}`);
  }
}

async function defaultCreateMcpClient(owner: string): Promise<McpSessionClient> {
  const client = new Client({
    name: `live-device-acceptance-${owner}`,
    version: "1.0.0",
  });
  await client.connect(
    new StdioClientTransport({
      command: "bun",
      args: ["run", "src/index.ts"],
      stderr: "inherit",
    }),
  );
  return {
    callTool: (name, arguments_) => client.callTool({ name, arguments: arguments_ }),
    close: () => client.close(),
  };
}

async function defaultCreateDaemonClient(): Promise<DaemonSessionClient> {
  return new DaemonClient(SOCKET_PATH);
}

async function defaultWriteEvidence(
  path: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  signal.throwIfAborted();
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporaryPath, content);
  signal.throwIfAborted();
  await rename(temporaryPath, path);
}

function assertProvisionedIdentity(payload: JsonObject, args: AcceptanceArgs): void {
  const device = asObject(payload.device, "provisionDevice.device");
  if (stringField(device, "name", "provisionDevice.device") !== targetDeviceName(args)) {
    throw new Error("provisionDevice returned a different named device");
  }
  if (
    args.platform === "ios" &&
    stringField(device, "deviceId", "provisionDevice.device") !== args.target.simulatorUdid
  ) {
    throw new Error("provisionDevice returned a different simulator UDID");
  }
  const resolvedSpec = asObject(payload.resolvedSpec, "provisionDevice.resolvedSpec");
  if (stringField(resolvedSpec, "runtime", "provisionDevice.resolvedSpec") !== args.runtime) {
    throw new Error(
      "provisionDevice resolvedSpec.runtime did not exactly match the requested runtime",
    );
  }
  if (stringField(resolvedSpec, "deviceType", "provisionDevice.resolvedSpec") !== args.deviceType) {
    throw new Error(
      "provisionDevice resolvedSpec.deviceType did not exactly match the requested device type",
    );
  }
  if (args.platform === "android") {
    const configuration = asObject(
      resolvedSpec.configuration,
      "provisionDevice.resolvedSpec.configuration",
    );
    const expected = args.androidConfig!;
    if (
      Object.keys(configuration).length !== Object.keys(expected).length ||
      configuration.memoryMb !== expected.memoryMb ||
      configuration.cpuCores !== expected.cpuCores
    ) {
      throw new Error(
        "provisionDevice resolvedSpec.configuration did not exactly match the requested configuration",
      );
    }
  } else if ("configuration" in resolvedSpec) {
    throw new Error("provisionDevice unexpectedly resolved an iOS configuration");
  }
}

function doctorRepairCommand(): string[] {
  return ["auto-mobile", "--cli", "doctor", "--repair"];
}

function oldSessionDiagnostic(sessionUuid: string): string {
  return (
    `Session ${sessionUuid} is not an active daemon session (not found). ` +
    "Acquire a device with getAndroid or getApple before using its sessionUuid."
  );
}

function unrelatedOwnerDiagnostic(deviceId: string): string {
  return (
    `Device '${deviceId}' is already assigned to another session. ` +
    "Acquire a different device or wait for its owner to release it."
  );
}

function assertAndroidTransitionEvidence(before: AcquiredSession, after: AcquiredSession): void {
  const beforeSerial = before.identity.androidSerial;
  const afterSerial = after.identity.androidSerial;
  if (beforeSerial && afterSerial && beforeSerial === afterSerial) {
    throw new Error(
      `Android serial did not change across the required kill/reacquire transition (${beforeSerial})`,
    );
  }
  const beforePort = before.identity.androidConsolePort;
  const afterPort = after.identity.androidConsolePort;
  if (beforePort !== undefined && afterPort !== undefined && beforePort === afterPort) {
    throw new Error(
      `Android console port did not change across the required kill/reacquire transition (${beforePort})`,
    );
  }
}

function assertLiveSafeguards(args: AcceptanceArgs, dependencies: MatrixDependencies): void {
  if (dependencies.testOnly) {
    return;
  }
  if (
    !args.confirmLive ||
    !args.testOwnedDevices ||
    process.env.AUTOMOBILE_ACCEPTANCE_LIVE !== "1"
  ) {
    throw new Error(
      "Live mutation requires --confirm-live, --test-owned-devices, and AUTOMOBILE_ACCEPTANCE_LIVE=1.",
    );
  }
}

export async function runAcceptanceMatrix(
  args: AcceptanceArgs,
  dependencies: MatrixDependencies = {},
): Promise<Evidence> {
  assertLiveSafeguards(args, dependencies);
  assertProvisionSchemaMatrix(args);
  const timer = dependencies.timer ?? defaultTimer;
  const spawnCli = dependencies.spawnCli ?? defaultSpawnCli;
  const createMcpClient = dependencies.createMcpClient ?? defaultCreateMcpClient;
  const createDaemonClient = dependencies.createDaemonClient ?? defaultCreateDaemonClient;
  const restartDaemon =
    dependencies.restartDaemon ??
    (async (timeoutMs: number) => {
      await defaultSpawnCli(["bun", "run", "src/index.ts", "--daemon", "restart"], timeoutMs);
    });
  const writeEvidence = dependencies.writeFile ?? defaultWriteEvidence;
  const deadline = timer.now() + args.timeoutMs;
  const evidenceReserveMs = Math.min(
    MAX_EVIDENCE_RESERVE_MS,
    Math.max(1, Math.floor(args.timeoutMs / 10)),
  );
  const cleanupReserveMs = Math.min(
    MAX_CLEANUP_RESERVE_MS,
    Math.max(1, Math.floor((args.timeoutMs - evidenceReserveMs) / 4)),
  );
  const workDeadline = deadline - cleanupReserveMs - evidenceReserveMs;
  const cleanupDeadline = deadline - evidenceReserveMs;
  if (workDeadline <= timer.now()) {
    throw new Error("Acceptance timeout is too short to reserve cleanup and evidence time");
  }

  const bounded = async <T>(
    phase: string,
    budget: Budget,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const phaseDeadline =
      budget === "work" ? workDeadline : budget === "cleanup" ? cleanupDeadline : deadline;
    const remaining = phaseDeadline - timer.now();
    if (remaining <= 0) {
      throw new Error(`Acceptance deadline elapsed before ${phase}`);
    }
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = timer.setTimeout(() => {
        const error = new Error(`Acceptance deadline elapsed during ${phase}`);
        controller.abort(error);
        reject(error);
      }, remaining);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => run(controller.signal)), timedOut]);
    } finally {
      if (timeout !== undefined) {
        timer.clearTimeout(timeout);
      }
    }
  };

  const steps: Step[] = [];
  const runtimeIdentities: JsonObject[] = [];
  const acquisitionRequests: JsonObject[] = [];
  const clients: McpSessionClient[] = [];
  const minted: MintedSession[] = [];
  const cleanupFailures: string[] = [];
  let daemonClient: DaemonSessionClient | undefined;
  let primaryError: unknown;

  const mint = (phase: string, sessionUuid: string): void => {
    if (!minted.some((session) => session.sessionUuid === sessionUuid)) {
      minted.push({ phase, sessionUuid, released: false });
    }
  };

  const callTool = async (
    client: McpSessionClient,
    tool: string,
    request: JsonObject,
    phase: string,
    budget: Budget = "work",
  ): Promise<ToolResponse> =>
    await bounded(`${phase} ${tool}`, budget, async () => await client.callTool(tool, request));

  const release = async (
    sessionUuid: string,
    phase: string,
    budget: Budget = "work",
  ): Promise<void> => {
    const session = minted.find((candidate) => candidate.sessionUuid === sessionUuid);
    if (!session || session.released) {
      return;
    }
    daemonClient ??= await bounded(
      `${phase} daemon connect`,
      budget,
      async () => await createDaemonClient(),
    );
    await bounded(
      `${phase} daemon release`,
      budget,
      async () =>
        await daemonClient!.callDaemonMethod("daemon/releaseSession", { sessionId: sessionUuid }),
    );
    session.released = true;
    const start = timer.now();
    recordStep(steps, timer, `release-${phase}`, start, { sessionUuid });
  };

  const verifyReadiness = async (
    client: McpSessionClient,
    sessionUuid: string,
    phase: string,
  ): Promise<void> => {
    const start = timer.now();
    try {
      toolPayload(
        await callTool(client, "observe", { sessionUuid, project: "skeleton" }, phase),
        "observe",
      );
      toolPayload(
        await callTool(client, "getDeviceState", { sessionUuid }, phase),
        "getDeviceState",
      );
      recordStep(steps, timer, `readiness-${phase}`, start, { sessionUuid });
    } catch (error) {
      recordStep(
        steps,
        timer,
        `readiness-${phase}`,
        start,
        { sessionUuid, error: error instanceof Error ? error.message : String(error) },
        false,
      );
      throw error;
    }
  };

  const acquire = async (
    phase: string,
    range: "exact" | "min" | "max",
  ): Promise<AcquiredSession> => {
    const start = timer.now();
    const client = await bounded(
      `${phase} MCP connect`,
      "work",
      async () => await createMcpClient(phase),
    );
    clients.push(client);
    const request = acquisitionRequest(args, range);
    const tool = acquisitionTool(args);
    acquisitionRequests.push({ phase, range, tool, request });
    const payload = toolPayload(await callTool(client, tool, request, phase), tool);
    const sessionUuid = stringField(payload, "sessionUuid", tool);
    mint(phase, sessionUuid);
    await verifyReadiness(client, sessionUuid, phase);
    const { identity, device } = acquiredIdentity(payload, args);
    runtimeIdentities.push({ phase, ...identity });
    recordStep(steps, timer, `acquire-${phase}`, start, {
      sessionUuid,
      range,
      tool,
      identity,
      device,
    });
    return { phase, client, sessionUuid, identity, device };
  };

  const kill = async (session: AcquiredSession, phase: string): Promise<void> => {
    const start = timer.now();
    const request = { device: session.device };
    const parsed = killDeviceSchema.safeParse(request);
    if (!parsed.success) {
      throw new Error(`killDevice schema rejected acquired device: ${parsed.error.message}`);
    }
    toolPayload(await callTool(session.client, "killDevice", request, phase), "killDevice");
    recordStep(steps, timer, `kill-${phase}`, start, {
      sessionUuid: session.sessionUuid,
      device: session.device,
    });
  };

  const repairHost = async (): Promise<void> => {
    const start = timer.now();
    await bounded("host-wide doctor repair", "work", async () => {
      await spawnCli(doctorRepairCommand(), Math.max(1, workDeadline - timer.now()));
    });
    recordStep(steps, timer, "host-wide-doctor-repair", start, {
      platform: args.platform,
      platformFlagScope: "diagnostic-only",
      repairScope: "host-wide",
    });
  };

  const expectUnrelatedOwnerConflict = async (held: AcquiredSession): Promise<void> => {
    const start = timer.now();
    const client = await bounded(
      "unrelated-owner MCP connect",
      "work",
      async () => await createMcpClient("unrelated-owner"),
    );
    clients.push(client);
    const tool = acquisitionTool(args);
    const response = await callTool(
      client,
      tool,
      acquisitionRequest(args, "exact"),
      "unrelated-owner",
    );
    if (!response.isError) {
      const payload = toolPayload(response, tool);
      const accidentalSession = stringField(payload, "sessionUuid", tool);
      mint("unrelated-owner-unexpected", accidentalSession);
      await verifyReadiness(client, accidentalSession, "unrelated-owner-unexpected");
      throw new Error(
        `Unrelated owner unexpectedly acquired ${accidentalSession} while ${held.sessionUuid} was held`,
      );
    }
    const actualDiagnostic = toolDiagnostic(response, tool);
    const expectedDiagnostic = unrelatedOwnerDiagnostic(held.device.deviceId);
    if (actualDiagnostic !== expectedDiagnostic) {
      throw new Error(
        `Unexpected unrelated-owner diagnostic: expected '${expectedDiagnostic}', received '${actualDiagnostic}'`,
      );
    }
    recordStep(steps, timer, "unrelated-owner-conflict", start, {
      heldSessionUuid: held.sessionUuid,
      diagnostic: actualDiagnostic,
    });
  };

  try {
    if (args.platform === "ios") {
      const preflight = await acquire("preflight-ios-uuid-ownership", "exact");
      await release(preflight.sessionUuid, "preflight-ios-uuid-ownership");
    }
    const provisionStart = timer.now();
    const provisionClient = await bounded(
      "provision MCP connect",
      "work",
      async () => await createMcpClient("provision"),
    );
    clients.push(provisionClient);
    const provisionPayload = toolPayload(
      await callTool(provisionClient, "provisionDevice", provisionRequest(args), "provision"),
      "provisionDevice",
    );
    const provisionSessionUuid = stringField(provisionPayload, "sessionUuid", "provisionDevice");
    mint("provision", provisionSessionUuid);
    await verifyReadiness(provisionClient, provisionSessionUuid, "provision");
    assertProvisionedIdentity(provisionPayload, args);
    await release(provisionSessionUuid, "provision");
    recordStep(steps, timer, "provision-exact-runtime-device-type-config", provisionStart, {
      sessionUuid: provisionSessionUuid,
      resolvedSpec: asObject(provisionPayload.resolvedSpec, "provisionDevice.resolvedSpec"),
    });

    const prepared = await acquire("prepare-stopped", "exact");
    await kill(prepared, "prepare-stopped");
    await release(prepared.sessionUuid, "prepare-stopped");

    const stopped = await acquire("acquire-stopped", args.platform === "ios" ? "min" : "exact");
    assertAndroidTransitionEvidence(prepared, stopped);
    await release(stopped.sessionUuid, "acquire-stopped");

    const running = await acquire("acquire-running", args.platform === "ios" ? "max" : "exact");
    await expectUnrelatedOwnerConflict(running);

    const cliStart = timer.now();
    await bounded("short-lived CLI", "work", async () => {
      await spawnCli(
        [
          "bun",
          "run",
          "src/index.ts",
          "--cli",
          "--session-uuid",
          running.sessionUuid,
          "getDeviceState",
        ],
        Math.max(1, workDeadline - timer.now()),
      );
    });
    recordStep(steps, timer, "short-lived-cli", cliStart, { sessionUuid: running.sessionUuid });

    const independentStart = timer.now();
    const independent = await bounded(
      "independent MCP connect",
      "work",
      async () => await createMcpClient("independent-mcp"),
    );
    clients.push(independent);
    toolPayload(
      await callTool(
        independent,
        "getDeviceState",
        { sessionUuid: running.sessionUuid },
        "independent-mcp",
      ),
      "getDeviceState",
    );
    recordStep(steps, timer, "independent-mcp-client", independentStart, {
      sessionUuid: running.sessionUuid,
    });

    if (args.scenario === "recovery") {
      const restartStart = timer.now();
      await bounded("daemon restart", "work", async () => {
        await restartDaemon(Math.max(1, workDeadline - timer.now()));
      });
      recordStep(steps, timer, "daemon-restart", restartStart, {});

      const oldSessionStart = timer.now();
      const oldSessionClient = await bounded(
        "old-session MCP connect",
        "work",
        async () => await createMcpClient("old-session"),
      );
      clients.push(oldSessionClient);
      const oldSession = await callTool(
        oldSessionClient,
        "getDeviceState",
        { sessionUuid: running.sessionUuid },
        "old-session",
      );
      const expectedDiagnostic = oldSessionDiagnostic(running.sessionUuid);
      if (
        !oldSession.isError ||
        toolDiagnostic(oldSession, "getDeviceState") !== expectedDiagnostic
      ) {
        throw new Error(
          `Old session did not return the required terminal diagnostic: '${expectedDiagnostic}'`,
        );
      }
      recordStep(steps, timer, "old-session-rejected", oldSessionStart, {
        sessionUuid: running.sessionUuid,
        diagnostic: expectedDiagnostic,
      });
    }

    await release(running.sessionUuid, "acquire-running");
    await repairHost();
    const repaired = await acquire("reacquire-after-repair", "exact");
    await release(repaired.sessionUuid, "reacquire-after-repair");
  } catch (error) {
    primaryError = error;
  } finally {
    for (const session of minted.filter((candidate) => !candidate.released)) {
      try {
        await release(session.sessionUuid, `cleanup-${session.phase}`, "cleanup");
      } catch (error) {
        cleanupFailures.push(
          `release ${session.sessionUuid}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (daemonClient) {
      try {
        await bounded("daemon close", "cleanup", async () => await daemonClient!.close());
      } catch (error) {
        cleanupFailures.push(
          `daemon close: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const client of [...clients].reverse()) {
      try {
        await bounded("MCP client close", "cleanup", async () => await client.close());
      } catch (error) {
        cleanupFailures.push(
          `MCP client close: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const androidEndpoints = runtimeIdentities
    .map((identity) => identity.androidConsoleEndpoint)
    .filter((value): value is string => typeof value === "string");
  const androidSerials = runtimeIdentities
    .map((identity) => identity.androidSerial)
    .filter((value): value is string => typeof value === "string");
  const androidConsolePorts = runtimeIdentities
    .map((identity) => identity.androidConsolePort)
    .filter((value): value is number => typeof value === "number");
  const allMintedSessionsReleased = minted.every((session) => session.released);
  const readinessSteps = steps.filter((step) => step.name.startsWith("readiness-"));
  const readinessObserveThenState =
    readinessSteps.length > 0 && readinessSteps.every((step) => step.passed);
  const outcomeError =
    primaryError instanceof Error
      ? primaryError.message
      : primaryError === undefined
        ? undefined
        : String(primaryError);
  const evidence: Evidence = {
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    scenario: args.scenario,
    platform: args.platform,
    target: redact({
      stableIdentity: targetIdentity(args),
      namedDevice: targetDeviceName(args),
    }) as JsonObject,
    provision: redact(provisionRequest(args)) as JsonObject,
    acquisitionRequests: redact(acquisitionRequests) as JsonObject[],
    runtimeIdentities: redact(runtimeIdentities) as JsonObject[],
    checks: {
      stableIdentityPreserved: runtimeIdentities.every(
        (identity) => identity.stableIdentity === targetIdentity(args),
      ),
      readinessObserveThenState,
      allMintedSessionsReleased,
      androidSerialExposed: args.platform === "android" && androidSerials.length > 0,
      androidSerialChanged:
        args.platform === "android" &&
        androidSerials.length > 1 &&
        new Set(androidSerials).size > 1,
      androidEndpointExposed: args.platform === "android" && androidEndpoints.length > 0,
      androidEndpointChanged:
        args.platform === "android" &&
        androidEndpoints.length > 1 &&
        new Set(androidEndpoints).size > 1,
      androidConsolePortExposed: args.platform === "android" && androidConsolePorts.length > 0,
      androidConsolePortChanged:
        args.platform === "android" &&
        androidConsolePorts.length > 1 &&
        new Set(androidConsolePorts).size > 1,
      iosServiceEndpointExposed: false,
      iosServiceEndpointChanged: false,
    },
    cleanup: {
      mintedSessionCount: minted.length,
      releasedSessionCount: minted.filter((session) => session.released).length,
      failures: redact(cleanupFailures),
    },
    outcome: {
      passed: primaryError === undefined && cleanupFailures.length === 0,
      ...(outcomeError === undefined ? {} : { error: redact(outcomeError) }),
    },
    steps,
  };

  let evidenceError: unknown;
  try {
    await bounded("evidence write", "evidence", async (signal) => {
      await writeEvidence(
        resolve(args.evidencePath),
        `${JSON.stringify(evidence, null, 2)}\n`,
        signal,
      );
    });
  } catch (error) {
    evidenceError = error;
  }
  if (primaryError) {
    throw primaryError;
  }
  if (cleanupFailures.length > 0) {
    throw new Error(`Acceptance cleanup failed: ${cleanupFailures.join("; ")}`);
  }
  if (evidenceError) {
    throw evidenceError;
  }
  return evidence;
}

export function evidenceFileName(args: AcceptanceArgs): string {
  return basename(args.evidencePath);
}

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    const evidence = await runAcceptanceMatrix(args);
    console.log(
      `Live-device acceptance passed (${evidence.platform}/${evidence.scenario}); evidence=${evidenceFileName(args)}`,
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
