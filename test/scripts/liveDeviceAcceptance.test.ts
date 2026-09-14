import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  parseArgs,
  runAcceptanceMatrix,
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
const androidArgs: AcceptanceArgs = {
  platform: "android",
  target: { avdName: "Pixel_8_API_35" },
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

function oldSessionDiagnostic(sessionUuid: string): string {
  return (
    `Session ${sessionUuid} is not an active daemon session (not found). ` +
    "Acquire a device with getAndroid or getApple before using its sessionUuid."
  );
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
    writeFile?: MatrixDependencies["writeFile"];
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

  const createMcpClient = async (owner: string): Promise<McpSessionClient> => ({
    async callTool(name, arguments_) {
      calls.push({ owner, name, arguments: arguments_ });
      events.push(`${owner}:${name}`);
      if (name === "provisionDevice") {
        const device = arguments_.device as Record<string, unknown>;
        const spec = device.spec as Record<string, unknown>;
        const isIos = device.platform === "ios";
        return {
          structuredContent: {
            sessionUuid: "provision-1",
            device: {
              name: device.name,
              deviceId: isIos ? IOS_UDID : "emulator-5554",
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
        if (owner === "unrelated-owner") {
          const deviceId =
            name === "getApple" || arguments_.platform === "ios"
              ? IOS_UDID
              : `emulator-${5554 + startCount * 2}`;
          return {
            isError: true,
            structuredContent: { error: options.ownerDiagnostic ?? ownerDiagnostic(deviceId) },
          };
        }
        startCount += 1;
        const sessionUuid = `start-${startCount}`;
        if (name === "getApple" || arguments_.platform === "ios") {
          return {
            structuredContent: {
              sessionUuid,
              deviceIdentity: {
                simulatorUdid: IOS_UDID,
                simulatorName: options.iosSimulatorName ?? "iPhone 16 Pro",
              },
            },
          };
        }
        const port = options.unchangedAndroidIdentity ? 5556 : 5554 + startCount * 2;
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
        if (arguments_.sessionUuid === options.failObserveFor) {
          throw new Error(`observe failed for ${options.failObserveFor}`);
        }
        return { structuredContent: { tree: [] } };
      }
      if (name === "getDeviceState") {
        if (owner === "old-session") {
          return {
            isError: true,
            structuredContent: {
              error:
                options.oldSessionDiagnostic ??
                oldSessionDiagnostic(String(arguments_.sessionUuid)),
            },
          };
        }
        return { structuredContent: { state: "ready" } };
      }
      if (name === "killDevice") {
        return { structuredContent: { killed: true } };
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
        events.push(
          command.includes("doctor") ? `doctor:${command.join(" ")}` : "cli:getDeviceState",
        );
      },
      async restartDaemon() {
        events.push("restart-daemon");
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
    expect(harness.cliCommands).toContainEqual(["auto-mobile", "--cli", "doctor", "--repair"]);
    const exactAcquisitions = harness.calls.filter((call) => call.name === "getAndroid");
    expect(exactAcquisitions.map((call) => call.arguments)).toEqual([
      { avdName: "Pixel_8_API_35", enableTools: ["observe", "getDeviceState"] },
      { avdName: "Pixel_8_API_35", enableTools: ["observe", "getDeviceState"] },
      { avdName: "Pixel_8_API_35", enableTools: ["observe", "getDeviceState"] },
    ]);
    expect(
      harness.calls.filter((call) => call.name === "startDevice").map((call) => call.arguments),
    ).toEqual([
      { platform: "android", name: "Pixel_8_API_35", preferRunning: true },
      {
        platform: "android",
        name: "Pixel_8_API_35",
        preferRunning: true,
        minOsVersion: "34",
      },
      {
        platform: "android",
        name: "Pixel_8_API_35",
        preferRunning: true,
        maxOsVersion: "35",
      },
      { platform: "android", name: "Pixel_8_API_35", preferRunning: true },
    ]);
    expect(harness.calls.find((call) => call.name === "killDevice")?.arguments).toEqual({
      device: {
        name: "Pixel_8_API_35",
        deviceId: "emulator-5556",
        platform: "android",
      },
    });
    for (const sessionUuid of [
      "provision-1",
      "start-1",
      "start-2",
      "start-3",
      "start-4",
      "start-5",
      "start-6",
    ]) {
      assertReadinessImmediatelyFollowsSuccess(harness, sessionUuid);
    }
    expect(harness.releases).toEqual([
      "provision-1",
      "start-1",
      "start-2",
      "start-3",
      "start-4",
      "start-5",
      "start-6",
    ]);
    expect(evidence.checks).toMatchObject({
      stableIdentityPreserved: true,
      allMintedSessionsReleased: true,
      androidSerialChanged: true,
      androidConsolePortChanged: true,
    });
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
      { platform: "ios", deviceId: IOS_UDID, preferRunning: true },
      { platform: "ios", deviceId: IOS_UDID, preferRunning: true, minOsVersion: "17.0" },
      { platform: "ios", deviceId: IOS_UDID, preferRunning: true, maxOsVersion: "18.0" },
      { platform: "ios", deviceId: IOS_UDID, preferRunning: true },
    ]);
    expect(
      harness.calls.filter((call) => call.name === "getApple").map((call) => call.arguments),
    ).toEqual([
      { deviceId: IOS_UDID, enableTools: ["observe", "getDeviceState"] },
      { deviceId: IOS_UDID, enableTools: ["observe", "getDeviceState"] },
      { deviceId: IOS_UDID, enableTools: ["observe", "getDeviceState"] },
      { deviceId: IOS_UDID, enableTools: ["observe", "getDeviceState"] },
    ]);
    expect(harness.calls.find((call) => call.name === "provisionDevice")?.arguments).toMatchObject({
      device: { deviceId: IOS_UDID, name: "iPhone 16 Pro", platform: "ios" },
    });
    expect(
      evidence.runtimeIdentities.every((identity) => !("androidConsoleEndpoint" in identity)),
    ).toBe(true);
    expect(evidence.checks).toMatchObject({
      stableIdentityPreserved: true,
      iosServiceEndpointExposed: false,
      iosServiceEndpointChanged: false,
    });
  });

  test("keeps the held session live through restart and requires the terminal diagnostic", async () => {
    const harness = createHarness();

    await runAcceptanceMatrix({ ...androidArgs, scenario: "recovery" }, harness.dependencies);

    const restart = harness.events.indexOf("restart-daemon");
    const oldSession = harness.events.indexOf("old-session:getDeviceState");
    const release = harness.events.indexOf("release:start-5");
    expect(restart).toBeLessThan(oldSession);
    expect(oldSession).toBeLessThan(release);
    expect(harness.events).toContain("reacquire-after-repair:getAndroid");
  });

  test("rejects a generic error instead of the required old-session diagnostic", async () => {
    const harness = createHarness({ oldSessionDiagnostic: "unknown session" });

    await expect(
      runAcceptanceMatrix({ ...androidArgs, scenario: "recovery" }, harness.dependencies),
    ).rejects.toThrow("Old session did not return the required terminal diagnostic");
    expect(harness.releases).toContain("start-5");
  });

  test("rejects a generic unrelated-owner error instead of the product conflict diagnostic", async () => {
    const harness = createHarness({ ownerDiagnostic: "owned by another session" });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "Unexpected unrelated-owner diagnostic",
    );
    expect(harness.releases).toEqual([
      "provision-1",
      "start-1",
      "start-2",
      "start-3",
      "start-4",
      "start-5",
    ]);
  });

  test("fails a full acceptance when exposed Android serial or console identity does not change", async () => {
    const harness = createHarness({ unchangedAndroidIdentity: true });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "Android serial did not change across the required kill/reacquire transition",
    );
    expect(harness.releases).toEqual(["provision-1", "start-1", "start-2"]);
  });

  test("requires an exact resolved Android configuration", async () => {
    const harness = createHarness({ resolvedConfiguration: { memoryMb: 2048, cpuCores: 4 } });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "resolvedSpec.configuration did not exactly match",
    );
    expect(harness.releases).toEqual(["provision-1"]);
  });

  test("releases every minted session before clients close when readiness fails", async () => {
    const harness = createHarness({ failObserveFor: "start-1" });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "observe failed for start-1",
    );

    expect(harness.releases).toEqual(["provision-1", "start-1"]);
    expect(harness.events.indexOf("release:start-1")).toBeLessThan(
      harness.events.findIndex((event) => event.startsWith("close:")),
    );
    expect(harness.events.filter((event) => event.startsWith("close:"))).toHaveLength(3);
    expect(harness.evidence[0]).not.toContain("start-1");
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
        spawnCli: async () => {},
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

  test("continues all cleanup paths after daemon release fails and redacts the recorded failure", async () => {
    const harness = createHarness({ failReleaseFor: "provision-1" });

    await expect(runAcceptanceMatrix(androidArgs, harness.dependencies)).rejects.toThrow(
      "release failed for provision-1",
    );

    expect(harness.releaseAttempts).toEqual(["provision-1", "provision-1"]);
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
    expect(harness.events.filter((event) => event.startsWith("close:"))).toHaveLength(10);
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
    expect(harness.evidence[0]).toContain("hash:");
  });

  test("uses FakeTimer to reject a stalled MCP connection before it can report success", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const connecting = Promise.withResolvers<McpSessionClient>();
    const result = runAcceptanceMatrix(
      { ...androidArgs, timeoutMs: 100 },
      {
        testOnly: true,
        timer,
        createMcpClient: async () => await connecting.promise,
        createDaemonClient: async () => {
          throw new Error("should not create daemon client");
        },
        restartDaemon: async () => {},
        spawnCli: async () => {},
        writeFile: async () => {},
      },
    );

    const rejection = expect(result).rejects.toThrow(
      "Acceptance deadline elapsed during provision MCP connect",
    );
    await rejection;
    connecting.resolve({
      callTool: async () => ({ structuredContent: {} }),
      close: async () => {},
    });
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

  test("parses separate iOS name and UUID plus direct-driver safeguards", () => {
    const args = parseArgs([
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
    ]);
    expect(args).toMatchObject({
      target: { simulatorName: "iPhone 16 Pro", simulatorUdid: IOS_UDID },
      confirmLive: true,
      testOwnedDevices: true,
    });
  });
});
