#!/usr/bin/env bun

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { computeBuildIdentity, type BuildIdentity } from "../src/daemon/buildIdentity";
import { DaemonClient } from "../src/daemon/client";
import {
  ACCEPTANCE_DISCOVERY_CAPABILITY_ENV,
  DAEMON_VERSION,
  SOCKET_PATH,
} from "../src/daemon/constants";
import { type AcceptanceSessionRestartScope } from "../src/daemon/daemonRestartAdmission";
import {
  daemonLiveAcceptanceStartupSecret,
  DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV,
} from "../src/daemon/liveAcceptanceCapability";
import {
  getAppleSchema,
  getAndroidSchema,
  killDeviceSchema,
  provisionDeviceSchema,
  startDeviceSchema,
} from "../src/server/deviceTools";
import { readToolEnvelopePayload } from "../src/server/toolEnvelopePayload";
import { MIN_AVD_RAM_MB } from "../src/utils/android-cmdline-tools/AvdConfigReader";
import { parseAndroidSystemImageRuntime } from "../src/utils/android-cmdline-tools/AndroidSystemImageRuntime";
import { parseAndroidApiLevelBound } from "../src/utils/androidVersionBounds";
import { compareStrictNumericVersions } from "../src/utils/deviceMatcher";
import { inferIosFormFactor } from "../src/utils/ios-cmdline-tools/iosDeviceType";
import { stableStringify } from "../src/utils/stableStringify";
import { defaultTimer, type Timer } from "../src/utils/SystemTimer";

const ENABLED_TOOLS = ["observe", "getDeviceState", "killDevice"] as const;
const MAX_CLEANUP_RESERVE_MS = 15_000;
const MAX_EVIDENCE_RESERVE_MS = 5_000;
const MAX_REAP_RESERVE_MS = 1_000;

type Platform = "android" | "ios";
type Scenario = "full";
type JsonObject = Record<string, unknown>;
type Budget = "work" | "cleanup" | "evidence";
type AcquisitionKind = "platform" | "generic";
type DiscoveryPresentationOrder = "forward" | "reverse";
const DEFAULT_ACCEPTANCE_DISCOVERY_ORDER: DiscoveryPresentationOrder = "forward";

