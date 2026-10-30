import { beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ExecutionTracker } from "../../../../src/daemon/executionTracker";
import { TextRequestState } from "../../../../src/features/action/textTransportTimeout";
import type { CallContext } from "../../../../src/server/pipeline/ingress/callContext";
import {
  admitNamedSession,
  bindActiveDeviceResult,
} from "../../../../src/server/pipeline/ingress/bindSession";
import {
  buildHandlerParams,
  type InvocationPlan,
} from "../../../../src/server/pipeline/ingress/invoke";
import {
  routeDeviceSession,
  routeViaAutolock,
  type ResolvedTool,
  type RoutingScope,
} from "../../../../src/server/pipeline/ingress/routing";
import {
  SessionToolBinding,
  type DeviceSessionRouting,
} from "../../../../src/server/SessionToolBinding";
import { ToolRegistry } from "../../../../src/server/toolRegistry";
import { SELECTS_ACTIVE_DEVICE } from "../../../../src/server/toolRegistryTypes";
import { registerUtilityTools } from "../../../../src/server/utilityTools";
import { InMemoryToolSelectionProfileRegistry } from "../../../../src/daemon/InMemoryToolSelectionProfileRegistry";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { isolateToolRegistry } from "../../../helpers/withTemporaryTool";

// Pins how the ingress stages treat the active-device selection tool (`setActiveDevice`, from its
// real registration) against a device control tool, a device read and a plain tool (#15664).
// Routing and bind order encode security decisions, so these expectations must not drift.

isolateToolRegistry();

const DEVICE_CONTROL = "activeDeviceStagesDeviceControl";
const DEVICE_READ = "activeDeviceStagesDeviceRead";
const PLAIN = "activeDeviceStagesPlain";
const READ_ONLY_SELECTION = "activeDeviceStagesReadOnlySelection";

beforeAll(() => {
  registerUtilityTools();
  const schema = z.object({ sessionUuid: z.string().optional() });
  const ok = async () => ({ content: [{ type: "text" as const, text: "{}" }] });
  ToolRegistry.registerDeviceAware(DEVICE_CONTROL, "control", schema, ok);
  ToolRegistry.registerDeviceAware(DEVICE_READ, "read", schema, ok, { deviceReadOnly: true });
  ToolRegistry.register(PLAIN, "plain", schema, ok);
  ToolRegistry.register(READ_ONLY_SELECTION, "selection", schema, ok, {
    readOnly: true,
    ...SELECTS_ACTIVE_DEVICE,
  });
});

function toolNamed(name: string): ResolvedTool {
  const tool = ToolRegistry.getTool(name);
  if (!tool) {
    throw new Error(`tool ${name} is not registered`);
  }
  return tool;
}

const context: CallContext = {
  requestMcpSessionId: undefined,
  requestOneShotCli: false,
  requestedToolResultsNoStructuredContent: undefined,
  requestedActionsCompactMetadata: undefined,
  requestTimeoutMs: undefined,
  requestDeadlineMs: undefined,
  requestLiveDeadlineKey: undefined,
  requestAcceptanceDiscoveryOrder: undefined,
};

type ResolveCall = {
  selectingActiveDevice: boolean | undefined;
  deferForeignDevice: boolean | undefined;
  readOnly: boolean | undefined;
};

/** Records the routing flags each call hands the connection binding. */
class RecordingBinding extends SessionToolBinding {
  readonly resolveCalls: ResolveCall[] = [];
  readonly bindCalls: Array<[string | undefined, string | undefined]> = [];

  constructor() {
    super(undefined, undefined, new FakeIdGenerator());
  }

  override resolveDeviceSessionUuid(
    mcpSessionId: string | undefined,
    params: Record<string, unknown>,
    lookup: (sessionUuid: string) => { deviceId: string; platform: string } | undefined,
    { selectingActiveDevice, deferForeignDevice, readOnly }: DeviceSessionRouting = {},
  ): string | undefined {
    this.resolveCalls.push({ selectingActiveDevice, deferForeignDevice, readOnly });
    return "binding-routed";
  }

  override bind(mcpSessionId: string | undefined, sessionUuid: string | undefined): boolean {
    this.bindCalls.push([mcpSessionId, sessionUuid]);
    return true;
  }
}

function scopeFor(name: string, binding: RecordingBinding): RoutingScope {
  return {
    name,
    tool: toolNamed(name),
    toolParams: { deviceId: "emulator-5554" },
    sessionId: "mcp-1",
    daemonMode: false,
    context,
    sessionToolBinding: binding,
    implicitAutolockMcpSessionId: undefined,
  };
}

function planFor(
  name: string,
  binding: RecordingBinding,
  overrides: Partial<InvocationPlan> = {},
): InvocationPlan {
  const tracker = new ExecutionTracker(new FakeTimer(), new FakeIdGenerator());
  const parsedParams = { sessionUuid: "named-session" };
  return {
    name,
    tool: toolNamed(name),
    toolParams: parsedParams,
    parsedParams,
    sessionId: "mcp-1",
    bindingKey: undefined,
    context,
    options: {},
    sessionToolBinding: binding,
    execution: tracker.startExecution(name),
    implicitAutolockMcpSessionId: undefined,
    routingSessionUuid: "routed-session",
    handlerRoutingSessionUuid: undefined,
    routingBaseSessionUuid: undefined,
    labelSessionUuids: [],
    connectionProfileUuid: undefined,
    actionsCompactMetadata: false,
    providedSessionUuid: "named-session",
    executionSessionUuid: undefined,
    textState: new TextRequestState(),
    getRequestDeadlineMs: () => undefined,
    requestSignal: undefined,
    progress: undefined,
    ...overrides,
  };
}

