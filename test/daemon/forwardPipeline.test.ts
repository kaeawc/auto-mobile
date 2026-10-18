import { describe, expect, test } from "bun:test";
import {
  createMcpForwardPipeline,
  type McpForwardPipelineHost,
  type McpForwardPipelineState,
} from "../../src/daemon/socketServer/forwardPipeline";

/** #11815: the composition function wires recovery, router and daemon state, all faked. */
const SESSION = "11111111-1111-4111-8111-111111111111";

function makeHost(released: boolean): McpForwardPipelineHost {
  return {
    isReleasedBoundSession: () => released,
    boundClientRoute: () => undefined,
    requestArgumentScopeKey: () => undefined,
    implicitAutolockScopeKey: () => undefined,
    implicitAutolockSession: () => undefined,
    resolveDeviceLabelSession: (base) => base,
    hasActiveSession: () => true,
    deviceHolderSession: () => undefined,
    isDeviceReadCall: () => false,
    admissionArgs: (request) => request.params,
    runKeyed: (_key, fn) => fn(),
  };
}

function makeState(window: boolean): McpForwardPipelineState {
  return {
    getSessionManager: () =>
      ({
        isReleasedSessionInRestartRecoveryWindow: async () => window,
        getTerminalReleaseSnapshot: () => undefined,
        getExpiredReleaseSnapshot: async () => undefined,
      }) as never,
    getDevicePool: () => ({}),
  };
}

describe("createMcpForwardPipeline", () => {
  test("healthy session forwards synchronously", () => {
    const { withAdmittedBoundSession } = createMcpForwardPipeline(
      makeState(false),
      makeHost(false),
    );
    expect(withAdmittedBoundSession({ sessionUuid: SESSION }, (s) => `ran:${s}`)).toBe(
      "ran:undefined",
    );
  });

  test("released session inside the restart window is admitted with its uuid", async () => {
    const { withAdmittedBoundSession } = createMcpForwardPipeline(makeState(true), makeHost(true));
    expect(await withAdmittedBoundSession({ sessionUuid: SESSION }, (s) => s)).toBe(SESSION);
  });

  test("released session outside the window fails closed", async () => {
    const { withAdmittedBoundSession } = createMcpForwardPipeline(makeState(false), makeHost(true));
    await expect(
      Promise.resolve(withAdmittedBoundSession({ sessionUuid: SESSION }, () => "x")),
    ).rejects.toThrow();
  });

  test("router resolves a shared route through the composed port", async () => {
    const { router } = createMcpForwardPipeline(makeState(false), makeHost(false));
    const route = await router.resolve({ method: "ide/foo", params: {} } as never, "sock-1");
    expect(typeof route.executionKey).toBe("string");
  });
});
