import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { toJSONSchema, z } from "zod/v4";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { registerMcpTools } from "../../src/server";
import { ToolRegistry, type RegisteredTool } from "../../src/server/toolRegistry";
import { withAndroidTransportId } from "../../src/utils/androidSerial";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../src/utils/debug";
import { createExecResult } from "../../src/utils/execResult";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { RealToolCallPath } from "../helpers/realToolCallPath";

/**
 * #11618 follow-up: EVERY path that takes a caller-supplied device id resolves it through the one
 * resolver entry point (`resolveToolCallDeviceIds`) before anything judges, routes or queues the
 * call, and an id a failed adb listing could not place never fails open. The real MCP server in daemon mode over
 * an in-memory transport (what the daemon's HTTP endpoint runs, with no socket server in front of
 * it), the real `ToolRegistry`, `DevicePool` and alias fold; only adb, discovery and the device
 * boundary are fakes.
 */

const USB = "R5CT1234ABC";
const KNOWN_ALIAS = "adb-R5CT1234ABC-AbCdEf._adb-tls-connect._tcp";
const HOLDER = "holder-session";
const HOLDER_CONNECTION = "holder-connection";
const STRANGER_CONNECTION = "stranger-connection";
/** The server connection of a caller that forwards no connection identity. */
const SESSIONLESS = "";

const booted = (deviceId: string): BootedDevice =>
  withAndroidTransportId(
    { deviceId, name: deviceId, platform: "android" },
    `transport-${deviceId}`,
  );

/** A plain tool takes a device id when its input schema names one; a device-aware tool always does. */
function deviceIdShape(tool: RegisteredTool): "top-level" | "nested" | undefined {
  if (tool.requiresDevice) {
    return "top-level";
  }
  const schema = toJSONSchema(tool.schema, { io: "input", unrepresentable: "any" }) as {
    properties?: Record<string, { properties?: Record<string, unknown> }>;
  };
  if (schema.properties?.deviceId) {
    return "top-level";
  }
  return schema.properties?.device?.properties?.deviceId ? "nested" : undefined;
}

const namesDeviceId = (deviceId: string, shape: "top-level" | "nested") =>
  shape === "nested"
    ? { device: { name: "Phone", deviceId, platform: "android" } }
    : { platform: "android", deviceId };

