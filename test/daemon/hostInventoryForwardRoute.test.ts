import { describe, expect, test } from "bun:test";
import { fakeBindLock, unreachableMcpDispatcher } from "../helpers/createTestUnixSocketServer";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { resolveSocketAdmissionLane } from "../../src/daemon/socketRequestAdmission";
import { DAEMON_TOOL_SELECTION_PROFILE_PARAM } from "../../src/daemon/wire/constants";
import { createFakeSession } from "./helpers/inputSocketHarness";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";
import { UnixSocketServerHarness } from "./helpers/UnixSocketServerHarness";

/**
 * Admission puts a `listDevices` / `listDeviceImages` call with no device or session routing
 * argument on the `host:inventory` lane. Forwarding must agree: a `platform` filter must not move
 * the listing onto the caller's device lane, where it would wait behind a long device call (#13796).
 */

function server(): UnixSocketServerHarness {
  return new UnixSocketServerHarness(
    "unused",
    createFakeDaemonState(new Map()),
    new FakeTimer(),
    undefined,
    { mcpDispatcher: unreachableMcpDispatcher },
    undefined,
    { bindLock: fakeBindLock },
  );
}

function call(name: string, args: Record<string, unknown>): DaemonRequest {
  return { id: "r1", type: "mcp_request", method: "tools/call", params: { name, arguments: args } };
}

describe("forward route of a host-inventory listing (#13796)", () => {
  test.each(["listDevices", "listDeviceImages"])(
    "%s with only a platform argument is forwarded on host:inventory",
    async (tool) => {
      const s = server();
      for (const platform of ["ios", "android"]) {
        const route = await s.forwardRouteFor(call(tool, { platform }), "sock-1");
        expect(route.executionKey).toBe("host:inventory");
      }
    },
  );

  test("the platform listing does not share the execution key of a platform-scoped device call", async () => {
    const s = server();
    const listing = await s.forwardRouteFor(call("listDevices", { platform: "ios" }), "sock-1");
    const observe = await s.forwardRouteFor(call("observe", { platform: "ios" }), "sock-1");

    expect(observe.executionKey).not.toBe("host:inventory");
    expect(listing.executionKey).not.toBe(observe.executionKey);
  });

  test("a listing that names a device keeps its device route", async () => {
    const s = server();
    const route = await s.forwardRouteFor(
      call("listDevices", { platform: "ios", deviceId: "SIM-1" }),
      "sock-1",
    );

    expect(route.executionKey).toBe("device:SIM-1");
  });
});

const inventoryCases: Array<[string, string, Record<string, unknown>]> = [];
for (const tool of ["listDevices", "listDeviceImages"]) {
  for (const socket of ["sock-1", "sock-free"]) {
    for (const args of [
      {},
      { [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: "profile" },
      { platform: "ios" },
    ]) {
      inventoryCases.push([tool, socket, args]);
    }
  }
}

describe("inventory admission/forward agreement", () => {
  test.each(inventoryCases)(
    "%s on %s with %j agrees with admission",
    async (tool, socket, args) => {
      const sessions = new Map([["held", createFakeSession("held", "SIM-1", "ios")]]);
      const state = createFakeDaemonState(sessions);
      const pool = state.getDevicePool();
      state.getDevicePool = () => ({
        ...pool,
        resolveAutolockSessionForMcpSession: (id) => (id === "sock-1" ? "held" : undefined),
      });
      const s = new UnixSocketServerHarness(
        "unused",
        state,
        new FakeTimer(),
        undefined,
        { mcpDispatcher: unreachableMcpDispatcher },
        undefined,
        { bindLock: fakeBindLock },
      );
      const request = call(tool, args);
      const admissionLane = resolveSocketAdmissionLane(request);
      const route = await s.forwardRouteFor(request, socket);
      expect(admissionLane).toBe("host:inventory");
      expect(admissionLane).toBe(route.executionKey);
      if (args[DAEMON_TOOL_SELECTION_PROFILE_PARAM]) {
        expect(route.toolSelectionProfileUuid).toBe("profile");
      }
    },
  );
});
