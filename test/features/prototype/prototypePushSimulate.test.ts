import { describe, expect, test } from "bun:test";
import {
  PROTOTYPE_PUSH_CONNECTION_CAPABILITIES,
  prototypePushConnectionRoute,
  simulatePrototypePush,
  type PrototypePushRuntime,
} from "../../../src/features/prototype/prototypePushSimulate";
import { FakePrototypePushRoute } from "../../fakes/FakePrototypePushRoute";

const push = { type: "message", data: { id: "m1", sender: "Ada", text: "Hi" } };

describe("simulatePrototypePush", () => {
  test("auto prefers the connection when it is available", async () => {
    const connection = new FakePrototypePushRoute();
    const system = new FakePrototypePushRoute();
    const result = await simulatePrototypePush(
      { connection, system },
      { id: "np", data: push, timeoutMs: 500 },
    );
    expect(result).toEqual({
      success: true,
      transport: "connection",
      handled: true,
      delivery: "foreground",
    });
    expect(connection.delivered).toEqual([{ id: "np", payload: push, timeoutMs: 500 }]);
    expect(system.delivered).toEqual([]);
  });

  test("auto falls back to the system path when not connected", async () => {
    const connection = new FakePrototypePushRoute(false);
    const system = new FakePrototypePushRoute(true, { success: true });
    const result = await simulatePrototypePush({ connection, system }, { id: "np", data: push });
    expect(result).toEqual({
      success: true,
      transport: "system",
      handled: false,
      delivery: "notification",
    });
    expect(connection.delivered).toEqual([]);
  });

  test("reports the delivery the runtime returns", async () => {
    const system = new FakePrototypePushRoute(true, {
      success: true,
      handled: true,
      delivery: "background",
    });
    expect(
      await simulatePrototypePush({ system }, { id: "np", data: push, transport: "system" }),
    ).toMatchObject({ success: true, transport: "system", delivery: "background" });
  });

  test("is unavailable with no connection and no system path", async () => {
    const result = await simulatePrototypePush(
      { connection: new FakePrototypePushRoute(false) },
      { id: "np", data: push },
    );
    expect(result).toMatchObject({ success: false, code: "unavailable" });
    expect(await simulatePrototypePush({}, { id: "np", data: push })).toMatchObject({
      success: false,
      code: "unavailable",
    });
  });

  test("an explicit transport never falls back", async () => {
    const system = new FakePrototypePushRoute();
    const result = await simulatePrototypePush(
      { connection: new FakePrototypePushRoute(false), system },
      { id: "np", data: push, transport: "connection" },
    );
    expect(result).toMatchObject({ success: false, code: "unavailable" });
    expect(result.success === false && result.error).toContain("connection transport");
    expect(system.delivered).toEqual([]);
  });

  test("an oversized payload is invalid_args before any route is asked", async () => {
    const connection = new FakePrototypePushRoute();
    const result = await simulatePrototypePush(
      { connection },
      { id: "np", data: { type: "message", data: { text: "x".repeat(4096) } } },
    );
    expect(result).toMatchObject({ success: false, code: "invalid_args" });
    expect(result.success === false && result.error).toContain("4096 bytes");
    expect(connection.delivered).toEqual([]);
  });

  test("a malformed payload is invalid_args with its path", async () => {
    const result = await simulatePrototypePush(
      { connection: new FakePrototypePushRoute() },
      { id: "np", data: { type: "message", extra: 1 } },
    );
    expect(result).toMatchObject({ success: false, code: "invalid_args" });
  });

  test("a refused or failed delivery is platform_error naming the transport", async () => {
    const connection = new FakePrototypePushRoute(true, { success: false, error: "not shown" });
    expect(await simulatePrototypePush({ connection }, { id: "np", data: push })).toEqual({
      success: false,
      code: "platform_error",
      transport: "connection",
      error: "not shown",
    });
    connection.failWith(new Error("socket closed"));
    expect(await simulatePrototypePush({ connection }, { id: "np", data: push })).toMatchObject({
      success: false,
      code: "platform_error",
      transport: "connection",
    });
  });
});

class FakePushRuntime implements PrototypePushRuntime {
  readonly sent: { id: string; event: string; data: unknown; timeoutMs?: number }[] = [];
  constructor(
    readonly capabilities: readonly string[],
    private readonly reply: Awaited<ReturnType<PrototypePushRuntime["simulatePlatformEvent"]>> = {
      success: true,
    },
  ) {}
  async supports(capability: string): Promise<boolean> {
    return this.capabilities.includes(capability);
  }
  async simulatePlatformEvent(id: string, event: string, data: unknown, timeoutMs?: number) {
    this.sent.push({ id, event, data, timeoutMs });
    return this.reply;
  }
}

describe("prototypePushConnectionRoute", () => {
  test("needs platform simulation, the notifications module and the push capability", async () => {
    expect(PROTOTYPE_PUSH_CONNECTION_CAPABILITIES).toEqual([
      "prototype_platform_simulation_v1",
      "prototype_platform_notifications_v1",
      "prototype_platform_push_v1",
    ]);
    expect(
      await prototypePushConnectionRoute(
        new FakePushRuntime(PROTOTYPE_PUSH_CONNECTION_CAPABILITIES),
      ).available(),
    ).toBe(true);
    for (const missing of PROTOTYPE_PUSH_CONNECTION_CAPABILITIES) {
      const runtime = new FakePushRuntime(
        PROTOTYPE_PUSH_CONNECTION_CAPABILITIES.filter((capability) => capability !== missing),
      );
      expect({
        missing,
        available: await prototypePushConnectionRoute(runtime).available(),
      }).toEqual({ missing, available: false });
    }
  });

  test("delivers the payload as notifications.push event data and keeps a typed reply", async () => {
    const runtime = new FakePushRuntime(PROTOTYPE_PUSH_CONNECTION_CAPABILITIES, {
      success: true,
      pushHandled: true,
      pushDelivery: "background",
    });
    const result = await simulatePrototypePush(
      { connection: prototypePushConnectionRoute(runtime) },
      { id: "np", data: push, timeoutMs: 250 },
    );
    expect(result).toEqual({
      success: true,
      transport: "connection",
      handled: true,
      delivery: "background",
    });
    expect(runtime.sent).toEqual([
      { id: "np", event: "notifications.push", data: push, timeoutMs: 250 },
    ]);
  });

  test("a malformed handled or delivery falls back to unhandled foreground", async () => {
    const runtime = new FakePushRuntime(PROTOTYPE_PUSH_CONNECTION_CAPABILITIES, {
      success: true,
      pushHandled: "yes",
      pushDelivery: "sideways",
    });
    expect(
      await simulatePrototypePush(
        { connection: prototypePushConnectionRoute(runtime) },
        { id: "np", data: push },
      ),
    ).toEqual({ success: true, transport: "connection", handled: false, delivery: "foreground" });
  });

  test("a refused delivery is a platform_error naming the runtime's reason", async () => {
    const runtime = new FakePushRuntime(PROTOTYPE_PUSH_CONNECTION_CAPABILITIES, {
      success: false,
      error: "no prototype np is shown",
    });
    expect(
      await simulatePrototypePush(
        { connection: prototypePushConnectionRoute(runtime) },
        { id: "np", data: push },
      ),
    ).toEqual({
      success: false,
      code: "platform_error",
      transport: "connection",
      error: "no prototype np is shown",
    });
  });
});