/** Every registered tool that accepts a device id, enumerated from the production registry. */
function toolsTakingDeviceId(): Array<{ name: string; shape: "top-level" | "nested" }> {
  return ToolRegistry.getEveryRegisteredTool()
    .flatMap((tool) => {
      const shape = deviceIdShape(tool);
      return shape ? [{ name: tool.name, shape }] : [];
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

// The table's rows, read from the registry the server registers (sqlQuery is embedded-SDK only).
const embeddedSdkBefore = serverConfig.isEmbeddedSdkEnabled();
serverConfig.setEmbeddedSdkEnabled(true);
ToolRegistry.clearTools();
registerMcpTools(true);
const TOOLS = toolsTakingDeviceId();
ToolRegistry.clearTools();
serverConfig.setEmbeddedSdkEnabled(embeddedSdkBefore);

const CALLERS = [
  ["holder", { [INTERNAL_MCP_SESSION_PARAM]: HOLDER_CONNECTION }],
  ["non-holder", { [INTERNAL_MCP_SESSION_PARAM]: STRANGER_CONNECTION }],
  ["sessionless", {}],
] as const;

interface DaemonOptions {
  /** The Android rows discovery lists when the pool first refreshes. */
  pooledRows: BootedDevice[];
  /** HOLDER acquires this device from HOLDER_CONNECTION; none when omitted. */
  held?: string;
  iosRows?: BootedDevice[];
}

interface Daemon {
  timer: FakeTimer;
  sessions: SessionManager;
  pool: DevicePool;
  discovery: FakeDeviceUtils;
  adbFactory: FakeAdbClientFactory;
  tools: RealToolCallPath;
  /** The tools the running server registered that accept a device id, read before any stubbing. */
  registered: ReturnType<typeof toolsTakingDeviceId>;
  /** Arguments each stubbed plain handler received, in order. */
  plainCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** HOLDER holds its device again, after a tool whose own work ended the session (executePlan). */
  hold(): Promise<void>;
  /** Discovery starts listing `rows`, as when wireless debugging is switched on. */
  connect(rows: BootedDevice[]): void;
  /** One `tools/call` through the real server: the typed refusal code, the error text, or "ran". */
  call(name: string, args: Record<string, unknown>): Promise<string>;
  /** The same call's wire payload: the JSON a refusal carries. */
  wire(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** How many raw `adb devices` listings tool calls have asked for (never the pool's own). */
  listings(): number;
  close(): Promise<void>;
}

/** The device a call reached: a device-aware body's device, or the id a plain handler was given. */
function reached(daemon: Daemon): string {
  const run = daemon.tools.runs.at(-1);
  const plain = daemon.plainCalls.at(-1)?.args;
  const nested = plain?.device as { deviceId?: string } | undefined;
  return run?.deviceId ?? nested?.deviceId ?? (plain?.deviceId as string | undefined) ?? "nothing";
}

async function daemon(options: DaemonOptions): Promise<Daemon> {
  const timer = new FakeTimer();
  const discovery = new FakeDeviceUtils();
  discovery.setBootedDevices("android", options.pooledRows);
  discovery.setBootedDevices("ios", options.iosRows ?? []);
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("getprop ro.serialno", createExecResult(USB, ""));
  adb.setCommandResponse("boot_id", createExecResult("phone-boot", ""));
  adb.setCommandResponse("getprop ro.kernel.qemu", createExecResult("0", ""));
  const adbFactory = new FakeAdbClientFactory(adb);
  PlatformDeviceManagerFactory.setInstance(discovery);
  const sessions = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  sessions.stopCleanupTimer();
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "device-id-all-paths", {
      timer,
      deviceManager: discovery,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      androidAdbFactory: adbFactory,
    }),
  );
  await pool.refreshDevices();
  DaemonState.getInstance().initialize(sessions, pool, new DeviceSessionRegistry(timer));
  const tools = new RealToolCallPath([...options.pooledRows, ...(options.iosRows ?? [])]).install();
  const readinessScan = (rows: BootedDevice[]) =>
    tools.deviceSessionManager.setConnectedDevices([
      ...pool.mapAndroidReadinessDiscovery(rows),
      ...(options.iosRows ?? []),
    ]);
  readinessScan(options.pooledRows);
  const registryTimer: unknown = Reflect.get(ToolRegistry, "timer");
  Reflect.set(ToolRegistry, "timer", timer);
  const hold = async (): Promise<void> => {
    if (!options.held || sessions.getSessionForDevice(options.held) === HOLDER) {
      return;
    }
    await pool.bindOrReuseDeviceSession(
      HOLDER,
      options.held,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      HOLDER_CONNECTION,
    );
    sessions.setDeviceReadiness(HOLDER, "automationReady");
    // Keep-awake is device work behind its own adb seam; mark it settled for this session.
    sessions.getSession(HOLDER)!.cacheData.keepScreenAwake = {
      applied: false,
      skipReason: "failed",
    };
  };
  await hold();
  // One server connection per caller, as each client of the daemon has: a connection routes its
  // unnamed calls to the session it last ran on, so callers must not share one. All are opened
  // before the stubbing below, because creating a server registers the real tools again.
  const connections = new Map<string, McpTestFixture>();
  for (const caller of [HOLDER_CONNECTION, STRANGER_CONNECTION, SESSIONLESS]) {
    const fixture = new McpTestFixture({ daemonMode: true });
    await fixture.setup();
    connections.set(caller, fixture);
  }
  // The server registered its real tools. A tool's argument schema is not under test (the table
  // names only a device), and a plain tool's handler is its device work: accept any arguments and
  // record what a plain handler was handed, so only the ingress and the resolver are real.
  const plainCalls: Daemon["plainCalls"] = [];
  const registered = toolsTakingDeviceId();
  for (const { name } of registered) {
    const tool = ToolRegistry.getRegisteredTool(name)!;
    tool.schema = z.object({}).passthrough();
    if (!tool.requiresDevice) {
      tool.handler = async (args: Record<string, unknown>) => {
        plainCalls.push({ name: tool.name, args });
        return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
      };
    }
  }
  ToolRegistry.registerDeviceAware(
    "controlProbe",
    "Control probe",
    z.object({}).passthrough(),
    async () => ({ success: true }),
  );
  ToolRegistry.registerDeviceAware(
    "readProbe",
    "Read probe",
    z.object({}).passthrough(),
    async () => ({ success: true }),
    { deviceReadOnly: true },
  );
  // The pool's own refresh listed devices while this daemon started.
  const listingsBeforeAnyCall = discovery.getBootedDevicesDetailedCalls().length;
  return {
    timer,
    sessions,
    pool,
    discovery,
    adbFactory,
    tools,
    registered,
    plainCalls,
    hold,
    connect(rows) {
      discovery.setBootedDevices("android", rows);
      readinessScan(rows);
    },
    async call(name, args) {
      const { [INTERNAL_MCP_SESSION_PARAM]: caller, ...planArgs } = args;
      if (ToolRegistry.getRegisteredTool(name)?.planOnly) {
        // A plan-only tool is no `tools/call`: it is reached as a plan step, an internal call
        // that runs on the plan's session (the holder's) or on none.
        return ToolRegistry.callInternal(name, planArgs, undefined, undefined, {
          forPlan: true,
          ...(caller === HOLDER_CONNECTION ? { sessionUuid: HOLDER } : {}),
        }).then(
          () => "ran",
          (error: unknown) => {
            const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
            return typeof code === "string" ? code : String(error);
          },
        );
      }
      const fixture = connections.get(typeof caller === "string" ? caller : SESSIONLESS)!;
      const result = await fixture.client.callTool({ name, arguments: args });
      if (!result.isError) {
        return "ran";
      }
      const text = (result.content as Array<{ text: string }>)[0].text;
      try {
        const wire = JSON.parse(text) as { code?: string; error?: string };
        return wire.code ?? wire.error ?? text;
      } catch {
        return text;
      }
    },
    async wire(name, args) {
      const result = await connections.get(SESSIONLESS)!.client.callTool({ name, arguments: args });
      return JSON.parse((result.content as Array<{ text: string }>)[0].text) as Record<
        string,
        unknown
      >;
    },
    listings: () =>
      discovery
        .getBootedDevicesDetailedCalls()
        .slice(listingsBeforeAnyCall)
        .filter((listing) => listing.platform === "android").length,
    async close() {
      for (const fixture of connections.values()) {
        await fixture.teardown();
      }
      Reflect.set(ToolRegistry, "timer", registryTimer);
      PlatformDeviceManagerFactory.setInstance(null);
      tools.uninstall();
      DaemonState.getInstance().reset();
      sessions.stopCleanupTimer();
      timer.reset();
    },
  };
}

let spies: Array<ReturnType<typeof spyOn>> = [];
let previousAutolock: string | undefined;
let previousDebugMode = false;

beforeAll(async () => {
  // Debug-only tools take a device id like any other, and must be callable to be judged.
  previousDebugMode = isDebugModeEnabled();
  setDebugModeEnabled(true);
  previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
  delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
  spies = [
    spyOn(logger, "info").mockImplementation(() => {}),
    spyOn(logger, "warn").mockImplementation(() => {}),
    spyOn(logger, "error").mockImplementation(() => {}),
  ];
  // Pay the server module's cold import outside any test's budget.
  const restore = installHermeticServerFixture();
  const warm = new McpTestFixture({ daemonMode: true });
  await warm.setup();
  await warm.teardown();
  restore();
});

afterAll(() => {
  setDebugModeEnabled(previousDebugMode);
  for (const spy of spies) {
    spy.mockRestore();
  }
  if (previousAutolock !== undefined) {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
  }
});

describe("every tool that takes a device id decides the same for any id of the device", () => {
  let d: Daemon;
  let firstSeen = 0;
  /** A wireless address of the held handset that no call and no pool refresh has named yet. */
  const neverSeenAlias = (): string => {
    const alias = `192.168.7.${++firstSeen}:5555`;
    d.connect([booted(USB), booted(KNOWN_ALIAS), booted(alias)]);
    return alias;
  };
  /** The call's outcome and the device it reached, as one comparable decision. */
  const decide = async (name: string, args: Record<string, unknown>): Promise<string> => {
    await d.hold();
    d.tools.runs.length = 0;
    d.plainCalls.length = 0;
    const outcome = await d.call(name, args);
    return `${outcome} on ${reached(d)}`;
  };

  beforeAll(async () => {
    d = await daemon({ pooledRows: [booted(USB), booted(KNOWN_ALIAS)], held: USB });
  });

  afterAll(async () => {
    await d.close();
  });

  test("the table is every registered tool that accepts a device id", () => {
    expect(TOOLS).toEqual(d.registered);
    expect(TOOLS.length).toBeGreaterThan(60);
    // The plain tools: no execution-target resolver ever sees their arguments.
    expect(
      TOOLS.filter((tool) => !ToolRegistry.getRegisteredTool(tool.name)?.requiresDevice)
        .map((tool) => tool.name)
        .toSorted(),
    ).toEqual(["getAndroid", "getApple", "killDevice", "setActiveDevice", "startDevice"]);
  });

  describe.each(CALLERS)("called by the %s", (caller, identity) => {
    test.each(TOOLS)("$name", async ({ name, shape }) => {
      const tool = ToolRegistry.getRegisteredTool(name)!;
      const args = (deviceId: string) => ({ ...namesDeviceId(deviceId, shape), ...identity });
      if (tool.isDeviceReadOnlyCall?.(args(USB)) === true) {
        // A read's body is real device code here; its id is resolved by the same entry point,
        // from the pool's cached fold alone: never refused, never probed.
        const listings = d.listings();
        const unseen = neverSeenAlias();
        expect(ToolRegistry.resolveToolCallDeviceIds(tool, args(KNOWN_ALIAS))).toEqual(args(USB));
        expect(ToolRegistry.resolveToolCallDeviceIds(tool, args(unseen))).toEqual(args(unseen));
        expect(d.listings()).toBe(listings);
        return;
      }

      const byCanonical = await decide(name, args(USB));
      const byKnownAlias = await decide(name, args(KNOWN_ALIAS));
      const byNeverSeenAlias = await decide(name, args(neverSeenAlias()));

      expect([byKnownAlias, byNeverSeenAlias]).toEqual([byCanonical, byCanonical]);
      if (tool.requiresDevice && caller === "holder") {
        // The holder is never refused its own device, and a body that runs, runs on the pooled
        // device (a tool that resolves no device fails on its own arguments instead).
        expect(byCanonical).not.toContain(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
        expect(byCanonical).toEndWith(byCanonical.startsWith("ran") ? ` on ${USB}` : " on nothing");
      } else if (tool.requiresDevice) {
        // A held device runs a control tool only for its holder, whichever id names it.
        expect(byCanonical).toBe(`${DEVICE_OWNED_BY_OTHER_SESSION_CODE} on nothing`);
      } else {
        // A plain tool's own handler judges the device: it must be handed the pool's id.
        expect(byCanonical).toBe(`ran on ${USB}`);
      }
    });
  });
});

describe("a client that reaches the daemon's MCP server directly (#11618)", () => {
  let d: Daemon | undefined;
  afterEach(async () => {
    await d?.close();
    d = undefined;
  });

  test("a plain tool is handed the pool's id for an alias no socket server resolved", async () => {
    d = await daemon({ pooledRows: [booted(USB), booted(KNOWN_ALIAS)], held: USB });
    const stranger = { [INTERNAL_MCP_SESSION_PARAM]: STRANGER_CONNECTION };

    await d.call("killDevice", { ...namesDeviceId(KNOWN_ALIAS, "nested"), ...stranger });
    await d.call("setActiveDevice", { ...namesDeviceId(KNOWN_ALIAS, "top-level"), ...stranger });

    // The handlers' own holder checks are keyed on the pool's id: they must never see the alias.
    expect(d.plainCalls.map(({ name, args }) => [name, args.deviceId ?? args.device])).toEqual([
      ["killDevice", { name: "Phone", deviceId: USB, platform: "android" }],
      ["setActiveDevice", USB],
    ]);
  });

  test("killDevice naming a held phone by a wireless id nothing has seen yet is handed the pool's id", async () => {
    d = await daemon({ pooledRows: [booted(USB)], held: USB });
    const unseen = "192.168.1.20:5555";
    d.connect([booted(USB), booted(unseen)]);

    await d.call("killDevice", namesDeviceId(unseen, "nested"));

    expect(d.plainCalls.map(({ args }) => args.device)).toEqual([
      { name: "Phone", deviceId: USB, platform: "android" },
    ]);
    expect(d.pool.getAndroidTransportAliases(USB)).toEqual([unseen]);
  });
});

describe("a failed adb listing never fails open (#11618)", () => {
  const UNSEEN = "192.168.1.20:5555";
  let d: Daemon | undefined;
  afterEach(async () => {
    await d?.close();
    d = undefined;
  });

  /** A held phone whose wireless address no pool refresh has seen, while `adb devices` fails. */
  const heldPhoneWhileAdbFails = async (): Promise<Daemon> => {
    const started = await daemon({ pooledRows: [booted(USB)], held: USB });
    // Readiness still lists the phone on both transports; only the raw adb listing fails.
    started.connect([booted(USB), booted(UNSEEN)]);
    started.discovery.setAndroidDiscoveryIncomplete("adb devices timed out");
    return started;
  };

  test("a control call naming an address the pool cannot place is refused, and is not use", async () => {
    d = await heldPhoneWhileAdbFails();
    const before = { ...d.sessions.getSession(HOLDER)! };
    d.timer.advanceTime(5_000);

    const sessionless = await d.call("controlProbe", { platform: "android", deviceId: UNSEEN });
    const stranger = await d.call("controlProbe", {
      deviceId: UNSEEN,
      [INTERNAL_MCP_SESSION_PARAM]: STRANGER_CONNECTION,
    });
    const plain = await d.call("killDevice", namesDeviceId(UNSEEN, "nested"));

    expect([sessionless, stranger, plain]).toEqual(Array(3).fill("discovery_incomplete"));
    expect(d.tools.runs).toEqual([]);
    expect(d.plainCalls).toEqual([]);
    expect(d.tools.deviceSessionManager.getEnsureDeviceReadyCallCount()).toBe(0);
    expect(d.sessions.getSession(HOLDER)!.lastUsedAt).toBe(before.lastUsedAt);
    expect(d.sessions.getSession(HOLDER)!.expiresAt).toBe(before.expiresAt);
    expect(d.sessions.getSessionForDevice(USB)).toBe(HOLDER);
  });

  test("the refusal is typed and retryable on the wire", async () => {
    d = await heldPhoneWhileAdbFails();

    const refusal = await d.wire("controlProbe", { platform: "android", deviceId: UNSEEN });

    expect(refusal).toMatchObject({ code: "discovery_incomplete", retryable: true });
  });

  test("the holder keeps its phone by the pool's id while adb fails, and reads still answer", async () => {
    d = await heldPhoneWhileAdbFails();

    const holder = await d.call("controlProbe", {
      deviceId: USB,
      [INTERNAL_MCP_SESSION_PARAM]: HOLDER_CONNECTION,
    });
    const read = await d.call("readProbe", { platform: "android", deviceId: UNSEEN });

    expect([holder, read]).toEqual(["ran", "ran"]);
    expect(d.tools.runs.map((run) => run.name)).toEqual(["controlProbe", "readProbe"]);
    // Neither asked adb for a listing: a canonical id and a read never depend on the probe.
    expect(d.listings()).toBe(0);
  });

  test("the refusal is not remembered: the first call after adb recovers is judged as the phone", async () => {
    d = await heldPhoneWhileAdbFails();
    const call = () => d!.call("controlProbe", { platform: "android", deviceId: UNSEEN });

    expect([await call(), await call()]).toEqual(Array(2).fill("discovery_incomplete"));
    // Each refusal asked adb once, at the ingress, and went no further.
    expect(d.listings()).toBe(2);

    d.discovery.failedPlatforms.delete("android");
    expect(await call()).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(d.pool.getAndroidTransportAliases(USB)).toEqual([UNSEEN]);
  });

  test("a host with no Android device in the pool is refused nothing for an adb failure", async () => {
    const simulator: BootedDevice = { deviceId: "IOS-UDID-1", name: "iPhone", platform: "ios" };
    d = await daemon({ pooledRows: [], iosRows: [simulator] });
    // No adb on this host: its listing never completes.
    d.discovery.setAndroidDiscoveryIncomplete("adb is not installed");

    const ios = await d.call("controlProbe", { platform: "ios", deviceId: "IOS-UDID-1" });
    const untyped = await d.call("controlProbe", { deviceId: "IOS-UDID-1" });
    const address = await d.call("controlProbe", { platform: "android", deviceId: UNSEEN });

    expect([ios, untyped]).toEqual(["ran", "ran"]);
    expect(address).not.toBe("discovery_incomplete");
    expect(d.tools.runs.map((run) => run.deviceId)).toEqual(["IOS-UDID-1", "IOS-UDID-1"]);
  });
});

describe("a control call naming a transport address the pool has never seen (#11618)", () => {
  let d: Daemon | undefined;
  afterEach(async () => {
    await d?.close();
    d = undefined;
  });

  test("an address a completed listing does not contain is not refused, and folds nothing", async () => {
    d = await daemon({ pooledRows: [booted(USB)], held: USB });

    const outcome = await d.call("controlProbe", {
      platform: "android",
      deviceId: "192.168.1.99:5555",
    });

    expect(outcome).not.toBe("discovery_incomplete");
    expect(outcome).not.toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(d.pool.getAndroidTransportAliases(USB)).toEqual([]);
  });

  test("a cancelled request stops waiting for a listing that hangs", async () => {
    d = await daemon({ pooledRows: [booted(USB)], held: USB });
    d.discovery.setBootedDevicesDetailedHangs("android", true);
    const request = new AbortController();
    const cancelled = new Error("request cancelled");

    const resolved = Promise.resolve(
      ToolRegistry.resolveToolCallDeviceIds(
        ToolRegistry.getRegisteredTool("controlProbe")!,
        { platform: "android", deviceId: "192.168.1.99:5555" },
        request.signal,
      ),
    ).catch((error: unknown) => error);
    request.abort(cancelled);

    expect(await resolved).toBe(cancelled);
  });
});
