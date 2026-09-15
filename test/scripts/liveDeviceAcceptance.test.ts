import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ACCEPTANCE_DISCOVERY_CAPABILITY_ENV } from "../../src/daemon/constants";
import { DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV } from "../../src/daemon/liveAcceptanceCapability";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  assertMode,
  defaultWriteEvidence,
  parseArgs,
  recordOwnershipManifest,
  runAcceptanceMatrix,
  verifyEvidenceFile,
  type AcceptanceArgs,
  type DaemonSessionClient,
  type MatrixDependencies,
  type McpSessionClient,
} from "../../scripts/live-device-acceptance";

interface ToolCall {
  owner: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface Harness {
  calls: ToolCall[];
  events: string[];
  releases: string[];
  releaseAttempts: string[];
  cliCommands: string[][];
  evidence: string[];
  timer: FakeTimer;
  dependencies: MatrixDependencies;
}

const IOS_UDID = "00000000-0000-0000-0000-000000000001";
const LIVE_ACCEPTANCE_ENV = "AUTOMOBILE_ACCEPTANCE_LIVE";
const androidArgs: AcceptanceArgs = {
  platform: "android",
  target: { avdName: "Pixel_8_API_35" },
  controls: {
    androidSiblingAvdName: "Pixel_8_Sibling",
    androidDuplicateSerial: "emulator-5554",
    iosSameNameSiblingUdid: "00000000-0000-0000-0000-000000000002",
  },
  runtime: "35",
  deviceType: "pixel_8",
  osVersionRange: { min: "34", max: "35" },
  androidConfig: { memoryMb: 4096, cpuCores: 4 },
  scenario: "full",
  evidencePath: "scratch/live-device-acceptance/android.json",
  timeoutMs: 10_000,
  confirmLive: false,
  testOwnedDevices: false,
};

const iosArgs: AcceptanceArgs = {
  ...androidArgs,
  platform: "ios",
  target: { simulatorName: "iPhone 16 Pro", simulatorUdid: IOS_UDID },
  runtime: "iOS 18.0",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
  osVersionRange: { min: "17.0", max: "18.0" },
  androidConfig: undefined,
};

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function createProductionAcceptanceFixture(): {
  android: AcceptanceArgs;
  ios: AcceptanceArgs;
  dispose(): void;
} {
  const directory = mkdtempSync(join(tmpdir(), "automobile-live-acceptance-"));
  const operatorKeyPath = join(directory, "operator.key");
  const ownershipManifestPath = join(directory, "ownership.json");
  const operatorKey = Buffer.from("x".repeat(32));
  writeFileSync(operatorKeyPath, operatorKey);
  chmodSync(operatorKeyPath, 0o600);

  const common = {
    ownershipManifestPath,
    operatorKeyPath,
    operatorKey,
    build: { entryScript: "/test/dist/src/index.js", buildId: "test-build" },
    timeoutMs: 10_000,
    confirmLive: true,
    testOwnedDevices: true,
  };
  const android = {
    ...androidArgs,
    ...common,
    evidencePath: join(directory, "android-evidence.json"),
  };
  const ios = {
    ...iosArgs,
    ...common,
    evidencePath: join(directory, "ios-evidence.json"),
  };
  recordOwnershipManifest(android);
  recordOwnershipManifest(ios);
  return {
    android,
    ios,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function ownerDiagnostic(deviceId: string): string {
  return (
    `Device '${deviceId}' is already assigned to another session. ` +
    "Acquire a different device or wait for its owner to release it."
  );
}

function createHarness(
  options: {
    failObserveFor?: string;
    failReleaseFor?: string;
    failClientCloseFor?: string[];
    failDaemonClose?: boolean;
    unchangedAndroidIdentity?: boolean;
    oldSessionDiagnostic?: string;
    ownerDiagnostic?: string;
    resolvedConfiguration?: Record<string, unknown>;
    failCliFor?: string;
    iosSimulatorName?: string;
    unchangedIosRunnerIdentity?: boolean;
    unchangedIosServicePort?: boolean;
    unchangedIosRunnerGeneration?: boolean;
    failIosReadinessAfterRestart?: boolean;
    writeFile?: MatrixDependencies["writeFile"];
    activeSessions?: number;
    activeExecutions?: number;
    honorDiscoveryOrderSeam?: boolean;
    keepAndroidDuplicateAfterKill?: boolean;
    removeAndroidSiblingAfterDuplicateCleanup?: boolean;
    removeIosSiblingAfterProvision?: boolean;
    allowPersistedSiblingFallback?: boolean;
  } = {},
): Harness {
  const calls: ToolCall[] = [];
  const events: string[] = [];
  const releases: string[] = [];
  const releaseAttempts: string[] = [];
  const cliCommands: string[][] = [];
  const evidence: string[] = [];
  const timer = new FakeTimer();
  let startCount = 0;
  let androidDuplicatePresent = true;
  let iosRunnerRestarted = false;
  let androidTargetSerial = "emulator-5556";
  let androidSiblingPresent = true;
  let iosSiblingPresent = true;
  let androidTargetPresent = true;
  let iosTargetPresent = true;
  let targetDeleted = false;
  let cliAcquisitionCount = 0;
  let restartedSessionUuid: string | undefined;
  const persistedStates = new Map<string, "target-absent" | "target-busy">();
  const terminalPersistedSessions = new Set<string>();
  let maintenanceFenced = false;
  let daemonGeneration = 1;
  let pendingDoctorFault: string | undefined;
  const enabledToolsByOwner = new Map<string, Set<string>>();

  const createMcpClient = async (
    owner: string,
    _signal?: AbortSignal,
    presentationOrder?: "forward" | "reverse",
  ): Promise<McpSessionClient> => ({
    async callTool(name, arguments_) {
      calls.push({ owner, name, arguments: arguments_ });
      events.push(`${owner}:${name}`);
      if (name === "setToolEnabled") {
        const toolName = arguments_.toolName;
        if (
          (toolName !== "provisionDevice" && toolName !== "deleteDevice") ||
          arguments_.enabled !== true ||
          "sessionUuid" in arguments_ ||
          "toolNames" in arguments_
        ) {
          throw new Error("acceptance must narrowly enable one destructive tool on its own client");
        }
        const enabled = enabledToolsByOwner.get(owner) ?? new Set<string>();
        enabled.add(toolName);
        enabledToolsByOwner.set(owner, enabled);
        return { structuredContent: { toolName, enabled: true } };
      }
      if (
        (name === "provisionDevice" || name === "deleteDevice") &&
        !enabledToolsByOwner.get(owner)?.has(name)
      ) {
        throw new Error(`Tool ${name} is disabled for fresh MCP client ${owner}`);
      }
      if (name === "listDevices") {
        const isIos = arguments_.platform === "ios";
        const devices = isIos
          ? [
              ...(iosTargetPresent
                ? [
                    {
                      platform: "ios",
                      name: "iPhone 16 Pro",
                      deviceId: IOS_UDID,
                    },
                  ]
                : []),
              ...(iosSiblingPresent
                ? [
                    {
                      platform: "ios",
                      name: "iPhone 16 Pro",
                      deviceId: "00000000-0000-0000-0000-000000000002",
                    },
                  ]
                : []),
            ]
          : [
              ...(androidSiblingPresent
                ? [{ platform: "android", name: "Pixel_8_Sibling", deviceId: "emulator-5558" }]
                : []),
              ...(androidDuplicatePresent
                ? [
                    {
                      platform: "android",
                      name: "Pixel_8_API_35",
                      deviceId: "emulator-5554",
                    },
                  ]
                : []),
              ...(androidTargetPresent
                ? [
                    {
                      platform: "android",
                      name: "Pixel_8_API_35",
                      deviceId: androidTargetSerial,
                    },
                  ]
                : []),
            ];
        return {
          structuredContent: {
            devices:
              presentationOrder === "reverse" && options.honorDiscoveryOrderSeam !== false
                ? devices.toReversed()
                : devices,
          },
        };
      }
      if (name === "listDeviceImages") {
        const isIos = arguments_.platform === "ios";
        return {
          structuredContent: {
            images: isIos
              ? [
                  ...(targetDeleted
                    ? []
                    : [
                        {
                          platform: "ios",
                          name: "iPhone 16 Pro",
                          deviceId: IOS_UDID,
                        },
                      ]),
                  {
                    platform: "ios",
                    name: "iPhone 16 Pro",
                    deviceId: "00000000-0000-0000-0000-000000000002",
                  },
                ]
              : [
                  ...(targetDeleted
                    ? []
                    : [
                        {
                          platform: "android",
                          name: "Pixel_8_API_35",
                          deviceId: androidTargetSerial,
                        },
                      ]),
                  {
                    platform: "android",
                    name: "Pixel_8_Sibling",
                    deviceId: "emulator-5558",
                  },
                ],
          },
        };
      }
      if (name === "provisionDevice") {
        const device = arguments_.device as Record<string, unknown>;
        const spec = device.spec as Record<string, unknown>;
        const isIos = device.platform === "ios";
        if (isIos && options.removeIosSiblingAfterProvision) {
          iosSiblingPresent = false;
        }
        return {
          structuredContent: {
            sessionUuid: "provision-1",
            device: {
              name: device.name,
              deviceId: isIos ? IOS_UDID : androidTargetSerial,
            },
            resolvedSpec: {
              runtime: spec.runtime,
              deviceType: spec.deviceType,
              ...(isIos
                ? {}
                : { configuration: options.resolvedConfiguration ?? spec.configuration }),
            },
          },
        };
      }
      if (name === "getAndroid" || name === "getApple" || name === "startDevice") {
        if (maintenanceFenced) {
          throw new Error("daemon maintenance fence rejected post-repair acquisition");
        }
        if (
          name === "getAndroid" &&
          owner.startsWith("controlled-discovery-") &&
          androidDuplicatePresent
        ) {
          return {
            isError: true,
            structuredContent: {
              error:
                "identity_conflict: multiple matching AVDs include emulator-5554 and emulator-5556; provide deviceId",
            },
          };
        }
        const isIos = name === "getApple" || arguments_.platform === "ios";
        const min = arguments_.minOsVersion;
        const max = arguments_.maxOsVersion;
        const formFactor = arguments_.formFactor;
        const incompatibleBounds =
          (isIos && (min === "9999.0" || max === "0.0")) ||
          (!isIos && (min === "9999" || max === "0"));
        const incompatibleFamily = isIos && formFactor === "tablet";
        if (incompatibleBounds || incompatibleFamily) {
          return {
            isError: true,
            structuredContent: { error: "No matching device satisfies the requested constraints" },
          };
        }
        if (owner === "unrelated-owner") {
          const deviceId =
            name === "getApple" || arguments_.platform === "ios" ? IOS_UDID : androidTargetSerial;
          return {
            isError: true,
            structuredContent: { error: options.ownerDiagnostic ?? ownerDiagnostic(deviceId) },
          };
        }
        const requestedDeviceId =
          typeof arguments_.deviceId === "string" ? arguments_.deviceId : undefined;
        const requestedSibling =
          (isIos && requestedDeviceId === "00000000-0000-0000-0000-000000000002") ||
          (!isIos && requestedDeviceId === "emulator-5558");
        if (requestedSibling) {
          startCount += 1;
          const sessionUuid = `start-${startCount}`;
          return {
            structuredContent: {
              sessionUuid,
              deviceIdentity: isIos
                ? {
                    simulatorUdid: "00000000-0000-0000-0000-000000000002",
                    simulatorName: "iPhone 16 Pro",
                    iosServicePort: 8765,
                    iosRunnerGeneration: 0,
                  }
                : {
                    avdName: "Pixel_8_Sibling",
                    adbSerial: "emulator-5558",
                    emulatorConsolePort: 5558,
                  },
            },
          };
        }
        if (targetDeleted) {
          return {
            isError: true,
            structuredContent: { error: "The signed target has been permanently deleted" },
          };
        }
        if (isIos) {
          iosTargetPresent = true;
        } else {
          androidTargetPresent = true;
        }
        if (owner === "persisted-target-busy-exact-target-holder" && restartedSessionUuid) {
          persistedStates.set(restartedSessionUuid, "target-busy");
        }
        startCount += 1;
        const sessionUuid = `start-${startCount}`;
        if (isIos) {
          return {
            structuredContent: {
              sessionUuid,
              deviceIdentity: {
                simulatorUdid: IOS_UDID,
                simulatorName: options.iosSimulatorName ?? "iPhone 16 Pro",
                iosServicePort:
                  options.unchangedIosServicePort || !iosRunnerRestarted ? 8765 : 8766,
                iosRunnerGeneration:
                  options.unchangedIosRunnerIdentity ||
                  options.unchangedIosRunnerGeneration ||
                  !iosRunnerRestarted
                    ? 0
                    : 1,
              },
            },
          };
        }
        if (typeof requestedDeviceId === "string" && requestedDeviceId !== androidTargetSerial) {
          return {
            isError: true,
            structuredContent: {
              error: `identity_conflict: expected ${androidTargetSerial}, received ${requestedDeviceId}`,
            },
          };
        }
        const port = Number(androidTargetSerial.slice("emulator-".length));
        return {
          structuredContent: {
            sessionUuid,
            deviceIdentity: {
              avdName: "Pixel_8_API_35",
              adbSerial: `emulator-${port}`,
              emulatorConsolePort: port,
            },
          },
        };
      }
      if (name === "observe") {
        if (
          options.failIosReadinessAfterRestart &&
          iosRunnerRestarted &&
          owner === "reacquire-after-ios-runner-restart"
        ) {
          throw new Error("iOS CtrlProxy readiness failed after restart");
        }
        if (arguments_.sessionUuid === options.failObserveFor) {
          throw new Error(`observe failed for ${options.failObserveFor}`);
        }
        return { structuredContent: { tree: [] } };
      }
      if (name === "getDeviceState") {
        const sessionUuid = String(arguments_.sessionUuid);
        const persistedState = persistedStates.get(sessionUuid);
        if (persistedState) {
          if (options.allowPersistedSiblingFallback) {
            return { structuredContent: { state: "ready-on-sibling" } };
          }
          if (terminalPersistedSessions.has(sessionUuid)) {
            return {
              isError: true,
              structuredContent: {
                error: `Session ${sessionUuid} is terminal after identity-recovery-${persistedState}; use a new session UUID.`,
              },
            };
          }
          terminalPersistedSessions.add(sessionUuid);
          return {
            isError: true,
            structuredContent: {
              error:
                options.oldSessionDiagnostic ??
                `Cannot safely recover session ${sessionUuid}: persisted target ${persistedState} ` +
                  `(recovery reason: ${persistedState}). ` +
                  "The persisted session is terminal; acquire a new device with getAndroid or getApple.",
            },
          };
        }
        return { structuredContent: { state: "ready" } };
      }
      if (name === "killDevice") {
        const device = arguments_.device as Record<string, unknown>;
        if (device.deviceId === "emulator-5554") {
          androidDuplicatePresent = options.keepAndroidDuplicateAfterKill ?? false;
          androidSiblingPresent = !(options.removeAndroidSiblingAfterDuplicateCleanup ?? false);
        } else if (device.deviceId === androidTargetSerial && !options.unchangedAndroidIdentity) {
          if (restartedSessionUuid) {
            persistedStates.set(restartedSessionUuid, "absent");
            androidTargetPresent = false;
          } else {
            androidTargetSerial = "emulator-5560";
          }
        } else if (device.deviceId === IOS_UDID && restartedSessionUuid) {
          persistedStates.set(restartedSessionUuid, "absent");
          iosTargetPresent = false;
        }
        return { structuredContent: { killed: true } };
      }
      if (name === "deleteDevice") {
        const target = arguments_.target as Record<string, unknown>;
        if (target.isVirtual !== true) {
          throw new Error("deleteDevice must remain constrained to a virtual signed target");
        }
        if (target.stableId !== "Pixel_8_API_35" && target.stableId !== IOS_UDID) {
          throw new Error(`deleteDevice received an unsigned target ${String(target.stableId)}`);
        }
        if (restartedSessionUuid) {
          persistedStates.set(restartedSessionUuid, "target-absent");
        }
        targetDeleted = true;
        androidTargetPresent = false;
        iosTargetPresent = false;
        return {
          structuredContent: {
            state: "destroyed",
            verification: {
              notRunning: "confirmed",
              inventory: "complete_absence_confirmed",
            },
          },
        };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
    async close() {
      events.push(`close:${owner}`);
      if (options.failClientCloseFor?.includes(owner)) {
        throw new Error(`client close failed for ${owner}`);
      }
    },
  });

  const createDaemonClient = async (): Promise<DaemonSessionClient> => ({
    async callDaemonMethod(name, arguments_) {
      if (name === "ide/updateService") {
        expect(arguments_).toEqual({ deviceId: IOS_UDID, platform: "ios" });
        iosRunnerRestarted = true;
        events.push(`ios-runner-restart:${IOS_UDID}`);
        return { success: true };
      }
      if (name === "daemon/activeSessions") {
        return {
          activeSessions: options.activeSessions ?? 0,
          activeExecutions: options.activeExecutions ?? 0,
        };
      }
      if (name === "ide/status") {
        events.push("daemon:ide/status");
        return {
          pid: 1000 + daemonGeneration,
          startedAt: daemonGeneration,
          processGenerationToken: `test-generation-${daemonGeneration}`,
          buildId: "test-build",
          entryScript: "/test/dist/src/index.js",
        };
      }
      if (name === "ide/prepareMaintenance") {
        if ((options.activeSessions ?? 0) > 0) {
          return { accepted: false, reason: "active_sessions" };
        }
        if ((options.activeExecutions ?? 0) > 0) {
          return { accepted: false, reason: "active_operations" };
        }
        maintenanceFenced = true;
        return { accepted: true, maintenanceToken: "test-maintenance-token" };
      }
      if (name === "ide/completeMaintenance") {
        const sameGeneration =
          arguments_.pid === 1000 + daemonGeneration &&
          arguments_.startedAt === daemonGeneration &&
          arguments_.processGenerationToken === `test-generation-${daemonGeneration}`;
        if (sameGeneration) {
          maintenanceFenced = false;
          events.push(`maintenance-complete:${daemonGeneration}`);
        }
        return { completed: sameGeneration };
      }
      expect(name).toBe("daemon/releaseSession");
      const sessionId = arguments_.sessionId;
      expect(typeof sessionId).toBe("string");
      releaseAttempts.push(sessionId as string);
      if (sessionId === options.failReleaseFor) {
        throw new Error(`release failed for ${sessionId}`);
      }
      releases.push(sessionId as string);
      events.push(`release:${sessionId}`);
      return { released: true };
    },
    async close() {
      events.push("close:daemon");
      if (options.failDaemonClose) {
        throw new Error("daemon close failed");
      }
    },
  });

  return {
    calls,
    events,
    releases,
    releaseAttempts,
    cliCommands,
    evidence,
    timer,
    dependencies: {
      testOnly: true,
      timer,
      createMcpClient,
      createDaemonClient,
      async spawnCli(command) {
        cliCommands.push(command);
        if (options.failCliFor && command.includes(options.failCliFor)) {
          throw new Error(`CLI failed for ${options.failCliFor}`);
        }
        if (command.includes("acceptance-doctor-fault")) {
          pendingDoctorFault = command[command.indexOf("--fault") + 1];
          events.push(`fault:${pendingDoctorFault}`);
          return { stdout: "" };
        }
        if (command.includes("doctor")) {
          if (
            pendingDoctorFault !== "corrupt-control-metadata" &&
            pendingDoctorFault !== "missing-control-metadata"
          ) {
            daemonGeneration += 1;
            // A replacement daemon has no inherited maintenance admission.
            maintenanceFenced = false;
          }
          events.push(`doctor:${pendingDoctorFault}`);
          pendingDoctorFault = undefined;
          return { stdout: "" };
        }
        if (maintenanceFenced) {
          throw new Error("daemon maintenance fence rejected post-repair acquisition");
        }
        events.push("cli:acquire");
        const isIos = command.includes("getApple");
        cliAcquisitionCount += 1;
        return {
          stdout: JSON.stringify({
            structuredContent: {
              sessionUuid: `cli-acquired-${cliAcquisitionCount}`,
              deviceIdentity: isIos
                ? {
                    simulatorUdid: IOS_UDID,
                    simulatorName: options.iosSimulatorName ?? "iPhone 16 Pro",
                    iosServicePort: 8765,
                    iosRunnerGeneration: 0,
                  }
                : {
                    avdName: "Pixel_8_API_35",
                    adbSerial: androidTargetSerial,
                    emulatorConsolePort: Number(androidTargetSerial.slice("emulator-".length)),
                  },
            },
          }),
        };
      },
      async restartDaemon() {
        events.push("restart-daemon");
      },
      async restartAcceptanceSession(scope) {
        events.push(`restart-acceptance-session:${scope.sessionUuid}`);
        restartedSessionUuid = scope.sessionUuid;
      },
      writeFile:
        options.writeFile ??
        (async (_path, content) => {
          evidence.push(content);
        }),
    },
  };
}

function assertReadinessImmediatelyFollowsSuccess(harness: Harness, sessionUuid: string): void {
  const observe = harness.calls.findIndex(
    (call) => call.name === "observe" && call.arguments.sessionUuid === sessionUuid,
  );
  const state = harness.calls.findIndex(
    (call) => call.name === "getDeviceState" && call.arguments.sessionUuid === sessionUuid,
  );
  expect(observe).toBeGreaterThanOrEqual(0);
  expect(state).toBe(observe + 1);
}

describe("live device acceptance harness", () => {
  test("uses exact getAndroid acquisition, real killDevice objects, and session readiness", async () => {
    const harness = createHarness();

    const evidence = await runAcceptanceMatrix(androidArgs, harness.dependencies);

    const provision = harness.calls.find((call) => call.name === "provisionDevice");
    expect(provision?.arguments).toMatchObject({
      device: {
        platform: "android",
        name: "Pixel_8_API_35",
        spec: {
          runtime: "35",
          deviceType: "pixel_8",
          configuration: { memoryMb: 4096, cpuCores: 4 },
        },
      },
      enableTools: ["observe", "getDeviceState"],
    });
    expect(
      harness.calls
        .filter((call) => call.name === "setToolEnabled")
        .map((call) => ({ owner: call.owner, arguments: call.arguments })),
    ).toEqual([
      {
        owner: "provision",
        arguments: { toolName: "provisionDevice", enabled: true },
      },
      {
        owner: "persisted-target-absent-delete",
        arguments: { toolName: "deleteDevice", enabled: true },
      },
    ]);
    expect(
      harness.cliCommands.some(
        (command) =>
          command.slice(0, 5).join(" ") ===
            `${process.execPath} /test/dist/src/index.js --cli doctor --repair` &&
          command.at(-2) === "--timeout-ms" &&
          Number(command.at(-1)) > 0,
      ),
    ).toBe(true);
    const exactAcquisitions = harness.calls.filter(
      (call) => call.name === "getAndroid" && !call.owner.startsWith("controlled-discovery-"),
    );
    expect(exactAcquisitions.length).toBeGreaterThanOrEqual(6);
    expect(
      exactAcquisitions.slice(0, -1).every((call) => call.arguments.avdName === "Pixel_8_API_35"),
    ).toBe(true);
    expect(exactAcquisitions.at(-1)?.arguments).toEqual({
      avdName: "Pixel_8_Sibling",
      deviceId: "emulator-5558",
      enableTools: ["observe", "getDeviceState"],
    });
    expect(
      harness.calls.filter((call) => call.name === "startDevice").map((call) => call.arguments),
    ).toEqual([
      { platform: "android", avdName: "Pixel_8_API_35", preferRunning: true },
      {
        platform: "android",
        avdName: "Pixel_8_API_35",
        preferRunning: true,
        minOsVersion: "34",
      },
      {
        platform: "android",
        avdName: "Pixel_8_API_35",
        preferRunning: true,
        minOsVersion: "34",
        maxOsVersion: "35",
      },
      {
        platform: "android",
        avdName: "Pixel_8_API_35",
        preferRunning: true,
        minOsVersion: "9999",
      },
      {
        platform: "android",
        avdName: "Pixel_8_API_35",
        preferRunning: true,
        maxOsVersion: "0",
      },
      { platform: "android", avdName: "Pixel_8_API_35", preferRunning: true },
    ]);
    expect(harness.cliCommands.find((command) => command.includes("getAndroid"))).toEqual([
      process.execPath,
      "/test/dist/src/index.js",
      "--cli",
      "getAndroid",
      "--avd-name",
      "Pixel_8_API_35",
      "--enable-tools",
      '["observe","getDeviceState"]',
    ]);
    expect(
      harness.calls.find(
        (call) => call.owner === "independent-mcp" && call.name === "getDeviceState",
      )?.arguments,
    ).toEqual({ sessionUuid: "cli-acquired-1" });
    expect(
      harness.calls.find(
        (call) =>
          call.name === "killDevice" &&
          (call.arguments.device as Record<string, unknown>).deviceId === "emulator-5556",
      )?.arguments,
    ).toEqual({
      device: {
        name: "Pixel_8_API_35",
        deviceId: "emulator-5556",
        platform: "android",
      },
    });
    for (const sessionUuid of [
      "start-1",
      "start-2",
      "provision-1",
      "start-3",
      "start-4",
      "start-5",
      "start-6",
      "start-7",
      "cli-acquired-1",
      "start-8",
    ]) {
      assertReadinessImmediatelyFollowsSuccess(harness, sessionUuid);
    }
    expect(harness.releases).toContain("cli-acquired-1");
    expect(harness.releases).toContain("start-8");
    expect(new Set(harness.releases).size).toBe(harness.releases.length);
    expect(
      evidence.acquisitionRequests.some((entry) => {
        const request = entry.request as Record<string, unknown>;
        return "minOsVersion" in request && "maxOsVersion" in request;
      }),
    ).toBe(true);
    expect(evidence.checks).toMatchObject({
      stableIdentityPreserved: true,
      allMintedSessionsReleased: true,
      androidSerialChanged: true,
      androidConsolePortChanged: true,
      controlledDiscoveryPasses: true,
      controlledDiscoveryOrderDeterministicallyReversed: true,
      controlledSiblingUntouched: true,
      signedAndroidDuplicateRemoved: true,
      exactAndroidControlSelected: true,
      destructiveControlChecks: true,
    });
    expect(
      harness.calls.find(
        (call) =>
          call.name === "getAndroid" &&
          call.owner === "controlled-discovery-forward" &&
          (call.arguments.deviceId as string | undefined) === "emulator-5556",
      )?.arguments,
    ).toEqual({
      avdName: "Pixel_8_API_35",
      deviceId: "emulator-5556",
      enableTools: ["observe", "getDeviceState"],
    });
    expect(
      harness.calls.some(
        (call) =>
          call.name === "killDevice" &&
          (call.arguments.device as Record<string, unknown>).deviceId === "emulator-5554",
      ),
    ).toBe(true);
    expect(
      harness.calls.some(
        (call) =>
          call.name === "killDevice" &&
          (call.arguments.device as Record<string, unknown>).deviceId === "emulator-5558",
      ),
    ).toBe(false);
  });

  test("uses getApple for exact iOS readiness and UUID generic selectors for exact/min/max coverage", async () => {
    const harness = createHarness();
    const iosArgs: AcceptanceArgs = {
      ...androidArgs,
      platform: "ios",
      target: { simulatorName: "iPhone 16 Pro", simulatorUdid: IOS_UDID },
      runtime: "iOS 18.0",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
      osVersionRange: { min: "17.0", max: "18.0" },
      androidConfig: undefined,
    };

    const evidence = await runAcceptanceMatrix(iosArgs, harness.dependencies);

    expect(
      harness.calls.filter((call) => call.name === "startDevice").map((call) => call.arguments),
    ).toEqual([
      { platform: "ios", deviceId: IOS_UDID, preferRunning: true, formFactor: "phone" },
      {
        platform: "ios",
        deviceId: IOS_UDID,
        preferRunning: true,
        formFactor: "phone",
        minOsVersion: "17.0",
      },
      {
        platform: "ios",
        deviceId: IOS_UDID,
        preferRunning: true,
        formFactor: "phone",
        minOsVersion: "17.0",
        maxOsVersion: "18.0",
      },
      {
        platform: "ios",
        deviceId: IOS_UDID,
        preferRunning: true,
        formFactor: "phone",
        minOsVersion: "9999.0",
      },
      {
        platform: "ios",
        deviceId: IOS_UDID,
        preferRunning: true,
        formFactor: "phone",
        maxOsVersion: "0.0",
      },
      { platform: "ios", deviceId: IOS_UDID, preferRunning: true, formFactor: "tablet" },
      { platform: "ios", deviceId: IOS_UDID, preferRunning: true, formFactor: "phone" },
    ]);
    expect(harness.cliCommands.find((command) => command.includes("getApple"))).toEqual([
      process.execPath,
      "/test/dist/src/index.js",
      "--cli",
      "getApple",
      "--device-id",
      IOS_UDID,
      "--enable-tools",
      '["observe","getDeviceState"]',
    ]);
    expect(
      harness.calls.filter((call) => call.name === "getApple").map((call) => call.arguments),
    ).toEqual(
      expect.arrayContaining([
        { deviceId: IOS_UDID, enableTools: ["observe", "getDeviceState"] },
        {
          deviceId: "00000000-0000-0000-0000-000000000002",
          enableTools: ["observe", "getDeviceState"],
        },
      ]),
    );
    expect(harness.calls.find((call) => call.name === "provisionDevice")?.arguments).toMatchObject({
      device: { deviceId: IOS_UDID, name: "iPhone 16 Pro", platform: "ios" },
    });
    expect(
      evidence.runtimeIdentities.every((identity) => !("androidConsoleEndpoint" in identity)),
    ).toBe(true);
    expect(evidence.checks).toMatchObject({
      stableIdentityPreserved: true,
      iosServiceEndpointExposed: true,
      iosServiceEndpointChanged: true,
      iosRunnerGenerationExposed: true,
      iosRunnerGenerationChanged: true,
      iosRunnerIdentityChanged: true,
      controlledDiscoveryPasses: true,
      controlledDiscoveryOrderDeterministicallyReversed: true,
      controlledSiblingUntouched: true,
      exactIosUuidAndSameNameSiblingRetained: true,
      destructiveControlChecks: true,
    });
    const restart = harness.events.indexOf(`ios-runner-restart:${IOS_UDID}`);
    const reacquire = harness.events.indexOf("reacquire-after-ios-runner-restart:getApple");
    expect(restart).toBeGreaterThanOrEqual(0);
    expect(restart).toBeLessThan(reacquire);
    const restartedSession = harness.calls.find(
      (call) => call.owner === "reacquire-after-ios-runner-restart" && call.name === "getApple",
    )?.arguments.deviceId;
    expect(restartedSession).toBe(IOS_UDID);
    const restartedGetApple = harness.calls.find(
      (call) => call.owner === "reacquire-after-ios-runner-restart" && call.name === "getApple",
    );
    expect(restartedGetApple).toBeDefined();
    const restartedResponseSession = harness.calls
      .filter((call) => call.owner === "reacquire-after-ios-runner-restart")
      .find((call) => call.name === "observe")?.arguments.sessionUuid;
    expect(typeof restartedResponseSession).toBe("string");
    assertReadinessImmediatelyFollowsSuccess(harness, restartedResponseSession as string);
    expect(
      harness.calls.some(
        (call) =>
          call.name === "getApple" &&
          call.arguments.deviceId === "00000000-0000-0000-0000-000000000002",
      ),
    ).toBe(true);
    expect(
      harness.calls.some(
        (call) =>
          call.name === "killDevice" &&
          JSON.stringify(call.arguments).includes("00000000-0000-0000-0000-000000000002"),
      ),
    ).toBe(false);
    expect(
      evidence.acquisitionRequests.some((entry) => {
        const request = entry.request as Record<string, unknown>;
        return "minOsVersion" in request && "maxOsVersion" in request;
      }),
    ).toBe(true);
  });

  test("rejects iOS runner restart evidence when the CtrlProxy service port does not change", async () => {
    const harness = createHarness({ unchangedIosServicePort: true });

    await expect(runAcceptanceMatrix(iosArgs, harness.dependencies)).rejects.toThrow(
      "iOS CtrlProxy service port did not change across the required targeted restart",
    );
    expect(harness.events).toContain(`ios-runner-restart:${IOS_UDID}`);
  });

  test("preserves runner-generation proof and rejects an unchanged generation", async () => {
    const harness = createHarness({ unchangedIosRunnerGeneration: true });

    await expect(runAcceptanceMatrix(iosArgs, harness.dependencies)).rejects.toThrow(
      "iOS runner generation did not change across the required targeted restart",
    );
    expect(harness.events).toContain(`ios-runner-restart:${IOS_UDID}`);
  });

  test("rejects a changed iOS service port that is stale or occupied at readiness", async () => {
    const harness = createHarness({ failIosReadinessAfterRestart: true });

    await expect(runAcceptanceMatrix(iosArgs, harness.dependencies)).rejects.toThrow(
      "iOS CtrlProxy readiness failed after restart",
    );
    expect(harness.events).toContain(`ios-runner-restart:${IOS_UDID}`);
  });

  test("rejects iOS runner restart evidence when neither exposed identity changes", async () => {
    const harness = createHarness({ unchangedIosRunnerIdentity: true });

    const iosArgs: AcceptanceArgs = {
      ...androidArgs,
      platform: "ios",
      target: { simulatorName: "iPhone 16 Pro", simulatorUdid: IOS_UDID },
      runtime: "iOS 18.0",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
      osVersionRange: { min: "17.0", max: "18.0" },
      androidConfig: undefined,
    };

    await expect(runAcceptanceMatrix(iosArgs, harness.dependencies)).rejects.toThrow(
      "iOS runner generation did not change across the required targeted restart",
    );
    expect(harness.events).toContain(`ios-runner-restart:${IOS_UDID}`);
  });

  test("fails before mutation when the deterministic discovery-order seam is not honored", async () => {
    const harness = createHarness({ honorDiscoveryOrderSeam: false });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "Acceptance discovery-order seam did not present the same public discovery data in reverse",
    );
    expect(harness.calls.some((call) => call.name === "killDevice")).toBe(false);
    expect(harness.calls.some((call) => call.name === "provisionDevice")).toBe(false);
  });

  test("fails after signed duplicate cleanup when the duplicate or sibling control is not intact", async () => {
    const duplicateHarness = createHarness({ keepAndroidDuplicateAfterKill: true });

    await expect(runAcceptanceMatrix(androidArgs, duplicateHarness.dependencies)).rejects.toThrow(
      "Signed Android duplicate remained after its explicit cleanup",
    );
    expect(duplicateHarness.calls.filter((call) => call.name === "killDevice")).toHaveLength(1);
    expect(duplicateHarness.calls.some((call) => call.name === "provisionDevice")).toBe(false);

    const siblingHarness = createHarness({ removeAndroidSiblingAfterDuplicateCleanup: true });
    await expect(runAcceptanceMatrix(androidArgs, siblingHarness.dependencies)).rejects.toThrow(
      "Controlled Android sibling must appear exactly once",
    );
    expect(siblingHarness.calls.filter((call) => call.name === "killDevice")).toHaveLength(1);
    expect(siblingHarness.calls.some((call) => call.name === "provisionDevice")).toBe(false);
  });

  test("fails when an iOS same-name sibling disappears after a destructive target operation", async () => {
    const harness = createHarness({ removeIosSiblingAfterProvision: true });
    const iosArgs: AcceptanceArgs = {
      ...androidArgs,
      platform: "ios",
      target: { simulatorName: "iPhone 16 Pro", simulatorUdid: IOS_UDID },
      runtime: "iOS 18.0",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
      osVersionRange: { min: "17.0", max: "18.0" },
      androidConfig: undefined,
    };

    await expect(runAcceptanceMatrix(iosArgs, harness.dependencies)).rejects.toThrow(
      "Exact iOS UUID target and same-name sibling must remain the only two named controls",
    );
    expect(harness.calls.filter((call) => call.name === "killDevice")).toHaveLength(0);
    expect(
      harness.calls.some((call) =>
        JSON.stringify(call.arguments).includes("00000000-0000-0000-0000-000000000002"),
      ),
    ).toBe(false);
  });

  test("rejects overlapping ownership controls before connecting to a device", async () => {
    const harness = createHarness();

    await expect(
      runAcceptanceMatrix(
        {
          ...androidArgs,
          controls: { ...androidArgs.controls, androidSiblingAvdName: "Pixel_8_API_35" },
        },
        harness.dependencies,
      ),
    ).rejects.toThrow("Android ownership sibling must not use the target AVD name");
    expect(harness.calls).toHaveLength(0);
  });

  test("uses Windows ACLs while keeping POSIX mode checks fail-closed", () => {
    const directory = mkdtempSync(join(tmpdir(), "automobile-permissions-"));
    const file = join(directory, "operator.key");
    writeFileSync(file, "x".repeat(32));
    chmodSync(directory, 0o755);
    chmodSync(file, 0o644);
    try {
      expect(() => assertMode(directory, 0o700, "Evidence directory", "win32")).not.toThrow();
      expect(() => assertMode(file, 0o600, "Operator key", "win32")).not.toThrow();
      expect(() => assertMode(directory, 0o700, "Evidence directory", "linux")).toThrow(
        "Evidence directory must have mode 700",
      );
      expect(() => assertMode(file, 0o600, "Operator key", "linux")).toThrow(
        "Operator key must have mode 600",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses a signed manifest whose platform entries bind different control sets", () => {
    const directory = mkdtempSync(join(tmpdir(), "automobile-ownership-"));
    const operatorKeyPath = join(directory, "operator.key");
    const ownershipManifestPath = join(directory, "ownership.json");
    writeFileSync(operatorKeyPath, "x".repeat(32));
    chmodSync(operatorKeyPath, 0o600);
    try {
      const androidOwnershipArgs: AcceptanceArgs = {
        ...androidArgs,
        operatorKeyPath,
        ownershipManifestPath,
        operatorKey: Buffer.from("x".repeat(32)),
      };
      recordOwnershipManifest(androidOwnershipArgs);
      expect(() =>
        recordOwnershipManifest({
          ...androidOwnershipArgs,
          platform: "ios",
          target: { simulatorName: "iPhone 16 Pro", simulatorUdid: IOS_UDID },
          runtime: "iOS 18.0",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
          osVersionRange: { min: "17.0", max: "18.0" },
          androidConfig: undefined,
          controls: {
            ...androidArgs.controls,
            iosSameNameSiblingUdid: "00000000-0000-0000-0000-000000000003",
          },
        }),
      ).toThrow("already binds different discovery controls");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([
    [androidArgs, "Pixel_8_API_35", "getAndroid"],
    [iosArgs, IOS_UDID, "getApple"],
  ] as const)(
    "exercises exact busy and inventory-absent persisted recovery for both platforms",
    async (args, targetStableId, tool) => {
      const harness = createHarness();

      const evidence = await runAcceptanceMatrix(args, harness.dependencies);

      for (const reason of ["target-busy", "target-absent"]) {
        expect(
          harness.events.some((event) =>
            event.startsWith("restart-acceptance-session:cli-acquired-"),
          ),
        ).toBe(true);
        expect(harness.events).toContain(`persisted-${reason}-old-uuid:getDeviceState`);
        expect(
          harness.events.filter((event) => event === `persisted-${reason}-old-uuid:getDeviceState`),
        ).toHaveLength(2);
      }
      expect(
        harness.calls.some(
          (call) =>
            call.name === "deleteDevice" &&
            (call.arguments.target as Record<string, unknown>).stableId === targetStableId,
        ),
      ).toBe(true);
      expect(
        harness.calls.some(
          (call) =>
            call.name === "listDeviceImages" && call.owner === "controlled-discovery-forward",
        ),
      ).toBe(true);
      expect(harness.events).toContain(`reacquire-after-repair:${tool}`);
      if (args.platform === "ios") {
        const redact = (value: string): string =>
          `hmac-sha256:${createHmac(
            "sha256",
            Buffer.from("test-only-operator-key-material-32-bytes"),
          )
            .update(value)
            .digest("hex")
            .slice(0, 20)}`;
        expect(evidence.steps).toContainEqual(
          expect.objectContaining({
            name: redact("ios-same-transport-replacement-inapplicable"),
            detail: expect.objectContaining({
              deletionClassifiedAs: redact("target-absent"),
            }),
          }),
        );
      }
    },
  );

  test.each([androidArgs, iosArgs])(
    "fails if a persisted UUID would fall back to the signed sibling by discovery order",
    async (args) => {
      const harness = createHarness({ allowPersistedSiblingFallback: true });

      await expect(runAcceptanceMatrix(args, harness.dependencies)).rejects.toThrow(
        "must never bind the sibling",
      );
    },
  );

  test.each([
    { args: androidArgs, flag: "--android" },
    { args: iosArgs, flag: "--ios" },
  ])(
    "runs filtered post-repair doctor diagnostics before protocol verification and reacquisition",
    async ({ args, flag }) => {
      const harness = createHarness();

      const evidence = await runAcceptanceMatrix(args, harness.dependencies);
      const fault = harness.cliCommands.findIndex((command) =>
        command.includes("acceptance-doctor-fault"),
      );
      const doctor = harness.cliCommands.findIndex((command) => command.includes("doctor"));
      const doctorEvent = harness.events.findLastIndex((event) => event.startsWith("doctor:"));
      const protocolEvent = harness.events.findLastIndex((event) => event === "daemon:ide/status");

      expect(fault).toBeGreaterThanOrEqual(0);
      expect(doctor).toBeGreaterThan(fault);
      expect(doctorEvent).toBeGreaterThanOrEqual(0);
      expect(protocolEvent).toBeGreaterThan(doctorEvent);
      expect(harness.cliCommands[fault]).toEqual([
        process.execPath,
        "/test/dist/src/index.js",
        "--daemon",
        "acceptance-doctor-fault",
        "--fault",
        "corrupt-control-metadata",
        "--maintenance-token",
        "test-maintenance-token",
        "--expires-at",
        expect.any(String),
      ]);
      expect(
        harness.cliCommands
          .filter((command) => command.includes("acceptance-doctor-fault"))
          .map((command) => command[command.indexOf("--fault") + 1]),
      ).toEqual([
        "corrupt-control-metadata",
        "missing-control-metadata",
        "missing-socket",
        "stale-socket",
        "unresponsive-daemon",
        "missing-daemon",
        "dead-daemon",
      ]);
      expect(harness.events.filter((event) => event === "maintenance-complete:1")).toEqual([
        "maintenance-complete:1",
        "maintenance-complete:1",
      ]);
      expect(harness.cliCommands[doctor]).toContain(flag);
      expect(harness.events).toContain(
        `reacquire-after-repair:${args.platform === "android" ? "getAndroid" : "getApple"}`,
      );
      expect(harness.events).toContain("reacquire-after-repair:observe");
      expect(evidence.checks).toMatchObject({
        stableIdentityPreserved: true,
        readinessObserveThenState: true,
      });
    },
  );

  test("rejects a persisted recovery diagnostic that omits the exact recovery reason", async () => {
    const harness = createHarness({ oldSessionDiagnostic: "unknown session" });

    await expect(
      runAcceptanceMatrix({ ...androidArgs, scenario: "recovery" }, harness.dependencies),
    ).rejects.toThrow("did not report the exact old-session recovery reason");
  });

  test("rejects a generic unrelated-owner error instead of the product conflict diagnostic", async () => {
    const harness = createHarness({ ownerDiagnostic: "owned by another session" });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "Unexpected unrelated-owner diagnostic",
    );
    expect(harness.releases).toEqual([
      "start-1",
      "start-2",
      "provision-1",
      "start-3",
      "start-4",
      "start-5",
      "start-6",
      "start-7",
      "cli-acquired-1",
    ]);
  });

  test("fails a full acceptance when exposed Android serial or console identity does not change", async () => {
    const harness = createHarness({ unchangedAndroidIdentity: true });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "Android serial did not change across the required kill/reacquire transition",
    );
    expect(harness.releases).toEqual(["start-1", "start-2", "provision-1", "start-3", "start-4"]);
  });

  test("requires an exact resolved Android configuration", async () => {
    const harness = createHarness({ resolvedConfiguration: { memoryMb: 2048, cpuCores: 4 } });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "resolvedSpec.configuration did not exactly match",
    );
    expect(harness.releases).toEqual(["start-1", "start-2", "provision-1"]);
  });

  test("releases every minted session before clients close when readiness fails", async () => {
    const harness = createHarness({ failObserveFor: "start-2" });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "observe failed for start-2",
    );

    expect(harness.releases).toEqual(["start-1", "start-2"]);
    expect(harness.events.indexOf("release:start-2")).toBeLessThan(
      harness.events.findIndex((event) => event.startsWith("close:")),
    );
    expect(harness.events.filter((event) => event.startsWith("close:"))).toHaveLength(3);
    expect(harness.evidence[0]).not.toContain("start-2");
    const evidence = JSON.parse(harness.evidence[0]);
    expect(evidence.checks.readinessObserveThenState).toBe(false);
    expect(evidence.outcome.passed).toBe(false);
  });

  test("records false readiness evidence when no session reaches readiness", async () => {
    const evidence: string[] = [];

    await expect(
      runAcceptanceMatrix(androidArgs, {
        testOnly: true,
        timer: new FakeTimer(),
        createMcpClient: async () => {
          throw new Error("MCP unavailable");
        },
        createDaemonClient: async () => {
          throw new Error("should not create daemon client");
        },
        restartDaemon: async () => {},
        spawnCli: async () => ({ stdout: "" }),
        writeFile: async (_path, content) => {
          evidence.push(content);
        },
      }),
    ).rejects.toThrow("MCP unavailable");

    const written = JSON.parse(evidence[0]);
    expect(written.checks.readinessObserveThenState).toBe(false);
    expect(written.outcome.passed).toBe(false);
  });

  test("fails before iOS provisioning when the UUID resolves to a different display name", async () => {
    const harness = createHarness({ iosSimulatorName: "Someone Else's iPhone" });
    const iosArgs: AcceptanceArgs = {
      ...androidArgs,
      platform: "ios",
      target: { simulatorName: "iPhone 16 Pro", simulatorUdid: IOS_UDID },
      runtime: "iOS 18.0",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro",
      androidConfig: undefined,
    };

    await expect(runAcceptanceMatrix(iosArgs, harness.dependencies)).rejects.toThrow(
      "acquire returned simulator name Someone Else's iPhone",
    );
    expect(harness.calls.some((call) => call.name === "provisionDevice")).toBe(false);
  });

  test("fails acceptance and evidence when host-local doctor repair returns an error", async () => {
    const harness = createHarness({ failCliFor: "doctor" });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "CLI failed for doctor",
    );
    const evidence = JSON.parse(harness.evidence[0]);
    expect(evidence.outcome.passed).toBe(false);
  });

  test("refuses host-wide doctor repair when unrelated AutoMobile work is active", async () => {
    const harness = createHarness({ activeSessions: 1, activeExecutions: 0 });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "daemon maintenance admission rejected active_sessions",
    );
    expect(harness.cliCommands.some((command) => command.includes("doctor"))).toBe(false);
  });

  test("continues all cleanup paths after daemon release fails and redacts the recorded failure", async () => {
    const harness = createHarness({ failReleaseFor: "provision-1" });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "release failed for provision-1",
    );

    expect(harness.releaseAttempts).toEqual(["start-1", "start-2", "provision-1", "provision-1"]);
    expect(harness.events).toContain("close:daemon");
    expect(harness.events).toContain("close:provision");
    expect(harness.evidence[0]).not.toContain("provision-1");
    expect(harness.evidence[0]).not.toContain("release failed");
  });

  test("attempts every daemon and MCP close even when close cleanup fails", async () => {
    const harness = createHarness({
      failDaemonClose: true,
      failClientCloseFor: ["provision", "independent-mcp"],
    });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "Acceptance cleanup failed",
    );

    expect(harness.events).toContain("close:daemon");
    expect(harness.events.filter((event) => event.startsWith("close:")).length).toBeGreaterThan(16);
    expect(harness.evidence[0]).not.toContain("daemon close failed");
    expect(harness.evidence[0]).not.toContain("client close failed");
  });

  test("redacts targets, diagnostics, and session values from written evidence", async () => {
    const harness = createHarness();

    await runAcceptanceMatrix(androidArgs, harness.dependencies);

    expect(harness.evidence).toHaveLength(1);
    expect(harness.evidence[0]).not.toContain("Pixel_8_API_35");
    expect(harness.evidence[0]).not.toContain("emulator-5560");
    expect(harness.evidence[0]).not.toContain("start-3");
    expect(harness.evidence[0]).toContain("hmac-sha256:");
  });

  test("authenticates schema-8 evidence and rejects body, build, and manifest tampering", async () => {
    const fixture = createProductionAcceptanceFixture();
    const harness = createHarness({
      writeFile: async (path, content) => {
        writeFileSync(path, content, { mode: 0o600 });
        chmodSync(path, 0o600);
      },
    });
    const verification = {
      evidencePath: fixture.android.evidencePath,
      ownershipManifestPath: fixture.android.ownershipManifestPath,
      operatorKeyPath: fixture.android.operatorKeyPath,
      operatorKey: fixture.android.operatorKey,
      build: fixture.android.build,
    };
    try {
      const evidence = await runAcceptanceMatrix(fixture.android, harness.dependencies);
      expect(evidence.authentication.mac).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyEvidenceFile(verification).outcome.passed).toBe(true);

      const original = readFileSync(fixture.android.evidencePath, "utf8");
      for (const mutate of [
        (candidate: Record<string, unknown>) => {
          (candidate.outcome as Record<string, unknown>).passed = false;
        },
        (candidate: Record<string, unknown>) => {
          (candidate.checks as Record<string, unknown>).stableIdentityPreserved = false;
        },
      ]) {
        const tampered = JSON.parse(original) as Record<string, unknown>;
        mutate(tampered);
        writeFileSync(fixture.android.evidencePath, `${JSON.stringify(tampered)}\n`);
        chmodSync(fixture.android.evidencePath, 0o600);
        expect(() => verifyEvidenceFile(verification)).toThrow("Evidence authentication failed");
      }
      writeFileSync(fixture.android.evidencePath, original);
      chmodSync(fixture.android.evidencePath, 0o600);

      expect(() =>
        verifyEvidenceFile({
          ...verification,
          build: { ...fixture.android.build, buildId: "different-build" },
        }),
      ).toThrow("Evidence authentication binding does not match");

      const otherManifestPath = join(dirname(fixture.android.ownershipManifestPath), "other.json");
      const otherAndroid = { ...fixture.android, ownershipManifestPath: otherManifestPath };
      const otherIos = { ...fixture.ios, ownershipManifestPath: otherManifestPath };
      recordOwnershipManifest(otherAndroid);
      recordOwnershipManifest(otherIos);
      expect(() =>
        verifyEvidenceFile({
          ...verification,
          ownershipManifestPath: otherManifestPath,
        }),
      ).toThrow("Evidence authentication binding does not match");
    } finally {
      fixture.dispose();
    }
  });

  test("returns by the absolute deadline when an injected MCP connection ignores AbortSignal", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let aborted = false;
    const harness = createHarness();
    const createMcpClient = harness.dependencies.createMcpClient!;
    harness.dependencies.timer = timer;
    harness.dependencies.createMcpClient = async (owner, signal, presentationOrder) => {
      if (owner !== "provision") {
        return await createMcpClient(owner, signal, presentationOrder);
      }
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return await new Promise<McpSessionClient>(() => {});
    };
    const result = runAcceptanceMatrix({ ...androidArgs, timeoutMs: 100 }, harness.dependencies);

    await expect(
      Promise.race([
        result,
        Bun.sleep(500).then(() => {
          throw new Error("real outer bound elapsed");
        }),
      ]),
    ).rejects.toThrow("Acceptance deadline elapsed during provision MCP connect");
    expect(aborted).toBe(true);
    expect(timer.now()).toBeLessThanOrEqual(100);
  });