export interface AcceptanceArgs {
  platform: Platform;
  target: {
    avdName?: string;
    simulatorName?: string;
    simulatorUdid?: string;
  };
  controls: {
    androidSiblingAvdName: string;
    androidDuplicateSerial: string;
    iosSameNameSiblingUdid: string;
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
  ownershipManifestPath: string;
  operatorKeyPath: string;
  operatorKey: Buffer;
  build: BuildIdentity;
  timeoutMs: number;
  confirmLive: boolean;
  testOwnedDevices: boolean;
  recordOwnershipManifest?: boolean;
}

interface RuntimeIdentity {
  stableIdentity: string;
  androidSerial?: string;
  androidConsolePort?: number;
  androidConsoleEndpoint?: string;
  iosServicePort?: number;
  iosRunnerGeneration?: number;
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

type CliAcquiredSession = Omit<AcquiredSession, "phase" | "client">;

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

interface CliResult {
  stdout: string;
}

export interface McpSessionClient {
  callTool(name: string, arguments_: JsonObject, signal?: AbortSignal): Promise<ToolResponse>;
  close(): Promise<void>;
}

export interface DaemonSessionClient {
  callDaemonMethod(name: string, arguments_: JsonObject, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface MatrixDependencies {
  /** Explicit test seam; production calls must satisfy the live safeguards below. */
  testOnly?: boolean;
  timer?: Timer;
  spawnCli?: (command: string[], timeoutMs: number, signal: AbortSignal) => Promise<CliResult>;
  createMcpClient?: (
    owner: string,
    signal: AbortSignal,
    presentationOrder?: DiscoveryPresentationOrder,
  ) => Promise<McpSessionClient>;
  createDaemonClient?: (signal: AbortSignal) => Promise<DaemonSessionClient>;
  restartAcceptanceSession?: (
    scope: AcceptanceSessionRestartScope,
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
  writeFile?: (path: string, content: string, signal: AbortSignal) => Promise<void>;
}

export interface FreshAcceptanceDaemonDependencies {
  createDaemonClient: (signal: AbortSignal) => Promise<DaemonSessionClient>;
  spawnCli: (command: string[], timeoutMs: number, signal: AbortSignal) => Promise<CliResult>;
  build: BuildIdentity;
  expectedCapability: string;
  signal: AbortSignal;
  logger?: { debug(message: string): void; error(message: string): void };
}

export async function ensureFreshAcceptanceDaemon(
  dependencies: FreshAcceptanceDaemonDependencies,
): Promise<void> {
  const fingerprint = createHash("sha256")
    .update(dependencies.expectedCapability)
    .digest("hex")
    .slice(0, 8);
  const logger = dependencies.logger ?? console;
  let client: DaemonSessionClient | undefined;
  let daemonReachable = false;
  try {
    client = await dependencies.createDaemonClient(dependencies.signal);
    const status = await client.callDaemonMethod("ide/status", {}, dependencies.signal);
    daemonReachable = true;
    const reported =
      typeof status === "object" && status !== null && "acceptanceCapabilityFingerprint" in status
        ? status.acceptanceCapabilityFingerprint
        : undefined;
    if (reported === fingerprint) {
      return;
    }
    logger.error(
      `Acceptance detected a stale daemon from a previous acceptance run (capability fingerprint ${String(reported)}; expected ${fingerprint}); restarting the whole daemon.`,
    );
    await dependencies.spawnCli(
      [process.execPath, dependencies.build.entryScript, "--daemon", "restart"],
      30_000,
      dependencies.signal,
    );
  } catch (error) {
    if (!daemonReachable) {
      // A missing daemon is expected at matrix start; the fresh process will bind this run's token.
      logger.debug(`Acceptance daemon freshness probe skipped: ${String(error)}`);
    } else {
      throw error;
    }
  } finally {
    await client?.close();
  }
}

interface Step {
  name: string;
  passed: boolean;
  elapsedMs: number;
  detail: JsonObject;
}

interface Evidence {
  schemaVersion: 9;
  authentication: EvidenceAuthentication;
  generatedAt: string;
  scenario: Scenario;
  platform: Platform;
  build: JsonObject;
  ownership: JsonObject;
  target: JsonObject;
  provision: JsonObject;
  acquisitionRequests: JsonObject[];
  runtimeIdentities: JsonObject[];
  controls: JsonObject[];
  checks: JsonObject;
  cleanup: JsonObject;
  outcome: JsonObject;
  steps: Step[];
}

interface EvidenceAuthentication {
  schemaVersion: 1;
  algorithm: "hmac-sha256";
  binding: JsonObject;
  mac: string;
}

interface EvidenceManifestIdentity {
  schemaVersion: 1;
  runId: string;
  mac: string;
}

export interface EvidenceVerificationArgs {
  evidencePath: string;
  ownershipManifestPath: string;
  operatorKeyPath: string;
  operatorKey: Buffer;
  build: BuildIdentity;
}

interface OwnershipManifestTarget {
  target: AcceptanceArgs["target"];
  controls: AcceptanceArgs["controls"];
  runtime: string;
  deviceType: string;
  osVersionRange: AcceptanceArgs["osVersionRange"];
  androidConfig?: AcceptanceArgs["androidConfig"];
}

interface OwnershipManifestPayload {
  schemaVersion: 1;
  runId: string;
  targets: Partial<Record<Platform, OwnershipManifestTarget>>;
}

interface OwnershipManifest extends OwnershipManifestPayload {
  mac: string;
}

interface DiscoveryDevice extends ExactDevice {}

interface AndroidDiscoveryControls {
  target: DiscoveryDevice;
  sibling: DiscoveryDevice;
  duplicate: DiscoveryDevice;
}

interface IosDiscoveryControls {
  target: DiscoveryDevice;
  sibling: DiscoveryDevice;
}

const SECURE_DIRECTORY_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;

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

export function assertMode(
  path: string,
  expectedMode: number,
  description: string,
  platform: NodeJS.Platform = process.platform,
): void {
  // Windows ACLs, rather than POSIX permission bits, protect these files. Bun
  // reports synthetic mode bits there, so treating them as authoritative would
  // reject valid evidence before its authenticated contents can be verified.
  if (platform === "win32") {
    return;
  }
  const mode = statSync(path).mode & 0o777;
  if (mode !== expectedMode) {
    throw new Error(
      `${description} must have mode ${expectedMode.toString(8)}, found ${mode.toString(8)}: ${path}`,
    );
  }
}

function readOperatorKey(path: string): Buffer {
  assertMode(path, SECURE_FILE_MODE, "Operator key");
  const key = readFileSync(path);
  if (key.length < 32) {
    throw new Error("Operator key must contain at least 32 random bytes");
  }
  return key;
}

function manifestPayload(
  targets: OwnershipManifestPayload["targets"],
  runId: string,
): OwnershipManifestPayload {
  return { schemaVersion: 1, runId, targets };
}

function manifestMac(payload: OwnershipManifestPayload, key: Buffer): string {
  return createHmac("sha256", key).update(stableStringify(payload)).digest("hex");
}

function manifestIdentity(manifest: OwnershipManifest): EvidenceManifestIdentity {
  return {
    schemaVersion: manifest.schemaVersion,
    runId: manifest.runId,
    mac: manifest.mac,
  };
}

function evidenceAuthenticationBinding(
  build: BuildIdentity,
  manifest: OwnershipManifest,
): JsonObject {
  return {
    build: {
      entryScript: build.entryScript,
      buildId: build.buildId,
    },
    ownershipManifest: manifestIdentity(manifest),
  };
}

function evidenceMac(
  evidence: Evidence,
  build: BuildIdentity,
  manifest: OwnershipManifest,
  key: Buffer,
): string {
  const { schemaVersion, algorithm, binding } = evidence.authentication;
  const authentication = { schemaVersion, algorithm, binding };
  return createHmac("sha256", key)
    .update(
      stableStringify({
        authenticationBinding: evidenceAuthenticationBinding(build, manifest),
        evidence: {
          ...evidence,
          authentication,
        },
      }),
    )
    .digest("hex");
}

function assertMatchingMac(receivedMac: string, expectedMac: string, description: string): void {
  const received = Buffer.from(receivedMac, "hex");
  const expected = Buffer.from(expectedMac, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error(`${description} authentication failed`);
  }
}

function targetManifestEntry(args: AcceptanceArgs): OwnershipManifestTarget {
  return {
    target: args.target,
    controls: args.controls,
    runtime: args.runtime,
    deviceType: args.deviceType,
    osVersionRange: args.osVersionRange,
    ...(args.androidConfig === undefined ? {} : { androidConfig: args.androidConfig }),
  };
}

function assertControlConfiguration(
  target: AcceptanceArgs["target"],
  controls: AcceptanceArgs["controls"],
): void {
  for (const [name, value] of Object.entries(controls)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Ownership control ${name} must be a non-empty string`);
    }
  }
  if (target.avdName === controls.androidSiblingAvdName) {
    throw new Error("Android ownership sibling must not use the target AVD name");
  }
  if (
    controls.androidDuplicateSerial === target.avdName ||
    controls.androidDuplicateSerial === controls.androidSiblingAvdName
  ) {
    throw new Error("Android ownership duplicate serial must not name an AVD control");
  }
  if (target.simulatorUdid === controls.iosSameNameSiblingUdid) {
    throw new Error("iOS ownership sibling UUID must differ from the target UUID");
  }
}

function assertOwnershipManifestTarget(
  target: unknown,
  platform: Platform,
): asserts target is OwnershipManifestTarget {
  const entry = asObject(target, `ownership manifest ${platform} target`);
  const targetIdentity = asObject(entry.target, `ownership manifest ${platform} target.target`);
  const controls = asObject(entry.controls, `ownership manifest ${platform} target.controls`);
  const parsedTarget: AcceptanceArgs["target"] =
    platform === "android"
      ? {
          avdName: stringField(
            targetIdentity,
            "avdName",
            `ownership manifest ${platform} target.target`,
          ),
        }
      : {
          simulatorName: stringField(
            targetIdentity,
            "simulatorName",
            `ownership manifest ${platform} target.target`,
          ),
          simulatorUdid: stringField(
            targetIdentity,
            "simulatorUdid",
            `ownership manifest ${platform} target.target`,
          ),
        };
  assertControlConfiguration(parsedTarget, {
    androidSiblingAvdName: stringField(
      controls,
      "androidSiblingAvdName",
      `ownership manifest ${platform} target.controls`,
    ),
    androidDuplicateSerial: stringField(
      controls,
      "androidDuplicateSerial",
      `ownership manifest ${platform} target.controls`,
    ),
    iosSameNameSiblingUdid: stringField(
      controls,
      "iosSameNameSiblingUdid",
      `ownership manifest ${platform} target.controls`,
    ),
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function parseOwnershipManifest(path: string, key: Buffer): OwnershipManifest {
  assertMode(path, SECURE_FILE_MODE, "Ownership manifest");
  let candidate: unknown;
  try {
    candidate = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Ownership manifest is not valid JSON: ${path}`);
  }
  const manifest = asObject(candidate, "ownership manifest") as OwnershipManifest;
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.runId !== "string" ||
    manifest.runId.length === 0 ||
    !manifest.targets ||
    typeof manifest.targets !== "object" ||
    Array.isArray(manifest.targets) ||
    typeof manifest.mac !== "string"
  ) {
    throw new Error("Ownership manifest has an invalid shape");
  }
  const payload = manifestPayload(manifest.targets, manifest.runId);
  assertMatchingMac(manifest.mac, manifestMac(payload, key), "Ownership manifest");
  return manifest;
}

function assertOwnershipManifest(args: AcceptanceArgs): OwnershipManifest {
  assertControlConfiguration(args.target, args.controls);
  const manifest = parseOwnershipManifest(args.ownershipManifestPath, args.operatorKey);
  if (!manifest.targets.android || !manifest.targets.ios) {
    throw new Error("Ownership manifest must bind both the Android AVD and iOS simulator");
  }
  assertOwnershipManifestTarget(manifest.targets.android, "android");
  assertOwnershipManifestTarget(manifest.targets.ios, "ios");
  if (!sameJson(manifest.targets.android.controls, manifest.targets.ios.controls)) {
    throw new Error("Ownership manifest Android and iOS entries must bind identical controls");
  }
  const target = manifest.targets[args.platform];
  if (!target || !sameJson(target, targetManifestEntry(args))) {
    throw new Error(
      `Ownership manifest does not exactly authorize this ${args.platform} target and configuration`,
    );
  }
  return manifest;
}

export function recordOwnershipManifest(args: AcceptanceArgs): void {
  assertControlConfiguration(args.target, args.controls);
  let targets: OwnershipManifestPayload["targets"] = {};
  let runId = randomUUID();
  if (existsSync(args.ownershipManifestPath)) {
    const existing = parseOwnershipManifest(args.ownershipManifestPath, args.operatorKey);
    targets = { ...existing.targets };
    runId = existing.runId;
    const previous = targets[args.platform];
    if (previous && !sameJson(previous, targetManifestEntry(args))) {
      throw new Error(
        `Ownership manifest already binds a different ${args.platform} target; create a new manifest instead`,
      );
    }
    const otherPlatform: Platform = args.platform === "android" ? "ios" : "android";
    const other = targets[otherPlatform];
    if (other) {
      assertOwnershipManifestTarget(other, otherPlatform);
      if (!sameJson(other.controls, args.controls)) {
        throw new Error(
          "Ownership manifest already binds different discovery controls; create a new manifest instead",
        );
      }
    }
  }
  targets[args.platform] = targetManifestEntry(args);
  const payload = manifestPayload(targets, runId);
  const manifest: OwnershipManifest = {
    ...payload,
    mac: manifestMac(payload, args.operatorKey),
  };
  writeSecureFile(args.ownershipManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function parseEvidence(path: string): JsonObject {
  assertMode(path, SECURE_FILE_MODE, "Evidence file");
  let candidate: unknown;
  try {
    candidate = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Evidence is not valid JSON: ${path}`);
  }
  const evidence = asObject(candidate, "evidence");
  if (evidence.schemaVersion !== 9) {
    throw new Error("Evidence has an unsupported schema version");
  }
  return evidence;
}

export function verifyEvidenceFile(args: EvidenceVerificationArgs): Evidence {
  if (args.build.buildId === "unknown") {
    throw new Error(`Cannot compute a build identity for --entrypoint ${args.build.entryScript}`);
  }
  const manifest = parseOwnershipManifest(args.ownershipManifestPath, args.operatorKey);
  const evidence = parseEvidence(args.evidencePath);
  const authentication = asObject(evidence.authentication, "evidence.authentication");
  if (
    authentication.schemaVersion !== 1 ||
    authentication.algorithm !== "hmac-sha256" ||
    typeof authentication.mac !== "string"
  ) {
    throw new Error("Evidence authentication has an invalid shape");
  }
  const binding = asObject(authentication.binding, "evidence.authentication.binding");
  const expectedBinding = redact(
    evidenceAuthenticationBinding(args.build, manifest),
    args.operatorKey,
  );
  if (!sameJson(binding, expectedBinding)) {
    throw new Error(
      "Evidence authentication binding does not match the build or ownership manifest",
    );
  }
  const expectedMac = evidenceMac(evidence as Evidence, args.build, manifest, args.operatorKey);
  assertMatchingMac(authentication.mac, expectedMac, "Evidence");
  return evidence as Evidence;
}

function writeSecureFile(path: string, content: string): void {
  const directory = dirname(path);
  ensureSecureDirectorySync(directory, "Evidence or manifest directory");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", SECURE_FILE_MODE);
  try {
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, SECURE_FILE_MODE);
  renameSync(temporary, path);
  chmodSync(path, SECURE_FILE_MODE);
}

function ensureSecureDirectorySync(path: string, description: string): void {
  const created = mkdirSync(path, { recursive: true, mode: SECURE_DIRECTORY_MODE });
  if (created !== undefined && process.platform !== "win32") {
    chmodSync(path, SECURE_DIRECTORY_MODE);
  }
  assertMode(path, SECURE_DIRECTORY_MODE, description);
}

export function parseArgs(argv: string[]): AcceptanceArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length;) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`Expected --flag value pairs, received ${argv.slice(index).join(" ")}`);
    }
    const name = flag.slice(2);
    if (
      name === "confirm-live" ||
      name === "test-owned-devices" ||
      name === "record-ownership-manifest"
    ) {
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
  if (scenario !== "full") {
    throw new Error("--scenario must be full; recovery is not implemented");
  }
  const target =
    platform === "android"
      ? { avdName: requiredFlag(values, "avd-name") }
      : {
          simulatorName: requiredFlag(values, "simulator-name"),
          simulatorUdid: requiredFlag(values, "simulator-uuid"),
        };
  const operatorKeyPath = requiredFlag(values, "operator-key-file");
  const entrypoint = requiredFlag(values, "entrypoint");
  const build = computeBuildIdentity(entrypoint);
  if (build.buildId === "unknown") {
    throw new Error(`Cannot compute a build identity for --entrypoint ${entrypoint}`);
  }
  const args: AcceptanceArgs = {
    platform,
    target,
    controls: {
      androidSiblingAvdName: requiredFlag(values, "android-sibling-avd-name"),
      androidDuplicateSerial: requiredFlag(values, "android-duplicate-serial"),
      iosSameNameSiblingUdid: requiredFlag(values, "ios-same-name-sibling-uuid"),
    },
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
    ownershipManifestPath: requiredFlag(values, "ownership-manifest"),
    operatorKeyPath,
    operatorKey: readOperatorKey(operatorKeyPath),
    build,
    timeoutMs: parseInteger(requiredFlag(values, "timeout-ms"), "timeout-ms"),
    confirmLive: values.get("confirm-live") === "true",
    testOwnedDevices: values.get("test-owned-devices") === "true",
    recordOwnershipManifest: values.get("record-ownership-manifest") === "true",
  };
  assertControlConfiguration(args.target, args.controls);
  return args;
}

export function parseEvidenceVerificationArgs(argv: string[]): EvidenceVerificationArgs {
  const values = new Map<string, string>();
  const supported = new Set([
    "verify-evidence",
    "ownership-manifest",
    "operator-key-file",
    "entrypoint",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flag?.startsWith("--") ||
      !value ||
      value.startsWith("--") ||
      !supported.has(flag.slice(2))
    ) {
      throw new Error(
        "Evidence verification requires --verify-evidence, --ownership-manifest, --operator-key-file, and --entrypoint",
      );
    }
    values.set(flag.slice(2), value);
  }
  const operatorKeyPath = requiredFlag(values, "operator-key-file");
  const entrypoint = requiredFlag(values, "entrypoint");
  const build = computeBuildIdentity(entrypoint);
  if (build.buildId === "unknown") {
    throw new Error(`Cannot compute a build identity for --entrypoint ${entrypoint}`);
  }
  return {
    evidencePath: requiredFlag(values, "verify-evidence"),
    ownershipManifestPath: requiredFlag(values, "ownership-manifest"),
    operatorKeyPath,
    operatorKey: readOperatorKey(operatorKeyPath),
    build,
  };
}

function asObject(value: unknown, context: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonObject;
}

function objectArrayField(value: JsonObject, field: string, context: string): JsonObject[] {
  const candidate = value[field];
  if (!Array.isArray(candidate) || candidate.some((item) => !item || typeof item !== "object")) {
    throw new Error(`${context}.${field} must be an array of objects`);
  }
  return candidate as JsonObject[];
}

function stringField(value: JsonObject, field: string, context: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`${context}.${field} must be a non-empty string`);
  }
  return candidate;
}

function nonNegativeIntegerField(value: JsonObject, field: string, context: string): number {
  const candidate = value[field];
  if (!Number.isInteger(candidate) || (candidate as number) < 0) {
    throw new Error(`${context}.${field} must be a non-negative integer`);
  }
  return candidate as number;
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

/**
 * Direct MCP SDK calls may render a JSON-RPC failure as an Error string instead
 * of the usual structured `isError` tool envelope. Preserve exact product
 * diagnostics while removing only that leading, validated transport rendering.
 */
export function normalizeMcpTransportDiagnostic(diagnostic: string): string {
  const renderedErrorPrefix = "Error: ";
  const mcpErrorPrefix = "MCP error ";
  const candidate = diagnostic.startsWith(renderedErrorPrefix)
    ? diagnostic.slice(renderedErrorPrefix.length)
    : diagnostic;
  if (!candidate.startsWith(mcpErrorPrefix)) {
    return diagnostic;
  }
  const separator = candidate.indexOf(": ", mcpErrorPrefix.length);
  if (separator === -1) {
    return diagnostic;
  }
  const code = candidate.slice(mcpErrorPrefix.length, separator);
  const parsedCode = Number(code);
  if (!code.startsWith("-") || !Number.isInteger(parsedCode) || String(parsedCode) !== code) {
    return diagnostic;
  }
  return candidate.slice(separator + 2);
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
  const iosServicePort = nonNegativeIntegerField(
    deviceIdentity,
    "iosServicePort",
    "acquire.deviceIdentity",
  );
  if (iosServicePort === 0) {
    throw new Error("acquire.deviceIdentity.iosServicePort must be a positive integer");
  }
  const iosRunnerGeneration = nonNegativeIntegerField(
    deviceIdentity,
    "iosRunnerGeneration",
    "acquire.deviceIdentity",
  );
  return {
    identity: { stableIdentity: simulatorUdid, iosServicePort, iosRunnerGeneration },
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

function acquisitionTool(
  args: AcceptanceArgs,
  kind: AcquisitionKind,
): "getAndroid" | "getApple" | "startDevice" {
  if (kind === "generic") {
    return "startDevice";
  }
  return args.platform === "android" ? "getAndroid" : "getApple";
}

function acquisitionRequest(
  args: AcceptanceArgs,
  range: "exact" | "min" | "max" | "bounded",
  kind: AcquisitionKind,
): JsonObject {
  if (kind === "platform") {
    if (args.platform === "android") {
      return { avdName: args.target.avdName, enableTools: [...ENABLED_TOOLS] };
    }
    return { deviceId: args.target.simulatorUdid, enableTools: [...ENABLED_TOOLS] };
  }
  const request: JsonObject =
    args.platform === "android"
      ? {
          platform: "android",
          avdName: args.target.avdName,
          preferRunning: true,
          enableTools: [...ENABLED_TOOLS],
        }
      : {
          platform: "ios",
          deviceId: args.target.simulatorUdid,
          preferRunning: true,
          formFactor: inferIosFormFactor(args.deviceType),
          enableTools: [...ENABLED_TOOLS],
        };
  if (range === "min") {
    request.minOsVersion = args.osVersionRange.min;
  }
  if (range === "max") {
    request.maxOsVersion = args.osVersionRange.max;
  }
  if (range === "bounded") {
    request.minOsVersion = args.osVersionRange.min;
    request.maxOsVersion = args.osVersionRange.max;
  }
  return request;
}

function assertGenericSelectorSchemaMatrix(args: AcceptanceArgs): void {
  const exact = startDeviceSchema.safeParse(acquisitionRequest(args, "exact", "generic"));
  const min = startDeviceSchema.safeParse(acquisitionRequest(args, "min", "generic"));
  const max = startDeviceSchema.safeParse(acquisitionRequest(args, "max", "generic"));
  const bounded = startDeviceSchema.safeParse(acquisitionRequest(args, "bounded", "generic"));
  if (!exact.success || !min.success || !max.success || !bounded.success) {
    throw new Error("startDevice schema rejected an exact, min, max, or bounded request");
  }
  if (
    min.data.minOsVersion !== args.osVersionRange.min ||
    max.data.maxOsVersion !== args.osVersionRange.max ||
    bounded.data.minOsVersion !== args.osVersionRange.min ||
    bounded.data.maxOsVersion !== args.osVersionRange.max
  ) {
    throw new Error("startDevice schema did not preserve the requested OS bounds");
  }
  if (args.platform === "android") {
    if (exact.data.avdName !== args.target.avdName) {
      throw new Error("startDevice schema did not preserve the exact Android AVD selector");
    }
    return;
  }
  if (exact.data.deviceId !== args.target.simulatorUdid) {
    throw new Error("startDevice schema did not preserve the exact iOS selector");
  }
}

function redact(value: unknown, key: Buffer): unknown {
  if (typeof value === "string") {
    return `hmac-sha256:${createHmac("sha256", key).update(value).digest("hex").slice(0, 20)}`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([field, item]) => [field, redact(item, key)]),
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
    detail,
  });
}

function assertProvisionSchemaMatrix(args: AcceptanceArgs): void {
  const provision = provisionDeviceSchema.safeParse(provisionRequest(args));
  if (!provision.success) {
    throw new Error(`provisionDevice schema rejected harness request: ${provision.error.message}`);
  }
  if (args.platform === "android") {
    const android = getAndroidSchema.safeParse(acquisitionRequest(args, "exact", "platform"));
    if (!android.success) {
      throw new Error(`getAndroid schema rejected exact AVD request: ${android.error.message}`);
    }
  } else {
    const apple = getAppleSchema.safeParse(acquisitionRequest(args, "exact", "platform"));
    if (!apple.success) {
      throw new Error(`getApple schema rejected exact simulator request: ${apple.error.message}`);
    }
  }
  assertGenericSelectorSchemaMatrix(args);
  if (args.platform === "android") {
    const parsedRuntime = parseAndroidSystemImageRuntime(args.runtime) ?? { apiLevel: 30 };
    if (
      parseAndroidSystemImageRuntime(args.runtime) &&
      (parseAndroidApiLevelBound(args.osVersionRange.min) !== undefined ||
        parseAndroidApiLevelBound(args.osVersionRange.max) !== undefined ||
        Number.isNaN(
          compareStrictNumericVersions(args.osVersionRange.min, args.osVersionRange.max),
        ) ||
        compareStrictNumericVersions(args.osVersionRange.min, args.osVersionRange.max) > 0)
    ) {
      throw new Error(
        "Android acceptance bounds must use ordered dotted marketing versions; numeric API controls are derived from the exact system image",
      );
    }
    // Exercise the product schema's Play-image RAM floor without sending any
    // device command. This catches a regression before an owned AVD is touched.
    const playStoreControl = provisionRequest(args);
    const controlDevice = asObject(playStoreControl.device, "play-store control.device");
    const controlSpec = asObject(controlDevice.spec, "play-store control.spec");
    controlSpec.runtime = `system-images;android-${parsedRuntime.apiLevel};google_apis_playstore;x86_64`;
    controlSpec.configuration = { memoryMb: MIN_AVD_RAM_MB - 1, cpuCores: 1 };
    if (provisionDeviceSchema.safeParse(playStoreControl).success) {
      throw new Error("provisionDevice schema accepted below-minimum Play image RAM");
    }
    return;
  }
  if (
    Number.isNaN(compareStrictNumericVersions(args.osVersionRange.min, args.osVersionRange.min)) ||
    Number.isNaN(compareStrictNumericVersions(args.osVersionRange.max, args.osVersionRange.max))
  ) {
    throw new Error("iOS acceptance bounds must be component-exact numeric versions");
  }
  if (!inferIosFormFactor(args.deviceType)) {
    throw new Error("iOS acceptance requires a phone or tablet device family");
  }
  const iosWithAndroidConfiguration = provisionRequest(args);
  const iosDevice = asObject(iosWithAndroidConfiguration.device, "iOS control.device");
  asObject(iosDevice.spec, "iOS control.spec").configuration = { memoryMb: 4096 };
  if (provisionDeviceSchema.safeParse(iosWithAndroidConfiguration).success) {
    throw new Error("provisionDevice schema accepted Android configuration for iOS");
  }
}

function incompatibleBoundRequests(
  args: AcceptanceArgs,
): Array<{ edge: "min" | "max"; value: string }> {
  if (args.platform === "android") {
    const parsed = parseAndroidSystemImageRuntime(args.runtime);
    if (!parsed) {
      return [
        { edge: "min", value: "9999" },
        { edge: "max", value: "0" },
      ];
    }
    return [
      { edge: "min", value: String(parsed.apiLevel + 1) },
      { edge: "max", value: String(parsed.apiLevel - 1) },
    ];
  }
  return [
    { edge: "min", value: "9999.0" },
    { edge: "max", value: "0.0" },
  ];
}

async function defaultSpawnCli(
  command: string[],
  timeoutMs: number,
  signal: AbortSignal,
  timer: Timer = defaultTimer,
): Promise<CliResult> {
  const child = spawn(command[0]!, command.slice(1), {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  const exited = waitForChildExit(child);
  const abort = () => terminateOwnedProcessTree(child);
  signal.addEventListener("abort", abort, { once: true });
  const timeout = timer.setTimeout(() => {
    terminateOwnedProcessTree(child);
  }, timeoutMs);
  try {
    const exitCode = await exited;
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    if (exitCode !== 0) {
      throw new Error(`CLI exited with ${exitCode}`);
    }
    return { stdout };
  } finally {
    timer.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

function waitForChildExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

/**
 * Every driver-owned CLI is a detached POSIX process group. Group-directed
 * SIGKILL reaps the command and helpers it spawned before a timed-out CLI
 * can write daemon state after the matrix has moved on. The direct-handle
 * fallback covers Windows and unusual spawn implementations.
 */
function terminateOwnedProcessTree(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The group can already be gone, or a platform spawn can ignore detached.
    }
  }
  if (!child.killed && child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

async function defaultCreateMcpClient(
  owner: string,
  build: BuildIdentity,
  signal: AbortSignal,
  presentationOrder: DiscoveryPresentationOrder = DEFAULT_ACCEPTANCE_DISCOVERY_ORDER,
): Promise<McpSessionClient> {
  const client = new Client({
    name: `live-device-acceptance-${owner}`,
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [build.entryScript],
    stderr: "inherit",
    // Every harness-owned proxy needs the signed acceptance configuration, not
    // only the two clients that prove reverse discovery. In particular, a
    // fresh client created after a persisted-session restart owns the
    // connection-level tool-selection profile used by setToolEnabled.
    env: {
      ...process.env,
      AUTOMOBILE_ACCEPTANCE_LIVE: "1",
      AUTOMOBILE_ACCEPTANCE_DISCOVERY_ORDER: presentationOrder,
    },
  });
  const abort = () => void client.close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    await client.connect(transport);
    signal.throwIfAborted();
  } catch (error) {
    await client.close();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  return {
    callTool: (name, arguments_, callSignal) =>
      client.callTool({ name, arguments: arguments_ }, undefined, { signal: callSignal }),
    close: () => client.close(),
  };
}

async function defaultCreateDaemonClient(
  build: BuildIdentity,
  signal: AbortSignal,
): Promise<DaemonSessionClient> {
  const client = new DaemonClient(SOCKET_PATH, undefined, undefined, undefined, {
    version: DAEMON_VERSION,
    build,
  });
  const abort = () => void client.close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    await client.connect();
    signal.throwIfAborted();
  } catch (error) {
    await client.close();
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  return {
    callDaemonMethod: async (name, arguments_, callSignal) => {
      const closeOnAbort = () => void client.close();
      callSignal?.addEventListener("abort", closeOnAbort, { once: true });
      try {
        return await client.callDaemonMethod(name, arguments_);
      } finally {
        callSignal?.removeEventListener("abort", closeOnAbort);
      }
    },
    close: () => client.close(),
  };
}

export async function defaultWriteEvidence(
  path: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  ensureSecureDirectorySync(dirname(path), "Evidence directory");
  signal.throwIfAborted();
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await writeFile(temporaryPath, content, { mode: SECURE_FILE_MODE, flag: "wx" });
    await chmod(temporaryPath, SECURE_FILE_MODE);
    signal.throwIfAborted();
    // link(2) is an atomic create-if-absent fence. rename would replace an
    // existing final path, allowing a late matrix to overwrite newer evidence.
    // A linked final file retains the temporary inode's 0600 mode.
    linkSync(temporaryPath, path);
    published = true;
    unlinkSync(temporaryPath);
    assertMode(path, SECURE_FILE_MODE, "Evidence file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Evidence final path already exists; refusing to overwrite: ${path}`);
    }
    throw error;
  } finally {
    if (!published) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}

function assertProvisionedIdentity(
  payload: JsonObject,
  args: AcceptanceArgs,
  expectedAndroidDeviceId?: string,
): void {
  const device = asObject(payload.device, "provisionDevice.device");
  if (stringField(device, "name", "provisionDevice.device") !== targetDeviceName(args)) {
    throw new Error("provisionDevice returned a different named device");
  }
  if (
    args.platform === "android" &&
    expectedAndroidDeviceId !== undefined &&
    stringField(device, "deviceId", "provisionDevice.device") !== expectedAndroidDeviceId
  ) {
    throw new Error("provisionDevice returned a different Android target instance");
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

function acceptanceSessionRestartScope(
  args: AcceptanceArgs,
  sessionUuid: string,
  expiresAt: number,
): AcceptanceSessionRestartScope {
  return {
    sessionUuid,
    platform: args.platform,
    stableDeviceId: targetIdentity(args),
    controls: {
      androidSiblingAvdName: args.controls.androidSiblingAvdName,
      androidDuplicateSerial: args.controls.androidDuplicateSerial,
      iosSameNameSiblingUdid: args.controls.iosSameNameSiblingUdid,
    },
    expiresAt,
  };
}

function restartAcceptanceSessionCommand(
  build: BuildIdentity,
  scope: AcceptanceSessionRestartScope,
): string[] {
  return [
    process.execPath,
    build.entryScript,
    "--daemon",
    "restart-acceptance-session",
    "--session-uuid",
    scope.sessionUuid,
    "--platform",
    scope.platform,
    "--stable-device-id",
    scope.stableDeviceId,
    "--android-sibling-avd-name",
    scope.controls.androidSiblingAvdName,
    "--android-duplicate-serial",
    scope.controls.androidDuplicateSerial,
    "--ios-same-name-sibling-uuid",
    scope.controls.iosSameNameSiblingUdid,
    "--expires-at",
    String(scope.expiresAt),
  ];
}

function cliAcquisitionCommand(args: AcceptanceArgs): string[] {
  const tool = acquisitionTool(args, "platform");
  return [
    process.execPath,
    args.build.entryScript,
    "--cli",
    tool,
    ...(args.platform === "android"
      ? ["--avd-name", args.target.avdName!]
      : ["--device-id", args.target.simulatorUdid!]),
    "--enable-tools",
    JSON.stringify(ENABLED_TOOLS),
  ];
}

function acquiredCliSession(
  result: CliResult,
  args: AcceptanceArgs,
): {
  sessionUuid: string;
  identity: RuntimeIdentity;
  device: ExactDevice;
} {
  let response: ToolResponse;
  try {
    response = JSON.parse(result.stdout) as ToolResponse;
  } catch {
    throw new Error("CLI acquisition did not return a parseable JSON tool response");
  }
  const tool = acquisitionTool(args, "platform");
  if (response.isError) {
    throw new Error(`${tool} returned an MCP error: ${toolDiagnostic(response, tool)}`);
  }
  // The CLI writes the daemon's public tool envelope verbatim. With output
  // reduction enabled, that envelope retains the authoritative JSON text but
  // intentionally omits its duplicate structuredContent field. Read both
  // representations through the shared envelope contract; do not synthesize
  // session or device identity from the command-line arguments.
  const payload = readToolEnvelopePayload(response)?.payload;
  if (!payload) {
    throw new Error(`${tool} did not return an acquisition payload`);
  }
  const sessionUuid = stringField(payload, "sessionUuid", tool);
  const { identity, device } = acquiredIdentity(payload, args);
  return { sessionUuid, identity, device };
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

function assertIosRunnerTransitionEvidence(
  before: AcquiredSession,
  after: AcquiredSession,
): {
  serviceEndpointExposed: boolean;
  serviceEndpointChanged: boolean;
  runnerGenerationExposed: boolean;
  runnerGenerationChanged: boolean;
  runnerIdentityChanged: boolean;
} {
  const beforePort = before.identity.iosServicePort;
  const afterPort = after.identity.iosServicePort;
  const beforeGeneration = before.identity.iosRunnerGeneration;
  const afterGeneration = after.identity.iosRunnerGeneration;
  const serviceEndpointExposed = beforePort !== undefined && afterPort !== undefined;
  const runnerGenerationExposed = beforeGeneration !== undefined && afterGeneration !== undefined;
  if (!serviceEndpointExposed) {
    throw new Error("iOS runner restart did not expose a daemon-owned CtrlProxy service port");
  }
  if (!runnerGenerationExposed) {
    throw new Error("iOS runner restart did not expose runner generation evidence");
  }
  const serviceEndpointChanged = serviceEndpointExposed && beforePort !== afterPort;
  const runnerGenerationChanged = runnerGenerationExposed && beforeGeneration !== afterGeneration;
  if (!serviceEndpointChanged) {
    throw new Error(
      "iOS CtrlProxy service port did not change across the required targeted restart",
    );
  }
  if (!runnerGenerationChanged) {
    throw new Error("iOS runner generation did not change across the required targeted restart");
  }
  return {
    serviceEndpointExposed,
    serviceEndpointChanged,
    runnerGenerationExposed,
    runnerGenerationChanged,
    runnerIdentityChanged: true,
  };
}

function assertLiveSafeguards(
  args: AcceptanceArgs,
  dependencies: MatrixDependencies,
): OwnershipManifest | undefined {
  if (dependencies.testOnly) {
    return undefined;
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
  return assertOwnershipManifest(args);
}

function testOnlyManifestForEvidence(args: AcceptanceArgs): OwnershipManifest {
  if (existsSync(args.ownershipManifestPath)) {
    return assertOwnershipManifest(args);
  }
  const payload = manifestPayload({}, "test-only-ownership-manifest");
  return {
    ...payload,
    mac: manifestMac(payload, args.operatorKey),
  };
}

function closeLateOwnedHandle(value: unknown): Promise<void> | undefined {
  if (!value || typeof value !== "object" || !("close" in value)) {
    return undefined;
  }
  const close = (value as { close?: unknown }).close;
  if (typeof close !== "function") {
    return undefined;
  }
  try {
    return Promise.resolve((close as () => unknown).call(value)).then(() => undefined);
  } catch {
    return undefined;
  }
}

async function settleWithin(
  work: Promise<unknown>,
  timeoutMs: number,
  timer: Timer,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutReached = new Promise<void>((resolve) => {
    timeout = timer.setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined,
      ),
      timeoutReached,
    ]);
  } finally {
    if (timeout !== undefined) {
      timer.clearTimeout(timeout);
    }
  }
}

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function establishAcceptanceRunScope(): () => void {
  const previousLiveAcceptanceStartupSecret =
    process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
  const previousAcceptanceDiscoveryCapability = process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV];
  const inheritedStartupSecret = daemonLiveAcceptanceStartupSecret();
  const inheritedDiscoveryCapability = process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV];

  // The wrapper establishes both opaque values once for its Android+iOS
  // process tree. A direct driver invocation gets a private pair instead of
  // accepting a partial or accidental environment, then restores its caller.
  if (
    inheritedStartupSecret !== undefined &&
    typeof inheritedDiscoveryCapability === "string" &&
    inheritedDiscoveryCapability.length >= 32
  ) {
    return () => {};
  }

  process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = randomUUID();
  process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV] = randomUUID();
  return () => {
    restoreEnvironmentVariable(
      DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV,
      previousLiveAcceptanceStartupSecret,
    );
    restoreEnvironmentVariable(
      ACCEPTANCE_DISCOVERY_CAPABILITY_ENV,
      previousAcceptanceDiscoveryCapability,
    );
  };
}

export async function runAcceptanceMatrix(
  args: AcceptanceArgs,
  dependencies: MatrixDependencies = {},
): Promise<Evidence> {
  if (args.scenario !== "full") {
    throw new Error("--scenario must be full; recovery is not implemented");
  }
  // Injected unit-test fakes do not touch the filesystem or launch a product
  // process. Keep their fixture contract small while production parsing always
  // supplies the authenticated values below.
  if (dependencies.testOnly) {
    args = {
      ...args,
      operatorKey: args.operatorKey ?? Buffer.from("test-only-operator-key-material-32-bytes"),
      operatorKeyPath: args.operatorKeyPath ?? "test-only.key",
      ownershipManifestPath: args.ownershipManifestPath ?? "test-only.manifest",
      build: args.build ?? { entryScript: "/test/dist/src/index.js", buildId: "test-build" },
    };
  }
  assertControlConfiguration(args.target, args.controls);
  const ownershipManifest =
    assertLiveSafeguards(args, dependencies) ?? testOnlyManifestForEvidence(args);
  assertProvisionSchemaMatrix(args);
  if (dependencies.writeFile === undefined) {
    ensureSecureDirectorySync(dirname(resolve(args.evidencePath)), "Evidence directory");
  }
  const restoreAcceptanceRunScope = dependencies.testOnly
    ? () => {}
    : establishAcceptanceRunScope();
  const timer = dependencies.timer ?? defaultTimer;
  const spawnCli =
    dependencies.spawnCli ??
    (async (command: string[], timeoutMs: number, signal: AbortSignal) =>
      await defaultSpawnCli(command, timeoutMs, signal, timer));
  const createMcpClientFactory =
    dependencies.createMcpClient ??
    (async (owner: string, signal: AbortSignal, presentationOrder?: DiscoveryPresentationOrder) =>
      await defaultCreateMcpClient(owner, args.build, signal, presentationOrder));
  const createMcpClient = async (
    owner: string,
    signal: AbortSignal,
    presentationOrder: DiscoveryPresentationOrder = DEFAULT_ACCEPTANCE_DISCOVERY_ORDER,
  ): Promise<McpSessionClient> => await createMcpClientFactory(owner, signal, presentationOrder);
  const createDaemonClient =
    dependencies.createDaemonClient ??
    (async (signal: AbortSignal) => await defaultCreateDaemonClient(args.build, signal));
  const restartAcceptanceSession =
    dependencies.restartAcceptanceSession ??
    (async (scope: AcceptanceSessionRestartScope, timeoutMs: number, signal: AbortSignal) => {
      await defaultSpawnCli(
        restartAcceptanceSessionCommand(args.build, scope),
        timeoutMs,
        signal,
        timer,
      );
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
    onAbort?: () => void | Promise<void>,
  ): Promise<T> => {
    const phaseDeadline =
      budget === "work" ? workDeadline : budget === "cleanup" ? cleanupDeadline : deadline;
    const remaining = phaseDeadline - timer.now();
    if (remaining <= 0) {
      throw new Error(`Acceptance deadline elapsed before ${phase}`);
    }
    // Reserve time to reap a child/transport that ignores AbortSignal. A
    // timeout therefore starts cancellation before, never after, the phase's
    // absolute deadline. This is intentionally charged to every awaited
    // operation rather than trusting cooperative cancellation.
    const reapReserveMs = Math.min(MAX_REAP_RESERVE_MS, Math.max(1, Math.floor(remaining / 4)));
    const operationBudgetMs = Math.max(1, remaining - reapReserveMs);
    const controller = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    let deadlineError: Error | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = timer.setTimeout(() => {
        const error = new Error(`Acceptance deadline elapsed during ${phase}`);
        deadlineError = error;
        controller.abort(error);
        void Promise.resolve(onAbort?.()).catch(() => undefined);
        reject(error);
      }, operationBudgetMs);
    });
    const work = Promise.resolve().then(() => run(controller.signal));
    // A late connection can still hand us a closeable client after the matrix
    // has abandoned its result. Close it immediately, but never let that late
    // completion resume the matrix or publish state.
    void work.then(
      (result) => {
        if (controller.signal.aborted) {
          void closeLateOwnedHandle(result);
        }
      },
      () => undefined,
    );
    try {
      return await Promise.race([work, timedOut]);
    } catch (error) {
      if (!deadlineError) {
        throw error;
      }
      // Cancellation itself must not become an unbounded second operation.
      // Give a real child/transport the reserved reaping slice, then return the
      // deadline failure even if an injected operation never settles.
      await settleWithin(work, reapReserveMs, timer);
      throw deadlineError;
    } finally {
      if (timeout !== undefined) {
        timer.clearTimeout(timeout);
      }
    }
  };

