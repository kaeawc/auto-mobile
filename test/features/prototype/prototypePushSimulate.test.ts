import { describe, expect, test } from "bun:test";
import { simulatePrototypePush } from "../../../src/features/prototype/prototypePushSimulate";
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