  test("returns by the deadline when a late session-bearing response ignores abort", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const harness = createHarness();
    const createMcpClient = harness.dependencies.createMcpClient!;
    const lateResponse = Promise.withResolvers<{ structuredContent: Record<string, unknown> }>();
    let aborted = false;
    let daemonConnections = 0;
    harness.dependencies.timer = timer;
    harness.dependencies.createMcpClient = async (owner, signal, presentationOrder) => {
      const client = await createMcpClient(owner, signal, presentationOrder);
      if (owner !== "controlled-discovery-forward") {
        return client;
      }
      return {
        async callTool(name, arguments_, callSignal) {
          if (name !== "getApple") {
            return await client.callTool(name, arguments_, callSignal);
          }
          callSignal?.addEventListener("abort", () => {
            aborted = true;
          });
          return await lateResponse.promise;
        },
        async close() {
          await client.close();
        },
      };
    };
    const createDaemonClient = harness.dependencies.createDaemonClient!;
    harness.dependencies.createDaemonClient = async (signal) => {
      daemonConnections++;
      return await createDaemonClient(signal);
    };

    const result = runAcceptanceMatrix({ ...iosArgs, timeoutMs: 100 }, harness.dependencies);
    await expect(result).rejects.toThrow(
      "Acceptance deadline elapsed during controlled-discovery-forward-exact-uuid-selection getApple",
    );
    expect(aborted).toBe(true);
    expect(timer.now()).toBeLessThanOrEqual(100);
    expect(daemonConnections).toBe(0);

    lateResponse.resolve({
      structuredContent: {
        sessionUuid: "late-session",
        deviceIdentity: {
          simulatorUdid: IOS_UDID,
          simulatorName: "iPhone 16 Pro",
          iosServicePort: 8765,
          iosRunnerGeneration: 0,
        },
      },
    });
    await Promise.resolve();
    expect(daemonConnections).toBe(0);
    expect(harness.releases).not.toContain("late-session");
  });

  test("uses the evidence reserve and abort signal so a late writer cannot turn timeout into success", async () => {
    const started = Promise.withResolvers<void>();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let lateSuccess = false;
    const harness = createHarness({
      writeFile: async (_path, _content, signal) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
        lateSuccess = !signal.aborted;
      },
    });
    harness.dependencies.timer = timer;

    const result = runAcceptanceMatrix({ ...androidArgs, timeoutMs: 100 }, harness.dependencies);
    const rejection = expect(result).rejects.toThrow(
      "Acceptance deadline elapsed during evidence write",
    );
    await started.promise;
    await rejection;
    expect(lateSuccess).toBe(false);
  });

  test("does not publish final evidence when the real writer observes an aborted deadline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "automobile-evidence-"));
    const path = join(directory, "evidence.json");
    const controller = new AbortController();
    writeFileSync(path, "previous");
    controller.abort(new Error("deadline"));
    try {
      await expect(defaultWriteEvidence(path, "late", controller.signal)).rejects.toThrow(
        "deadline",
      );
      expect(readFileSync(path, "utf8")).toBe("previous");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("publishes evidence atomically through the real writer before its deadline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "automobile-evidence-"));
    const path = join(directory, "evidence.json");
    try {
      await defaultWriteEvidence(path, "published", new AbortController().signal);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("published");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fences concurrent and late evidence writers without overwriting a final path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "automobile-evidence-"));
    const path = join(directory, "evidence.json");
    try {
      const results = await Promise.allSettled([
        defaultWriteEvidence(path, "first", new AbortController().signal),
        defaultWriteEvidence(path, "second", new AbortController().signal),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const published = readFileSync(path, "utf8");
      expect(["first", "second"]).toContain(published);

      await expect(
        defaultWriteEvidence(path, "late", new AbortController().signal),
      ).rejects.toThrow("refusing to overwrite");
      expect(readFileSync(path, "utf8")).toBe(published);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("requires driver-level live safeguards unless explicitly running injected test fakes", async () => {
    await expect(
      runAcceptanceMatrix(
        { ...androidArgs, confirmLive: false, testOwnedDevices: false },
        { timer: new FakeTimer() },
      ),
    ).rejects.toThrow(
      "Live mutation requires --confirm-live, --test-owned-devices, and AUTOMOBILE_ACCEPTANCE_LIVE=1.",
    );
  });

  test("keeps one wrapper scope while iOS reuses Android's resident daemon and restarts", async () => {
    const fixture = createProductionAcceptanceFixture();
    const previousLiveAcceptance = process.env[LIVE_ACCEPTANCE_ENV];
    const previousStartupSecret = process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const previousDiscoveryCapability = process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV];
    const wrapperStartupSecret = "wrapper-startup-secret-012345678901234567890";
    const wrapperDiscoveryCapability = "wrapper-discovery-capability-012345678901234";
    const scopeObservations: Array<{ source: string; startupSecret: string; capability: string }> =
      [];
    let residentDaemonStarts = 0;
    let residentDaemonScope: { startupSecret: string; capability: string } | undefined;

    const observeScope = (source: string): void => {
      const scope = {
        startupSecret: process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV],
        capability: process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV],
      };
      expect(scope.startupSecret).toBeDefined();
      expect(scope.capability).toBeDefined();
      if (residentDaemonScope === undefined) {
        residentDaemonStarts += 1;
        residentDaemonScope = scope as { startupSecret: string; capability: string };
      } else {
        expect(scope).toEqual(residentDaemonScope);
      }
      scopeObservations.push({
        source,
        startupSecret: scope.startupSecret!,
        capability: scope.capability!,
      });
    };

    const productionDependencies = (harness: Harness): MatrixDependencies => {
      const createMcpClient = harness.dependencies.createMcpClient!;
      const createDaemonClient = harness.dependencies.createDaemonClient!;
      const restartDaemon = harness.dependencies.restartDaemon!;
      const restartAcceptanceSession = harness.dependencies.restartAcceptanceSession!;
      return {
        ...harness.dependencies,
        testOnly: false,
        createMcpClient: async (owner, signal, presentationOrder) => {
          observeScope(`mcp:${owner}`);
          return await createMcpClient(owner, signal, presentationOrder);
        },
        createDaemonClient: async (signal) => {
          observeScope("daemon-client");
          return await createDaemonClient(signal);
        },
        restartDaemon: async (maintenanceToken, timeoutMs, signal) => {
          observeScope("daemon-restart");
          await restartDaemon(maintenanceToken, timeoutMs, signal);
        },
        restartAcceptanceSession: async (scope, timeoutMs, signal) => {
          observeScope("acceptance-session-restart");
          await restartAcceptanceSession(scope, timeoutMs, signal);
        },
      };
    };

    try {
      process.env[LIVE_ACCEPTANCE_ENV] = "1";
      process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = wrapperStartupSecret;
      process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV] = wrapperDiscoveryCapability;
      await runAcceptanceMatrix(
        { ...fixture.android, scenario: "recovery" },
        productionDependencies(createHarness()),
      );
      await runAcceptanceMatrix(
        { ...fixture.ios, scenario: "recovery" },
        productionDependencies(createHarness()),
      );

      expect(residentDaemonStarts).toBe(1);
      expect(
        scopeObservations.some(
          (observation) => observation.source === "acceptance-session-restart",
        ),
      ).toBe(true);
      expect(scopeObservations.map((observation) => observation.startupSecret)).toEqual(
        Array.from({ length: scopeObservations.length }, () => wrapperStartupSecret),
      );
      expect(scopeObservations.map((observation) => observation.capability)).toEqual(
        Array.from({ length: scopeObservations.length }, () => wrapperDiscoveryCapability),
      );
      expect(process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV]).toBe(wrapperStartupSecret);
      expect(process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV]).toBe(wrapperDiscoveryCapability);
    } finally {
      fixture.dispose();
      restoreEnvironmentVariable(LIVE_ACCEPTANCE_ENV, previousLiveAcceptance);
      restoreEnvironmentVariable(DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV, previousStartupSecret);
      restoreEnvironmentVariable(ACCEPTANCE_DISCOVERY_CAPABILITY_ENV, previousDiscoveryCapability);
    }
  });

  test("direct invocation replaces incomplete scope only for the matrix and restores caller values", async () => {
    const fixture = createProductionAcceptanceFixture();
    const previousLiveAcceptance = process.env[LIVE_ACCEPTANCE_ENV];
    const previousStartupSecret = process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const previousDiscoveryCapability = process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV];
    const callerDiscoveryCapability = "caller-discovery-capability-0123456789012345";
    let observedScope: { startupSecret: string; capability: string } | undefined;

    try {
      process.env[LIVE_ACCEPTANCE_ENV] = "1";
      delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
      process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV] = callerDiscoveryCapability;
      await expect(
        runAcceptanceMatrix(fixture.android, {
          testOnly: false,
          timer: new FakeTimer(),
          createMcpClient: async () => {
            observedScope = {
              startupSecret: process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV]!,
              capability: process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV]!,
            };
            throw new Error("stop after direct scope observation");
          },
          createDaemonClient: async () => {
            throw new Error("daemon client should not be created");
          },
          restartDaemon: async () => {},
          spawnCli: async () => ({ stdout: "" }),
          writeFile: async () => {},
        }),
      ).rejects.toThrow("stop after direct scope observation");

      expect(observedScope?.startupSecret).toHaveLength(36);
      expect(observedScope?.capability).toHaveLength(36);
      expect(observedScope?.capability).not.toBe(callerDiscoveryCapability);
      expect(process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV]).toBeUndefined();
      expect(process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV]).toBe(callerDiscoveryCapability);
    } finally {
      fixture.dispose();
      restoreEnvironmentVariable(LIVE_ACCEPTANCE_ENV, previousLiveAcceptance);
      restoreEnvironmentVariable(DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV, previousStartupSecret);
      restoreEnvironmentVariable(ACCEPTANCE_DISCOVERY_CAPABILITY_ENV, previousDiscoveryCapability);
    }
  });

  test("requires direct drivers to provide the owner-held key and built entrypoint", () => {
    expect(() =>
      parseArgs([
        "--platform",
        "ios",
        "--simulator-name",
        "iPhone 16 Pro",
        "--simulator-uuid",
        IOS_UDID,
        "--runtime",
        "iOS 18.0",
        "--device-type",
        "phone",
        "--min-os-version",
        "17.0",
        "--max-os-version",
        "18.0",
        "--scenario",
        "full",
        "--evidence",
        "scratch/evidence.json",
        "--timeout-ms",
        "1000",
        "--confirm-live",
        "--test-owned-devices",
      ]),
    ).toThrow("Missing required --operator-key-file");
  });
});