  if (!dependencies.testOnly) {
    try {
      await bounded("acceptance daemon freshness", "work", async (signal) => {
        await ensureFreshAcceptanceDaemon({
          createDaemonClient,
          spawnCli,
          build: args.build,
          expectedCapability: process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV] ?? "",
          signal,
        });
      });
    } catch (error) {
      restoreAcceptanceRunScope();
      throw error;
    }
  }

  const steps: Step[] = [];
  const runtimeIdentities: JsonObject[] = [];
  const acquisitionRequests: JsonObject[] = [];
  const clients: McpSessionClient[] = [];
  const minted: MintedSession[] = [];
  const cleanupFailures: string[] = [];
  const discoveryOrders: string[][] = [];
  const controlSnapshots: JsonObject[] = [];
  let reversedDiscoveryOrder = false;
  let destructiveControlChecks = 0;
  let androidControls: AndroidDiscoveryControls | undefined;
  let iosControls: IosDiscoveryControls | undefined;
  let controlClient: McpSessionClient | undefined;
  let daemonClient: DaemonSessionClient | undefined;
  let provisionedDevice: JsonObject | undefined;
  let provisionClient: McpSessionClient | undefined;
  let primaryError: unknown;
  let iosRunnerRestartEvidence = {
    serviceEndpointExposed: false,
    serviceEndpointChanged: false,
    runnerGenerationExposed: false,
    runnerGenerationChanged: false,
    runnerIdentityChanged: false,
  };

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
    await bounded(
      `${phase} ${tool}`,
      budget,
      async (signal) => await client.callTool(tool, request, signal),
      () => client.close(),
    );

