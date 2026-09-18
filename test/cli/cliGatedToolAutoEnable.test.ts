import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import {
  runCliCommand,
  setDaemonProxyFactoryForTesting,
  resetDaemonProxyFactoryForTesting,
} from "../../src/cli";
import {
  cliToolSelectionProfilePath,
  ensureCliToolSelectionProfileStoreWritable,
  resetCliToolSelectionProfileLockOptionsForTesting,
  persistCliToolSelectionProfile,
  setCliToolSelectionProfileLockOptionsForTesting,
  withCliToolSelectionProfileLock,
} from "../../src/cli/cliToolSelectionProfile";
import { ActionableError } from "../../src/models";
import { isolateCliDataDir, type IsolatedCliDataDir } from "../helpers/cliDataDirIsolation";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * A `--cli` invocation is a trusted local operator action and must NEVER require a
 * separate `setToolEnabled` step. The CLI transparently enables a gated tool
 * (`defaultEnabled: false`, e.g. `deleteDevice`) before the call using one stable
 * profile per CLI data directory.
 */
describe("CLI transparently enables gated tools", () => {
  let isolatedCliDataDir: IsolatedCliDataDir;

  beforeEach(() => {
    isolatedCliDataDir = isolateCliDataDir("cli-tool-selection-profile-");
  });

  afterEach(() => {
    resetDaemonProxyFactoryForTesting();
    resetCliToolSelectionProfileLockOptionsForTesting();
    isolatedCliDataDir.restore();
  });

  function recordProxy(
    calls: Array<{ name: string; params: unknown }>,
    callToolOverride?: (name: string, params: Record<string, unknown>) => Promise<any>,
    callOrder?: Array<{ kind: "callTool" | "setProfile"; value?: unknown }>,
  ) {
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async (name: string, params: unknown): Promise<any> => {
        calls.push({ name, params });
        callOrder?.push({ kind: "callTool", value: { name, params } });
        if (callToolOverride) {
          return callToolOverride(name, params as Record<string, unknown>);
        }
        if (name === "setToolEnabled") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sessionUuid: "11111111-1111-4111-8111-111111111111",
                  scope: "connection-profile",
                }),
              },
            ],
          };
        }
        return { content: [{ type: "text", text: "{}" }] };
      },
      setToolSelectionProfileUuid: (profileUuid: string | undefined): void => {
        callOrder?.push({ kind: "setProfile", value: profileUuid });
      },
      adoptCliSessionLiveness: async (): Promise<string | undefined> => "session-cli",
      close: async (): Promise<void> => {},
    }));
  }

  test("enables a gated tool (deleteDevice) before calling it, with no manual setToolEnabled", async () => {
    const calls: Array<{ name: string; params: unknown }> = [];
    recordProxy(calls);

    await runCliCommand([
      "deleteDevice",
      "--operationId",
      "00000000-0000-4000-8000-000000000abc",
      "--mode",
      "destroy",
      "--verifyAbsence",
      "true",
      "--target",
      JSON.stringify({ platform: "android", isVirtual: true, stableId: "does-not-exist" }),
    ]);

    const names = calls.map((c) => c.name);
    expect(names).toContain("setToolEnabled");
    expect(names).toContain("deleteDevice");
    // The enable must precede the gated call so daemon enforcement passes.
    expect(names.indexOf("setToolEnabled")).toBeLessThan(names.indexOf("deleteDevice"));
    const enable = calls.find((c) => c.name === "setToolEnabled");
    expect(enable?.params).toMatchObject({ toolName: "deleteDevice", enabled: true });
  });

  test("enables a gated tool (provisionDevice) before calling it", async () => {
    const calls: Array<{ name: string; params: unknown }> = [];
    recordProxy(calls);

    await runCliCommand([
      "provisionDevice",
      "--operationId",
      "00000000-0000-4000-8000-000000000abc",
      "--device",
      JSON.stringify({
        platform: "android",
        name: "test-avd",
        spec: { runtime: "android-35", deviceType: "pixel_6" },
      }),
    ]);

    const names = calls.map((c) => c.name);
    expect(names).toContain("setToolEnabled");
    expect(names).toContain("provisionDevice");
    expect(names.indexOf("setToolEnabled")).toBeLessThan(names.indexOf("provisionDevice"));
    const enable = calls.find((c) => c.name === "setToolEnabled");
    expect(enable?.params).toMatchObject({ toolName: "provisionDevice", enabled: true });
  });

  test("enables getIosSimulatorCapabilities and forwards a supplied session UUID only", async () => {
    const callsWithoutSession: Array<{ name: string; params: unknown }> = [];
    recordProxy(callsWithoutSession);

    await runCliCommand([
      "getIosSimulatorCapabilities",
      "--deviceType",
      "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      "--runtime",
      "iOS-18-0",
    ]);

    const namesWithoutSession = callsWithoutSession.map((call) => call.name);
    expect(namesWithoutSession.indexOf("setToolEnabled")).toBeLessThan(
      namesWithoutSession.indexOf("getIosSimulatorCapabilities"),
    );
    const capabilitiesWithoutSession = callsWithoutSession.find(
      (call) => call.name === "getIosSimulatorCapabilities",
    );
    expect(capabilitiesWithoutSession?.params).toEqual({
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      runtime: "iOS-18-0",
    });

    const callsWithSession: Array<{ name: string; params: unknown }> = [];
    recordProxy(callsWithSession);
    await runCliCommand([
      "--session-uuid",
      "11111111-1111-4111-8111-111111111111",
      "getIosSimulatorCapabilities",
      "--deviceType",
      "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      "--runtime",
      "iOS-18-0",
    ]);

    const namesWithSession = callsWithSession.map((call) => call.name);
    expect(namesWithSession.indexOf("setToolEnabled")).toBeLessThan(
      namesWithSession.indexOf("getIosSimulatorCapabilities"),
    );
    expect(
      callsWithSession.find((call) => call.name === "getIosSimulatorCapabilities")?.params,
    ).toEqual({
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      runtime: "iOS-18-0",
      sessionUuid: "11111111-1111-4111-8111-111111111111",
    });
  });

  test("enables a gated tool (resetAppLogs) before calling it", async () => {
    const calls: Array<{ name: string; params: unknown }> = [];
    recordProxy(calls);

    await runCliCommand([
      "resetAppLogs",
      "--appId",
      "com.example.app",
      "--paths",
      JSON.stringify(["logs/app.log"]),
      "--platform",
      "android",
    ]);

    const names = calls.map((c) => c.name);
    expect(names).toContain("setToolEnabled");
    expect(names).toContain("resetAppLogs");
    expect(names.indexOf("setToolEnabled")).toBeLessThan(names.indexOf("resetAppLogs"));
    const enable = calls.find((c) => c.name === "setToolEnabled");
    expect(enable?.params).toMatchObject({ toolName: "resetAppLogs", enabled: true });
  });

  test("enables a gated tool (stageSessionDownloads) before calling it", async () => {
    const calls: Array<{ name: string; params: unknown }> = [];
    recordProxy(calls);

    await runCliCommand([
      "stageSessionDownloads",
      "--sessionUuid",
      "00000000-0000-4000-8000-000000000abc",
      "--directory",
      "fixtures",
      "--files",
      JSON.stringify([{ destinationPath: "hello.txt", contentText: "hello" }]),
    ]);

    const names = calls.map((c) => c.name);
    expect(names).toContain("setToolEnabled");
    expect(names).toContain("stageSessionDownloads");
    expect(names.indexOf("setToolEnabled")).toBeLessThan(names.indexOf("stageSessionDownloads"));
    const enable = calls.find((c) => c.name === "setToolEnabled");
    expect(enable?.params).toMatchObject({
      toolName: "stageSessionDownloads",
      enabled: true,
    });
  });

  test("reuses one minted profile across separate CLI invocations", async () => {
    const calls: Array<{ name: string; params: unknown }> = [];
    recordProxy(calls);

    await runCliCommand(["listDevices", "--platform", "android"]);
    expect(calls[0]).toMatchObject({ name: "setToolEnabled", params: { toolName: "listDevices" } });
    expect(calls[0].params).not.toHaveProperty("sessionUuid");
    expect(calls[1].name).toBe("listDevices");

    const secondCalls: Array<{ name: string; params: unknown }> = [];
    recordProxy(secondCalls);
    await runCliCommand(["listDevices", "--platform", "android"]);

    expect(secondCalls[0]).toMatchObject({
      name: "setToolEnabled",
      params: {
        toolName: "listDevices",
        sessionUuid: "11111111-1111-4111-8111-111111111111",
      },
    });
    expect(secondCalls[1].name).toBe("listDevices");
  });

  test("concurrent first CLI invocations mint one profile and reaffirm it", async () => {
    const timer = new FakeTimer();
    setCliToolSelectionProfileLockOptionsForTesting({ timer, pollIntervalMs: 1, timeoutMs: 10 });
    const mintStarted = Promise.withResolvers<void>();
    const allowMint = Promise.withResolvers<void>();
    let minted = 0;
    const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async (name: string, params: Record<string, unknown>): Promise<any> => {
        calls.push({ name, params });
        if (name !== "setToolEnabled") {
          return { content: [{ type: "text", text: "{}" }] };
        }
        if (!params.sessionUuid) {
          minted += 1;
          if (minted === 1) {
            mintStarted.resolve();
            await allowMint.promise;
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sessionUuid: "77777777-7777-4777-8777-777777777777",
                  scope: "connection-profile",
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sessionUuid: params.sessionUuid,
                scope: "connection-profile",
              }),
            },
          ],
        };
      },
      adoptCliSessionLiveness: async (): Promise<string | undefined> => "session-cli",
      close: async (): Promise<void> => {},
    }));

    const first = runCliCommand(["listDevices", "--platform", "android"]);
    await mintStarted.promise;
    const second = runCliCommand(["listDevices", "--platform", "android"]);
    expect(timer.getPendingSleeps()).toEqual([1]);

    allowMint.resolve();
    await first;
    timer.advanceTime(1);
    await Promise.all([first, second]);

    expect(minted).toBe(1);
    expect(calls.filter((call) => call.name === "setToolEnabled")).toEqual([
      { name: "setToolEnabled", params: { toolName: "listDevices", enabled: true } },
      {
        name: "setToolEnabled",
        params: {
          toolName: "listDevices",
          enabled: true,
          sessionUuid: "77777777-7777-4777-8777-777777777777",
        },
      },
    ]);
    expect(fs.readFileSync(cliToolSelectionProfilePath(process.env), "utf8")).toBe(
      "77777777-7777-4777-8777-777777777777",
    );
  });

  test("does not mint an unlocked profile when the profile lock wait times out", async () => {
    const timer = new FakeTimer();
    setCliToolSelectionProfileLockOptionsForTesting({ timer, pollIntervalMs: 1, timeoutMs: 3 });
    const releaseHeldLock = Promise.withResolvers<void>();
    const heldLock = withCliToolSelectionProfileLock(async () => {
      await releaseHeldLock.promise;
    });
    await Promise.resolve();
    const calls: Array<{ name: string; params: unknown }> = [];
    recordProxy(calls);

    const command = runCliCommand(["listDevices", "--platform", "android"]);
    await Promise.resolve();
    expect(timer.getPendingSleeps()).toEqual([1]);
    timer.advanceTime(3);
    await command;

    expect(calls.map((call) => call.name)).toEqual(["listDevices"]);
    releaseHeldLock.resolve();
    await heldLock;
  });

  test("does not mint a second profile when a concurrent first mint outlives the lock wait", async () => {
    const timer = new FakeTimer();
    setCliToolSelectionProfileLockOptionsForTesting({ timer, pollIntervalMs: 1, timeoutMs: 3 });
    const mintStarted = Promise.withResolvers<void>();
    const releaseMint = Promise.withResolvers<void>();
    const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async (name: string, params: Record<string, unknown>): Promise<any> => {
        calls.push({ name, params });
        if (name !== "setToolEnabled") {
          return { content: [{ type: "text", text: "{}" }] };
        }
        mintStarted.resolve();
        await releaseMint.promise;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sessionUuid: "88888888-8888-4888-8888-888888888888",
                scope: "connection-profile",
              }),
            },
          ],
        };
      },
      adoptCliSessionLiveness: async (): Promise<string | undefined> => "session-cli",
      close: async (): Promise<void> => {},
    }));

    const first = runCliCommand(["listDevices", "--platform", "android"]);
    await mintStarted.promise;
    const second = runCliCommand(["listDevices", "--platform", "android"]);
    expect(timer.getPendingSleeps()).toEqual([1]);

    timer.advanceTime(3);
    await second;
    expect(calls.filter((call) => call.name === "setToolEnabled")).toHaveLength(1);

    releaseMint.resolve();
    await first;
    expect(calls.filter((call) => call.name === "setToolEnabled")).toHaveLength(1);
  });

  test("does not pre-enable hidden production tools", async () => {
    const calls: Array<{ name: string; params: unknown }> = [];
    recordProxy(calls);

    await runCliCommand(["startDevice", "--platform", "android"]);

    expect(calls.map((call) => call.name)).toEqual(["startDevice"]);
  });

  test("pre-enables a default-enabled tool disabled by effective startup config", async () => {
    const calls: Array<{ name: string; params: unknown }> = [];
    const enabledTools = new Set<string>();
    recordProxy(calls, async (name, params) => {
      if (name === "setToolEnabled") {
        enabledTools.add(String(params.toolName));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                sessionUuid: "11111111-1111-4111-8111-111111111111",
                scope: "connection-profile",
              }),
            },
          ],
        };
      }
      if (name === "listDevices" && !enabledTools.has("listDevices")) {
        throw new Error("listDevices is disabled");
      }
      return { content: [{ type: "text", text: "{}" }] };
    });

    await runCliCommand(["listDevices", "--platform", "android"]);

    const names = calls.map((c) => c.name);
    expect(names).toEqual(["setToolEnabled", "listDevices"]);
    expect(calls[0].params).toMatchObject({ toolName: "listDevices", enabled: true });
  });

  test("fails before minting when the profile store cannot create its profile file", async () => {
    const profilePath = cliToolSelectionProfilePath(process.env);
    fs.mkdirSync(profilePath, { mode: 0o700 });
    const calls: Array<{ name: string; params: unknown }> = [];
    recordProxy(calls);
    expect(() => ensureCliToolSelectionProfileStoreWritable()).toThrow(ActionableError);

    const originalProcessExit = process.exit;
    const originalConsoleError = console.error;
    const exitCodes: number[] = [];
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0);
    }) as typeof process.exit;
    console.error = (() => {}) as typeof console.error;
    try {
      await runCliCommand(["listDevices", "--platform", "android"]);
    } finally {
      process.exit = originalProcessExit;
      console.error = originalConsoleError;
    }

    expect(exitCodes).toEqual([1]);
    expect(calls).toHaveLength(0);
  });

  test("reaffirms a valid persisted profile even when its file is read-only", async () => {
    const persistedProfileUuid = "55555555-5555-4555-8555-555555555555";
    persistCliToolSelectionProfile(persistedProfileUuid);
    fs.chmodSync(cliToolSelectionProfilePath(process.env), 0o400);
    const calls: Array<{ name: string; params: unknown }> = [];
    const callOrder: Array<{ kind: "callTool" | "setProfile"; value?: unknown }> = [];
    recordProxy(
      calls,
      async (name, params) => {
        if (name === "setToolEnabled") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sessionUuid: persistedProfileUuid,
                  scope: "connection-profile",
                }),
              },
            ],
          };
        }
        return { content: [{ type: "text", text: "{}" }] };
      },
      callOrder,
    );

    await runCliCommand(["listDevices", "--platform", "android"]);

    expect(calls[0]).toMatchObject({
      name: "setToolEnabled",
      params: { sessionUuid: persistedProfileUuid },
    });
    expect(callOrder.slice(0, 2)).toEqual([
      { kind: "setProfile", value: persistedProfileUuid },
      {
        kind: "callTool",
        value: {
          name: "setToolEnabled",
          params: { toolName: "listDevices", enabled: true, sessionUuid: persistedProfileUuid },
        },
      },
    ]);
  });

  test("re-mints when the persisted profile is stale/rejected by the daemon", async () => {
    const staleProfileUuid = "33333333-3333-4333-8333-333333333333";
    const freshProfileUuid = "22222222-2222-4222-8222-222222222222";
    persistCliToolSelectionProfile(staleProfileUuid);
    const calls: Array<{ name: string; params: unknown }> = [];
    const callOrder: Array<{ kind: "callTool" | "setProfile"; value?: unknown }> = [];
    recordProxy(
      calls,
      async (name, params) => {
        if (name === "setToolEnabled" && params.sessionUuid === staleProfileUuid) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "sessionUuid must identify this connection's active tool-selection or routing session profile.",
              },
            ],
          };
        }
        if (name === "setToolEnabled") {
          expect(params).not.toHaveProperty("sessionUuid");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sessionUuid: freshProfileUuid,
                  scope: "connection-profile",
                }),
              },
            ],
          };
        }
        return { content: [{ type: "text", text: "{}" }] };
      },
      callOrder,
    );

    await runCliCommand(["listDevices", "--platform", "android"]);

    expect(calls.map((call) => call.name)).toEqual([
      "setToolEnabled",
      "setToolEnabled",
      "listDevices",
    ]);
    expect(calls[0].params).toMatchObject({ sessionUuid: staleProfileUuid });
    expect(calls[1].params).not.toHaveProperty("sessionUuid");
    expect(callOrder).toEqual([
      { kind: "setProfile", value: staleProfileUuid },
      {
        kind: "callTool",
        value: {
          name: "setToolEnabled",
          params: { toolName: "listDevices", enabled: true, sessionUuid: staleProfileUuid },
        },
      },
      { kind: "setProfile", value: undefined },
      {
        kind: "callTool",
        value: { name: "setToolEnabled", params: { toolName: "listDevices", enabled: true } },
      },
      { kind: "callTool", value: { name: "listDevices", params: { platform: "android" } } },
    ]);
    expect(fs.readFileSync(cliToolSelectionProfilePath(process.env), "utf8")).toBe(
      freshProfileUuid,
    );
  });

  test("treats a corrupted persisted profile file as absent and mints fresh", async () => {
    const freshProfileUuid = "44444444-4444-4444-8444-444444444444";
    persistCliToolSelectionProfile("not-a-uuid");
    const calls: Array<{ name: string; params: unknown }> = [];
    recordProxy(calls, async (name, params) => {
      if (name === "setToolEnabled") {
        expect(params).not.toHaveProperty("sessionUuid");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ sessionUuid: freshProfileUuid, scope: "connection-profile" }),
            },
          ],
        };
      }
      return { content: [{ type: "text", text: "{}" }] };
    });

    await runCliCommand(["listDevices", "--platform", "android"]);

    expect(calls.map((call) => call.name)).toEqual(["setToolEnabled", "listDevices"]);
    expect(calls[0].params).not.toHaveProperty("sessionUuid");
    expect(fs.readFileSync(cliToolSelectionProfilePath(process.env), "utf8")).toBe(
      freshProfileUuid,
    );
  });
});