describe("device routing", () => {
  test("setActiveDevice routes through the binding as an active-device selection, never deferred", () => {
    const binding = new RecordingBinding();
    const routed = routeDeviceSession(scopeFor("setActiveDevice", binding), "initial", false);
    expect(routed.routingSessionUuid).toBe("binding-routed");
    expect(binding.resolveCalls).toEqual([
      { selectingActiveDevice: true, deferForeignDevice: false, readOnly: false },
    ]);
  });

  test("a device control tool routes as a non-selection that does not defer", () => {
    const binding = new RecordingBinding();
    routeDeviceSession(scopeFor(DEVICE_CONTROL, binding), "initial", false);
    expect(binding.resolveCalls).toEqual([
      { selectingActiveDevice: false, deferForeignDevice: false, readOnly: false },
    ]);
  });

  test("a device read routes as a non-selection that defers a foreign device", () => {
    const binding = new RecordingBinding();
    routeDeviceSession(scopeFor(DEVICE_READ, binding), "initial", false);
    expect(binding.resolveCalls).toEqual([
      { selectingActiveDevice: false, deferForeignDevice: true, readOnly: true },
    ]);
  });

  test("an active-device selection never defers a foreign device, even when read-only", () => {
    const binding = new RecordingBinding();
    routeDeviceSession(scopeFor(READ_ONLY_SELECTION, binding), "initial", false);
    expect(binding.resolveCalls).toEqual([
      { selectingActiveDevice: true, deferForeignDevice: false, readOnly: true },
    ]);
  });

  test("a plain tool is not device-routed", () => {
    const binding = new RecordingBinding();
    const routed = routeDeviceSession(scopeFor(PLAIN, binding), "initial", false);
    expect(routed.routingSessionUuid).toBe("initial");
    expect(binding.resolveCalls).toEqual([]);
  });
});

describe("autolock routing", () => {
  /** The connection holds only a session that the platform-scoped lookup does not match. */
  const pool = {
    resolveAutolockSessionForMcpSession: (
      mcpSessionId: string | undefined,
      platform?: "android" | "ios",
    ) => (mcpSessionId === "mcp-1" && platform === undefined ? "held-session" : undefined),
  };

  test("setActiveDevice falls back to the connection's held session on any platform", () => {
    const routed = routeViaAutolock(
      { tool: toolNamed("setActiveDevice"), implicitAutolockMcpSessionId: "mcp-1" },
      { platform: "ios" },
      pool,
    );
    expect(routed).toEqual({
      routingSessionUuid: "held-session",
      resolvedImplicitAutolockSessionUuid: "held-session",
    });
  });

  test("a device tool does not fall back past its platform", () => {
    const routed = routeViaAutolock(
      { tool: toolNamed(DEVICE_CONTROL), implicitAutolockMcpSessionId: "mcp-1" },
      { platform: "ios" },
      pool,
    );
    expect(routed).toEqual({
      routingSessionUuid: undefined,
      resolvedImplicitAutolockSessionUuid: undefined,
    });
  });
});

describe("handler params", () => {
  test("setActiveDevice runs under the routed session, replacing the named one", () => {
    const params = buildHandlerParams(planFor("setActiveDevice", new RecordingBinding()));
    expect(params.sessionUuid).toBe("routed-session");
  });

  test("setActiveDevice keeps the named session when nothing was routed", () => {
    const binding = new RecordingBinding();
    const params = buildHandlerParams(
      planFor("setActiveDevice", binding, { routingSessionUuid: undefined }),
    );
    expect(params.sessionUuid).toBe("named-session");
  });

  test("other tools keep the session they named", () => {
    for (const name of [DEVICE_CONTROL, PLAIN]) {
      const params = buildHandlerParams(planFor(name, new RecordingBinding()));
      expect(params.sessionUuid).toBe("named-session");
    }
  });
});

describe("named-session admission", () => {
  const admission = {
    daemonMode: true,
    plainReadCall: false,
    toolSelectionProfileRegistry: new InMemoryToolSelectionProfileRegistry(),
  };

  test("setActiveDevice is exempt: it never reaches the session manager", async () => {
    await admitNamedSession(planFor("setActiveDevice", new RecordingBinding()), admission);
  });

  test("another plain tool naming a session is admitted through the session manager", async () => {
    // No daemon is initialized here, so reaching admission throws.
    await expect(
      admitNamedSession(planFor(PLAIN, new RecordingBinding()), admission),
    ).rejects.toThrow();
  });
});

describe("result binding", () => {
  test("a successful setActiveDevice binds the connection to the routed session", () => {
    const binding = new RecordingBinding();
    bindActiveDeviceResult(planFor("setActiveDevice", binding), { isError: false });
    expect(binding.bindCalls).toEqual([["mcp-1", "routed-session"]]);
  });

  test("a failed setActiveDevice does not bind", () => {
    const binding = new RecordingBinding();
    bindActiveDeviceResult(planFor("setActiveDevice", binding), { isError: true });
    expect(binding.bindCalls).toEqual([]);
  });

  test("other tools never bind through the active-device result", () => {
    const binding = new RecordingBinding();
    bindActiveDeviceResult(planFor(DEVICE_CONTROL, binding), { isError: false });
    bindActiveDeviceResult(planFor(PLAIN, binding), { isError: false });
    expect(binding.bindCalls).toEqual([]);
  });
});