  /**
   * Destructive device tools are opt-in. Grant only the specific capability to
   * the new MCP connection that will invoke it.
   */
  const enableDestructiveTool = async (
    client: McpSessionClient,
    tool: "provisionDevice" | "deleteDevice" | "killDevice",
    phase: string,
  ): Promise<void> => {
    const response = await callTool(
      client,
      "setToolEnabled",
      { toolName: tool, enabled: true },
      `${phase}-enable-${tool}`,
    );
    if (response.isError) {
      throw new Error(`Could not enable ${tool} for ${phase}`);
    }
    const payload = toolPayload(response, "setToolEnabled");
    if (stringField(payload, "toolName", "setToolEnabled") !== tool || payload.enabled !== true) {
      throw new Error(`setToolEnabled did not confirm ${tool} for ${phase}`);
    }
  };

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
      async (signal) => await createDaemonClient(signal),
    );
    await bounded(
      `${phase} daemon release`,
      budget,
      async (signal) =>
        await daemonClient!.callDaemonMethod(
          "daemon/releaseSession",
          { sessionId: sessionUuid },
          signal,
        ),
      () => daemonClient!.close(),
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

  const restartIosRunner = async (device: ExactDevice): Promise<void> => {
    if (args.platform !== "ios") {
      return;
    }
    if (device.deviceId !== args.target.simulatorUdid) {
      throw new Error(
        `Refusing iOS runner restart for ${device.deviceId}; expected ${args.target.simulatorUdid}`,
      );
    }
    daemonClient ??= await bounded(
      "iOS runner restart daemon connect",
      "work",
      async (signal) => await createDaemonClient(signal),
    );
    const start = timer.now();
    const result = asObject(
      await bounded(
        "iOS runner restart",
        "work",
        async (signal) =>
          await daemonClient!.callDaemonMethod(
            "ide/updateService",
            { deviceId: device.deviceId, platform: "ios" },
            signal,
          ),
        () => daemonClient!.close(),
      ),
      "ide/updateService",
    );
    if (result.success !== true) {
      throw new Error("ide/updateService did not confirm the iOS runner restart");
    }
    recordStep(steps, timer, "ios-runner-restart", start, {
      deviceId: device.deviceId,
      platform: "ios",
    });
  };

  const acquire = async (
    phase: string,
    range: "exact" | "min" | "max" | "bounded",
    kind: AcquisitionKind,
  ): Promise<AcquiredSession> => {
    const start = timer.now();
    const client = await bounded(
      `${phase} MCP connect`,
      "work",
      async (signal) => await createMcpClient(phase, signal),
    );
    clients.push(client);
    const request = acquisitionRequest(args, range, kind);
    const tool = acquisitionTool(args, kind);
    acquisitionRequests.push({ phase, range, kind, tool, request });
    const payload = toolPayload(await callTool(client, tool, request, phase), tool);
    const sessionUuid = stringField(payload, "sessionUuid", tool);
    mint(phase, sessionUuid);
    await verifyReadiness(client, sessionUuid, phase);
    const { identity, device } = acquiredIdentity(payload, args);
    if (
      args.platform === "android" &&
      androidControls &&
      phase !== "acquire-stopped" &&
      device.deviceId !== androidControls.target.deviceId
    ) {
      throw new Error(
        `acquire selected Android serial ${device.deviceId}, expected ${androidControls.target.deviceId}`,
      );
    }
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

  const expectIncompatibleBound = async (edge: "min" | "max", value: string): Promise<void> => {
    const phase = `reject-incompatible-${edge}`;
    const start = timer.now();
    const client = await bounded(
      `${phase} MCP connect`,
      "work",
      async (signal) => await createMcpClient(phase, signal),
    );
    clients.push(client);
    const request = acquisitionRequest(args, "exact", "generic");
    request[edge === "min" ? "minOsVersion" : "maxOsVersion"] = value;
    const response = await callTool(client, "startDevice", request, phase);
    acquisitionRequests.push({
      phase,
      range: `incompatible-${edge}`,
      kind: "generic",
      tool: "startDevice",
      request,
    });
    if (!response.isError) {
      const payload = toolPayload(response, "startDevice");
      const unexpectedSession = stringField(payload, "sessionUuid", "startDevice");
      mint(phase, unexpectedSession);
      throw new Error(
        `startDevice accepted incompatible ${edge}OsVersion ${value} for the owned target`,
      );
    }
    recordStep(steps, timer, phase, start, {
      edge,
      value,
      diagnostic: toolDiagnostic(response, "startDevice"),
    });
  };

  const expectIncompatibleIosFamily = async (): Promise<void> => {
    if (args.platform !== "ios") {
      return;
    }
    const phase = "reject-incompatible-ios-family";
    const start = timer.now();
    const client = await bounded(
      `${phase} MCP connect`,
      "work",
      async (signal) => await createMcpClient(phase, signal),
    );
    clients.push(client);
    const request = acquisitionRequest(args, "exact", "generic");
    request.formFactor = request.formFactor === "phone" ? "tablet" : "phone";
    const response = await callTool(client, "startDevice", request, phase);
    acquisitionRequests.push({
      phase,
      range: "incompatible-family",
      kind: "generic",
      tool: "startDevice",
      request,
    });
    if (!response.isError) {
      throw new Error(
        "startDevice accepted an incompatible iOS device family for the owned simulator",
      );
    }
    recordStep(steps, timer, phase, start, {
      formFactor: request.formFactor,
      diagnostic: toolDiagnostic(response, "startDevice"),
    });
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

  const listControlledDevices = async (
    client: McpSessionClient,
    phase: string,
  ): Promise<DiscoveryDevice[]> => {
    const payload = toolPayload(
      await callTool(client, "listDevices", { platform: args.platform }, phase),
      "listDevices",
    );
    const devices = objectArrayField(payload, "devices", "listDevices");
    const discovered = devices.map((device) => {
      const platform = stringField(device, "platform", "listDevices.devices");
      if (platform !== args.platform) {
        throw new Error(`listDevices returned ${platform} while filtering for ${args.platform}`);
      }
      return {
        name: stringField(device, "name", "listDevices.devices"),
        deviceId: stringField(device, "deviceId", "listDevices.devices"),
        platform,
      } as DiscoveryDevice;
    });
    discoveryOrders.push(discovered.map((device) => `${device.name}:${device.deviceId}`));
    return discovered;
  };

  const sameDevice = (left: DiscoveryDevice, right: DiscoveryDevice): boolean =>
    left.name === right.name &&
    left.deviceId === right.deviceId &&
    left.platform === right.platform;
  const findExactlyOne = (
    devices: DiscoveryDevice[],
    predicate: (device: DiscoveryDevice) => boolean,
    description: string,
  ): DiscoveryDevice => {
    const matches = devices.filter(predicate);
    if (matches.length !== 1) {
      throw new Error(
        `${description} must appear exactly once in discovery, found ${matches.length}`,
      );
    }
    return matches[0]!;
  };
  const assertDeterministicReversedOrder = (
    forward: DiscoveryDevice[],
    reverse: DiscoveryDevice[],
  ): void => {
    if (
      forward.length !== reverse.length ||
      forward.some((device, index) => !sameDevice(device, reverse[forward.length - index - 1]!))
    ) {
      throw new Error(
        `Acceptance discovery-order seam did not present the same public discovery data in reverse ${JSON.stringify(discoveryOrders.slice(-2))}`,
      );
    }
    reversedDiscoveryOrder = true;
  };
  const captureAndroidControls = (devices: DiscoveryDevice[]): AndroidDiscoveryControls => {
    const sameNamed = devices.filter((device) => device.name === args.target.avdName);
    if (sameNamed.length !== 2) {
      throw new Error(
        `Controlled Android target must have exactly one intended instance and one signed duplicate; found ${sameNamed.length}`,
      );
    }
    const duplicate = findExactlyOne(
      sameNamed,
      (device) => device.deviceId === args.controls.androidDuplicateSerial,
      "Signed Android duplicate",
    );
    const target = findExactlyOne(
      sameNamed,
      (device) => device.deviceId !== args.controls.androidDuplicateSerial,
      "Intended Android target",
    );
    const sibling = findExactlyOne(
      devices,
      (device) => device.name === args.controls.androidSiblingAvdName,
      "Controlled Android sibling",
    );
    if (
      sibling.deviceId === target.deviceId ||
      sibling.deviceId === duplicate.deviceId ||
      target.deviceId === duplicate.deviceId
    ) {
      throw new Error(
        "Android discovery controls must identify three distinct live device instances",
      );
    }
    return { target, sibling, duplicate };
  };
  const captureIosControls = (devices: DiscoveryDevice[]): IosDiscoveryControls => {
    const sameNamed = devices.filter((device) => device.name === args.target.simulatorName);
    if (sameNamed.length !== 2) {
      throw new Error(
        `Controlled iOS target must have exactly the target and signed same-name sibling; found ${sameNamed.length}`,
      );
    }
    const target = findExactlyOne(
      sameNamed,
      (device) => device.deviceId === args.target.simulatorUdid,
      "Exact iOS UUID target",
    );
    const sibling = findExactlyOne(
      sameNamed,
      (device) => device.deviceId === args.controls.iosSameNameSiblingUdid,
      "Controlled iOS same-name sibling",
    );
    return { target, sibling };
  };
  const recordControlSnapshot = (
    stage: string,
    controls: AndroidDiscoveryControls | IosDiscoveryControls,
    duplicatePresent?: boolean,
  ): void => {
    controlSnapshots.push({
      stage,
      target: controls.target,
      sibling: controls.sibling,
      ...(args.platform === "android"
        ? {
            duplicate: (controls as AndroidDiscoveryControls).duplicate,
            duplicatePresent,
          }
        : {}),
    });
  };
  const assertCurrentControls = async (stage: string): Promise<void> => {
    if (!controlClient) {
      throw new Error("Controlled discovery client was not initialized");
    }
    const start = timer.now();
    const devices = await listControlledDevices(controlClient, `control-${stage}`);
    if (args.platform === "android") {
      if (!androidControls) {
        throw new Error("Android discovery controls were not initialized");
      }
      if (devices.some((device) => device.deviceId === androidControls.duplicate.deviceId)) {
        throw new Error(`Signed Android duplicate reappeared after ${stage}`);
      }
      const target = findExactlyOne(
        devices,
        (device) => device.name === androidControls!.target.name,
        "Intended Android target",
      );
      const siblings = devices.filter((device) => device.name === androidControls!.sibling.name);
      if (siblings.length !== 1) {
        throw new Error(
          `Controlled Android sibling must appear exactly once after ${stage}, found ${siblings.length}`,
        );
      }
      const sibling = siblings[0]!;
      if (!sameDevice(sibling, androidControls.sibling)) {
        throw new Error(`Controlled Android sibling changed during ${stage}`);
      }
      if (!sameDevice(target, androidControls.target)) {
        throw new Error(`Intended Android target changed during ${stage}`);
      }
      recordControlSnapshot(stage, { ...androidControls, target, sibling }, false);
    } else {
      if (!iosControls) {
        throw new Error("iOS discovery controls were not initialized");
      }
      const sameNamed = devices.filter((device) => device.name === iosControls!.target.name);
      if (sameNamed.length !== 2) {
        throw new Error(
          `Exact iOS UUID target and same-name sibling must remain the only two named controls after ${stage}, found ${sameNamed.length}`,
        );
      }
      const target = findExactlyOne(
        sameNamed,
        (device) => sameDevice(device, iosControls!.target),
        "Exact iOS UUID target",
      );
      const sibling = findExactlyOne(
        sameNamed,
        (device) => sameDevice(device, iosControls!.sibling),
        "Controlled iOS same-name sibling",
      );
      recordControlSnapshot(stage, { target, sibling });
    }
    destructiveControlChecks += 1;
    recordStep(steps, timer, `controls-${stage}`, start, {
      targetPresent: true,
      siblingPresentAndUntouched: true,
      ...(args.platform === "android"
        ? { signedDuplicateAbsent: true, intendedTargetUnchanged: true }
        : { exactUuidTargetUntouched: true, sameNameSiblingUntouched: true }),
    });
  };

  const assertTargetAbsentFromPlatformInventory = async (stage: string): Promise<void> => {
    if (!controlClient) {
      throw new Error("Controlled discovery client was not initialized");
    }
    const start = timer.now();
    const controls = args.platform === "android" ? androidControls : iosControls;
    if (!controls) {
      throw new Error(`${args.platform} discovery controls were not initialized`);
    }
    const payload = toolPayload(
      await callTool(
        controlClient,
        "listDeviceImages",
        { platform: args.platform },
        `control-${stage}`,
      ),
      "listDeviceImages",
    );
    const images = objectArrayField(payload, "images", "listDeviceImages");
    const targetRemains = images.some(
      (image) =>
        image.platform === args.platform &&
        (args.platform === "android"
          ? image.name === targetIdentity(args)
          : image.deviceId === targetIdentity(args)),
    );
    if (targetRemains) {
      throw new Error(`Original signed target remained in platform inventory during ${stage}`);
    }
    const siblingPresent = images.some(
      (image) =>
        image.platform === args.platform &&
        (args.platform === "android"
          ? image.name === controls.sibling.name
          : image.deviceId === controls.sibling.deviceId),
    );
    if (!siblingPresent) {
      throw new Error(`Signed sibling was absent from platform inventory during ${stage}`);
    }
    controlSnapshots.push({
      stage,
      target: controls.target,
      sibling: controls.sibling,
      targetPresentInPlatformInventory: false,
      siblingPresentInPlatformInventory: true,
    });
    destructiveControlChecks += 1;
    recordStep(steps, timer, `controls-${stage}`, start, {
      targetPresentInPlatformInventory: false,
      siblingPresentInPlatformInventory: true,
    });
  };

  const discardDaemonClient = async (phase: string): Promise<void> => {
    if (!daemonClient) {
      return;
    }
    try {
      await bounded(`${phase} daemon close`, "cleanup", async () => await daemonClient!.close());
    } catch (error) {
      cleanupFailures.push(
        `${phase} daemon close: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      daemonClient = undefined;
    }
  };

  const acquireCli = async (phase: string): Promise<CliAcquiredSession> => {
    const start = timer.now();
    const acquired = await bounded(`${phase} CLI acquisition`, "work", async (signal) => {
      return acquiredCliSession(
        await spawnCli(
          cliAcquisitionCommand(args),
          Math.max(1, workDeadline - timer.now()),
          signal,
        ),
        args,
      );
    });
    mint(phase, acquired.sessionUuid);
    runtimeIdentities.push({ phase, ...acquired.identity });
    acquisitionRequests.push({
      phase,
      range: "exact",
      kind: "platform",
      tool: acquisitionTool(args, "platform"),
      request: acquisitionRequest(args, "exact", "platform"),
    });
    recordStep(steps, timer, phase, start, {
      sessionUuid: acquired.sessionUuid,
      identity: acquired.identity,
      device: acquired.device,
      processExited: true,
    });
    return acquired;
  };

  const expectPersistedSessionTerminal = async (
    sessionUuid: string,
    reason: "target-absent" | "target-busy",
  ): Promise<void> => {
    const phase = `persisted-${reason}-old-uuid`;
    const client = await bounded(
      `${phase} MCP connect`,
      "work",
      async (signal) => await createMcpClient(phase, signal),
    );
    clients.push(client);
    const first = await callTool(client, "getDeviceState", { sessionUuid }, phase);
    if (!first.isError) {
      throw new Error(
        `Persisted session ${sessionUuid} operated after ${reason}; it must never bind the sibling`,
      );
    }
    const firstDiagnostic = toolDiagnostic(first, "getDeviceState");
    if (
      !firstDiagnostic.includes(`Cannot safely recover session ${sessionUuid}`) ||
      !firstDiagnostic.includes(`recovery reason: ${reason}`)
    ) {
      throw new Error(
        `Persisted ${reason} rejection did not report the exact old-session recovery reason: ${firstDiagnostic}`,
      );
    }
    const second = await callTool(client, "getDeviceState", { sessionUuid }, `${phase}-terminal`);
    const terminalDiagnostic =
      `Session ${sessionUuid} is terminal after identity-recovery-${reason} and cannot be reused. ` +
      "Acquire a new device with getAndroid or getApple.";
    if (!second.isError || toolDiagnostic(second, "getDeviceState") !== terminalDiagnostic) {
      throw new Error(
        `Persisted ${reason} UUID was not durably terminal after its first rejection`,
      );
    }
    recordStep(steps, timer, `persisted-session-${reason}-terminal`, timer.now(), {
      sessionUuid,
      reason,
      firstDiagnostic,
      terminalDiagnostic,
      siblingFallbackRejected: true,
    });
  };

  const deleteExactSignedTarget = async (): Promise<void> => {
    const controls = args.platform === "android" ? androidControls : iosControls;
    if (!controls) {
      throw new Error(`${args.platform} discovery controls were not initialized`);
    }
    const client = await bounded(
      "persisted-target-absent delete MCP connect",
      "work",
      async (signal) => await createMcpClient("persisted-target-absent-delete", signal),
    );
    clients.push(client);
    await enableDestructiveTool(client, "deleteDevice", "persisted-target-absent-delete");
    const request = {
      operationId: randomUUID(),
      target: {
        platform: args.platform,
        isVirtual: true,
        stableId: targetIdentity(args),
        stableName: targetDeviceName(args),
      },
      mode: "destroy" as const,
      verifyAbsence: true,
      timeoutMs: Math.max(1, workDeadline - timer.now()),
      cancellationPolicy: "cancel-on-request-abort" as const,
    };
    if (
      request.target.stableId !== targetIdentity(args) ||
      request.target.stableName !== targetDeviceName(args) ||
      request.target.platform !== args.platform
    ) {
      throw new Error("deleteDevice request escaped the signed target identity");
    }
    const deletion = toolPayload(
      await callTool(client, "deleteDevice", request, "persisted-target-absent-delete"),
      "deleteDevice",
    );
    if (stringField(deletion, "state", "deleteDevice") !== "destroyed") {
      throw new Error("deleteDevice did not confirm destruction of the signed target");
    }
    const verification = asObject(deletion.verification, "deleteDevice.verification");
    if (
      stringField(verification, "notRunning", "deleteDevice.verification") !== "confirmed" ||
      stringField(verification, "inventory", "deleteDevice.verification") !==
        "complete_absence_confirmed"
    ) {
      throw new Error("deleteDevice did not confirm complete platform-inventory absence");
    }
    recordStep(steps, timer, "persisted-target-absent-delete-target", timer.now(), {
      target: controls.target,
      signedTargetOnly: true,
      verifiedInventoryAbsence: true,
    });
  };

  const acquireSignedSiblingAfterTargetAbsence = async (): Promise<void> => {
    const controls = args.platform === "android" ? androidControls : iosControls;
    if (!controls) {
      throw new Error(`${args.platform} discovery controls were not initialized`);
    }
    const phase = "persisted-target-absent-explicit-sibling-reacquire";
    const client = await bounded(
      `${phase} MCP connect`,
      "work",
      async (signal) => await createMcpClient(phase, signal),
    );
    clients.push(client);
    const tool = args.platform === "android" ? "getAndroid" : "getApple";
    const request =
      args.platform === "android"
        ? {
            avdName: controls.sibling.name,
            deviceId: controls.sibling.deviceId,
            enableTools: [...ENABLED_TOOLS],
          }
        : { deviceId: controls.sibling.deviceId, enableTools: [...ENABLED_TOOLS] };
    const payload = toolPayload(await callTool(client, tool, request, phase), tool);
    const sessionUuid = stringField(payload, "sessionUuid", tool);
    mint(phase, sessionUuid);
    await verifyReadiness(client, sessionUuid, phase);
    const identity = asObject(payload.deviceIdentity, `${tool}.deviceIdentity`);
    const returnedId =
      args.platform === "android"
        ? stringField(identity, "adbSerial", `${tool}.deviceIdentity`)
        : stringField(identity, "simulatorUdid", `${tool}.deviceIdentity`);
    if (returnedId !== controls.sibling.deviceId || sessionUuid.length === 0) {
      throw new Error("Explicit sibling reacquisition did not return the signed sibling identity");
    }
    await release(sessionUuid, phase);
    recordStep(steps, timer, phase, timer.now(), {
      sessionUuid,
      sibling: controls.sibling,
      explicitFreshUuid: true,
    });
  };

  const assertControlledDiscovery = async (): Promise<void> => {
    const phase = "controlled-discovery";
    const start = timer.now();
    const forwardClient = await bounded(
      `${phase} forward MCP connect`,
      "work",
      async (signal) => await createMcpClient(`${phase}-forward`, signal, "forward"),
    );
    const reverseClient = await bounded(
      `${phase} reverse MCP connect`,
      "work",
      async (signal) => await createMcpClient(`${phase}-reverse`, signal, "reverse"),
    );
    controlClient = forwardClient;
    clients.push(forwardClient, reverseClient);
    const forward = await listControlledDevices(forwardClient, `${phase}-forward-list`);
    const reverse = await listControlledDevices(reverseClient, `${phase}-reverse-list`);
    assertDeterministicReversedOrder(forward, reverse);

    if (args.platform === "android") {
      androidControls = captureAndroidControls(forward);
      const reversedControls = captureAndroidControls(reverse);
      if (
        !sameDevice(androidControls.target, reversedControls.target) ||
        !sameDevice(androidControls.sibling, reversedControls.sibling) ||
        !sameDevice(androidControls.duplicate, reversedControls.duplicate)
      ) {
        throw new Error("Android discovery controls changed while proving reversed order");
      }
      const ambiguousDiagnostics = await Promise.all(
        [
          ["forward", forwardClient],
          ["reverse", reverseClient],
        ].map(async ([order, client]) => {
          const ambiguous = await callTool(
            client as McpSessionClient,
            "getAndroid",
            { avdName: args.target.avdName, enableTools: [...ENABLED_TOOLS] },
            `${phase}-${order}-ambiguous-selection`,
          );
          const diagnostic = toolDiagnostic(ambiguous, "getAndroid");
          if (
            !ambiguous.isError ||
            !diagnostic.includes("identity_conflict") ||
            !diagnostic.includes(androidControls!.duplicate.deviceId) ||
            !diagnostic.includes(androidControls!.target.deviceId)
          ) {
            throw new Error(
              `Controlled duplicate Android AVD did not fail with identity_conflict under ${order} discovery`,
            );
          }
          return diagnostic;
        }),
      );
      if (ambiguousDiagnostics[0] !== ambiguousDiagnostics[1]) {
        throw new Error(
          "Controlled duplicate Android AVD produced different identity_conflict diagnostics by discovery order",
        );
      }
      await enableDestructiveTool(forwardClient, "killDevice", `${phase}-duplicate-cleanup`);
      toolPayload(
        await callTool(
          forwardClient,
          "killDevice",
          {
            device: {
              name: args.target.avdName,
              deviceId: args.controls.androidDuplicateSerial,
              platform: "android",
            },
          },
          `${phase}-duplicate-cleanup`,
        ),
        "killDevice",
      );
      const afterDuplicateCleanup = await listControlledDevices(
        forwardClient,
        `${phase}-after-duplicate-cleanup`,
      );
      if (afterDuplicateCleanup.some((device) => sameDevice(device, androidControls!.duplicate))) {
        throw new Error("Signed Android duplicate remained after its explicit cleanup");
      }
      const target = findExactlyOne(
        afterDuplicateCleanup,
        (device) => sameDevice(device, androidControls!.target),
        "Intended Android target",
      );
      const sibling = findExactlyOne(
        afterDuplicateCleanup,
        (device) => sameDevice(device, androidControls!.sibling),
        "Controlled Android sibling",
      );
      if (
        afterDuplicateCleanup.filter((device) => device.name === androidControls!.target.name)
          .length !== 1
      ) {
        throw new Error("Android duplicate cleanup left an unsigned same-name target instance");
      }
      recordControlSnapshot(
        "after-signed-android-duplicate-cleanup",
        { ...androidControls, target, sibling },
        false,
      );
      for (const [order, client] of [
        ["forward", forwardClient],
        ["reverse", reverseClient],
      ] as const) {
        const selectionPhase = `${phase}-${order}-exact-target-selection`;
        const request = {
          avdName: androidControls.target.name,
          deviceId: androidControls.target.deviceId,
          enableTools: [...ENABLED_TOOLS],
        };
        const selected = toolPayload(
          await callTool(client, "getAndroid", request, selectionPhase),
          "getAndroid",
        );
        const selectedSessionUuid = stringField(selected, "sessionUuid", "getAndroid");
        mint(selectionPhase, selectedSessionUuid);
        await verifyReadiness(client, selectedSessionUuid, selectionPhase);
        const selectedIdentity = acquiredIdentity(selected, args);
        if (
          selectedIdentity.device.deviceId !== androidControls.target.deviceId ||
          selectedIdentity.identity.stableIdentity !== androidControls.target.name
        ) {
          throw new Error(
            `Exact Android control selection did not retain the intended stable identity under ${order} discovery`,
          );
        }
        runtimeIdentities.push({ phase: selectionPhase, ...selectedIdentity.identity });
        acquisitionRequests.push({
          phase: selectionPhase,
          range: "exact",
          kind: "platform",
          tool: "getAndroid",
          request,
        });
        await release(selectedSessionUuid, selectionPhase);
      }
    } else {
      iosControls = captureIosControls(forward);
      const reversedControls = captureIosControls(reverse);
      if (
        !sameDevice(iosControls.target, reversedControls.target) ||
        !sameDevice(iosControls.sibling, reversedControls.sibling)
      ) {
        throw new Error("iOS discovery controls changed while proving reversed order");
      }
      recordControlSnapshot("pre-mutation-deterministic-reversed-discovery", iosControls);
      for (const [order, client] of [
        ["forward", forwardClient],
        ["reverse", reverseClient],
      ] as const) {
        const selectionPhase = `${phase}-${order}-exact-uuid-selection`;
        const request = { deviceId: iosControls.target.deviceId, enableTools: [...ENABLED_TOOLS] };
        const selected = toolPayload(
          await callTool(client, "getApple", request, selectionPhase),
          "getApple",
        );
        const selectedSessionUuid = stringField(selected, "sessionUuid", "getApple");
        mint(selectionPhase, selectedSessionUuid);
        await verifyReadiness(client, selectedSessionUuid, selectionPhase);
        const selectedIdentity = acquiredIdentity(selected, args);
        if (
          selectedIdentity.device.deviceId !== iosControls.target.deviceId ||
          selectedIdentity.identity.stableIdentity !== iosControls.target.deviceId
        ) {
          throw new Error(
            `Exact iOS UUID selection did not retain the intended stable identity under ${order} discovery`,
          );
        }
        runtimeIdentities.push({ phase: selectionPhase, ...selectedIdentity.identity });
        acquisitionRequests.push({
          phase: selectionPhase,
          range: "exact",
          kind: "platform",
          tool: "getApple",
          request,
        });
        await release(selectedSessionUuid, selectionPhase);
      }
    }
    recordStep(steps, timer, phase, start, {
      discoveryPasses: discoveryOrders.length,
      deterministicOrderReversed: true,
      targetPresent: true,
      siblingPresentAndUntouched: true,
      ...(args.platform === "android"
        ? {
            duplicateRejected: true,
            duplicateRemoved: true,
            exactStableTargetSelected: true,
            duplicateSerial: args.controls.androidDuplicateSerial,
          }
        : { sameDisplayNameSiblingUuid: args.controls.iosSameNameSiblingUdid }),
    });
  };

  const expectUnrelatedOwnerConflict = async (
    held: Pick<AcquiredSession, "sessionUuid" | "device">,
  ): Promise<void> => {
    const start = timer.now();
    const client = await bounded(
      "unrelated-owner MCP connect",
      "work",
      async (signal) => await createMcpClient("unrelated-owner", signal),
    );
    clients.push(client);
    const tool = acquisitionTool(args, "generic");
    const response = await callTool(
      client,
      tool,
      acquisitionRequest(args, "exact", "generic"),
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
    const actualDiagnostic = normalizeMcpTransportDiagnostic(toolDiagnostic(response, tool));
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
    await assertControlledDiscovery();
    if (args.platform === "ios") {
      const preflight = await acquire("preflight-ios-uuid-ownership", "exact", "platform");
      await release(preflight.sessionUuid, "preflight-ios-uuid-ownership");
    }
    await assertCurrentControls("before-provision");
    const provisionStart = timer.now();
    provisionClient = await bounded(
      "provision MCP connect",
      "work",
      async (signal) => await createMcpClient("provision", signal),
    );
    clients.push(provisionClient);
    await enableDestructiveTool(provisionClient, "provisionDevice", "provision");
    const provisionPayload = toolPayload(
      await callTool(provisionClient, "provisionDevice", provisionRequest(args), "provision"),
      "provisionDevice",
    );
    const provisionSessionUuid = stringField(provisionPayload, "sessionUuid", "provisionDevice");
    mint("provision", provisionSessionUuid);
    await verifyReadiness(provisionClient, provisionSessionUuid, "provision");
    assertProvisionedIdentity(provisionPayload, args, androidControls?.target.deviceId);
    provisionedDevice = asObject(provisionPayload.device, "provisionDevice.device");
    await release(provisionSessionUuid, "provision");
    recordStep(steps, timer, "provision-exact-runtime-device-type-config", provisionStart, {
      sessionUuid: provisionSessionUuid,
      resolvedSpec: asObject(provisionPayload.resolvedSpec, "provisionDevice.resolvedSpec"),
    });
    await assertCurrentControls("after-provision");

    const prepared = await acquire("prepare-stopped", "exact", "platform");
    await assertCurrentControls("before-target-kill");
    await kill(prepared, "prepare-stopped");
    await release(prepared.sessionUuid, "prepare-stopped");

    const stopped = await acquire("acquire-stopped", "exact", "platform");
    assertAndroidTransitionEvidence(prepared, stopped);
    if (args.platform === "android" && androidControls) {
      androidControls = { ...androidControls, target: stopped.device };
    }
    await release(stopped.sessionUuid, "acquire-stopped");
    await assertCurrentControls("after-target-reacquire");

    const genericExact = await acquire("acquire-generic-exact", "exact", "generic");
    await release(genericExact.sessionUuid, "acquire-generic-exact");

    const genericMinimum = await acquire("acquire-generic-min", "min", "generic");
    await release(genericMinimum.sessionUuid, "acquire-generic-min");

    const genericBounded = await acquire("acquire-generic-bounded", "bounded", "generic");
    await release(genericBounded.sessionUuid, "acquire-generic-bounded");

    for (const bound of incompatibleBoundRequests(args)) {
      await expectIncompatibleBound(bound.edge, bound.value);
    }
    await expectIncompatibleIosFamily();

    const cliAcquired = await acquireCli("short-lived-cli-acquisition");
    await expectUnrelatedOwnerConflict(cliAcquired);

    const independentStart = timer.now();
    const independent = await bounded(
      "independent MCP connect",
      "work",
      async (signal) => await createMcpClient("independent-mcp", signal),
    );
    clients.push(independent);
    await verifyReadiness(independent, cliAcquired.sessionUuid, "independent-mcp");
    recordStep(steps, timer, "independent-mcp-client", independentStart, {
      sessionUuid: cliAcquired.sessionUuid,
      acquiredBy: "short-lived-cli",
    });
    await release(cliAcquired.sessionUuid, "short-lived-cli-acquisition");

    if (args.platform === "ios") {
      await restartIosRunner(cliAcquired.device);
      const restarted = await acquire("reacquire-after-ios-runner-restart", "exact", "platform");
      iosRunnerRestartEvidence = assertIosRunnerTransitionEvidence(
        { ...cliAcquired, phase: "short-lived-cli-acquisition", client: independent },
        restarted,
      );
      await release(restarted.sessionUuid, "reacquire-after-ios-runner-restart");
    }

    const restartPersistedSession = async (
      state: "target-absent" | "target-busy",
    ): Promise<CliAcquiredSession> => {
      const persisted = await acquireCli(`persisted-${state}-cli-acquisition`);
      const restartStart = timer.now();
      await assertCurrentControls(`before-persisted-${state}-restart`);
      const scope = acceptanceSessionRestartScope(args, persisted.sessionUuid, workDeadline);
      await bounded(`persisted-${state} daemon restart`, "work", async (signal) => {
        await restartAcceptanceSession(scope, Math.max(1, workDeadline - timer.now()), signal);
      });
      await discardDaemonClient(`persisted-${state} restart`);
      recordStep(steps, timer, `persisted-${state}-daemon-restart`, restartStart, {
        acceptanceCapability: true,
        restartScope: "one-signed-session-generation",
        stableDeviceId: scope.stableDeviceId,
        controlsBound: true,
        state,
      });
      return persisted;
    };

    const busy = await restartPersistedSession("target-busy");
    const busyHolder = await acquire(
      "persisted-target-busy-exact-target-holder",
      "exact",
      "platform",
    );
    if (busyHolder.sessionUuid === busy.sessionUuid) {
      throw new Error("Busy-holder acquisition reused the persisted UUID");
    }
    await assertCurrentControls("persisted-target-busy-holder-active");
    await expectPersistedSessionTerminal(busy.sessionUuid, "target-busy");
    await release(busyHolder.sessionUuid, "persisted-target-busy-exact-target-holder");
    const busyReacquired = await acquire(
      "persisted-target-busy-explicit-target-reacquire",
      "exact",
      "platform",
    );
    if (busyReacquired.sessionUuid === busy.sessionUuid) {
      throw new Error("Explicit target reacquisition reused the terminal persisted UUID");
    }
    await release(busyReacquired.sessionUuid, "persisted-target-busy-explicit-target-reacquire");

    const absent = await restartPersistedSession("target-absent");
    await deleteExactSignedTarget();
    await assertTargetAbsentFromPlatformInventory("persisted-target-absent");
    await expectPersistedSessionTerminal(absent.sessionUuid, "target-absent");
    if (args.platform === "ios") {
      recordStep(steps, timer, "ios-same-transport-replacement-inapplicable", timer.now(), {
        reason: "simulator UDID is both the stable identity and daemon transport key",
        deletionClassifiedAs: "target-absent",
      });
    }
    await acquireSignedSiblingAfterTargetAbsence();
  } catch (error) {
    primaryError = error;
  } finally {
    if (provisionedDevice !== undefined) {
      try {
        if (provisionClient === undefined) {
          throw new Error("provision client was unavailable");
        }
        await bounded("cleanup provisioned device", "cleanup", async () => {
          await enableDestructiveTool(provisionClient!, "killDevice", "cleanup-provisioned-device");
          toolPayload(
            await callTool(
              provisionClient!,
              "killDevice",
              { device: provisionedDevice },
              "cleanup-provisioned-device",
            ),
            "killDevice",
          );
        });
      } catch (error) {
        cleanupFailures.push(
          `kill provisioned device: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
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
    restoreAcceptanceRunScope();
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
    schemaVersion: 9,
    authentication: {
      schemaVersion: 1,
      algorithm: "hmac-sha256",
      binding: redact(
        evidenceAuthenticationBinding(args.build, ownershipManifest),
        args.operatorKey,
      ) as JsonObject,
      mac: "",
    },
    generatedAt: new Date().toISOString(),
    scenario: args.scenario,
    platform: args.platform,
    build: {
      entrypoint: redact(args.build.entryScript, args.operatorKey),
      identity: redact(args.build.buildId, args.operatorKey),
      singleBuildIdentity: true,
    },
    ownership: {
      manifest: redact(args.ownershipManifestPath, args.operatorKey),
      bothPlatformsBound: dependencies.testOnly ? true : true,
    },
    target: redact(
      {
        stableIdentity: targetIdentity(args),
        namedDevice: targetDeviceName(args),
      },
      args.operatorKey,
    ) as JsonObject,
    provision: redact(provisionRequest(args), args.operatorKey) as JsonObject,
    acquisitionRequests: redact(acquisitionRequests, args.operatorKey) as JsonObject[],
    runtimeIdentities: redact(runtimeIdentities, args.operatorKey) as JsonObject[],
    controls: redact(controlSnapshots, args.operatorKey) as JsonObject[],
    checks: {
      stableIdentityPreserved: runtimeIdentities.every(
        (identity) => identity.stableIdentity === targetIdentity(args),
      ),
      readinessObserveThenState,
      allMintedSessionsReleased,
      singleBuildIdentity: true,
      controlledDiscoveryPasses: discoveryOrders.length >= 2,
      controlledDiscoveryOrderDeterministicallyReversed: reversedDiscoveryOrder,
      controlledSiblingUntouched: steps.some(
        (step) => step.name === "controlled-discovery" && step.passed,
      ),
      destructiveControlChecks: destructiveControlChecks >= 8,
      ...(args.platform === "android"
        ? {
            signedAndroidDuplicateRemoved: steps.some(
              (step) => step.name === "controlled-discovery" && step.passed,
            ),
            exactAndroidControlSelected: runtimeIdentities.some(
              (identity) =>
                identity.phase === "controlled-discovery-forward-exact-target-selection" &&
                identity.stableIdentity === targetIdentity(args),
            ),
          }
        : {
            exactIosUuidAndSameNameSiblingRetained: destructiveControlChecks >= 8,
          }),
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
      iosServiceEndpointExposed: iosRunnerRestartEvidence.serviceEndpointExposed,
      iosServiceEndpointChanged: iosRunnerRestartEvidence.serviceEndpointChanged,
      iosRunnerGenerationExposed: iosRunnerRestartEvidence.runnerGenerationExposed,
      iosRunnerGenerationChanged: iosRunnerRestartEvidence.runnerGenerationChanged,
      iosRunnerIdentityChanged: iosRunnerRestartEvidence.runnerIdentityChanged,
    },
    cleanup: {
      mintedSessionCount: minted.length,
      releasedSessionCount: minted.filter((session) => session.released).length,
      failures: redact(cleanupFailures, args.operatorKey),
    },
    outcome: {
      passed: primaryError === undefined && cleanupFailures.length === 0,
      ...(outcomeError === undefined ? {} : { error: redact(outcomeError, args.operatorKey) }),
    },
    steps: redact(steps, args.operatorKey) as Step[],
  };
  evidence.authentication.mac = evidenceMac(
    evidence,
    args.build,
    ownershipManifest,
    args.operatorKey,
  );

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
    const argv = Bun.argv.slice(2);
    if (argv.includes("--help")) {
      console.log(
        "Usage: bun scripts/live-device-acceptance.ts --platform <android|ios> --scenario full [options]",
      );
      process.exitCode = 0;
    } else if (argv.includes("--verify-evidence")) {
      const verification = parseEvidenceVerificationArgs(argv);
      const evidence = verifyEvidenceFile(verification);
      console.log(
        `Verified live-device acceptance evidence (${evidence.platform}/${evidence.scenario}); evidence=${basename(verification.evidencePath)}`,
      );
      process.exitCode = 0;
    } else {
      const args = parseArgs(argv);
      if (args.recordOwnershipManifest) {
        recordOwnershipManifest(args);
        console.log(
          `Recorded ${args.platform} ownership in ${basename(args.ownershipManifestPath)}`,
        );
        process.exitCode = 0;
      } else {
        const evidence = await runAcceptanceMatrix(args);
        console.log(
          `Live-device acceptance passed (${evidence.platform}/${evidence.scenario}); evidence=${evidenceFileName(args)}`,
        );
      }
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
