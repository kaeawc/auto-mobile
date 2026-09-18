import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  runCliCommand,
  setDaemonProxyFactoryForTesting,
  resetDaemonProxyFactoryForTesting,
} from "../../src/cli";

/**
 * A `--cli` invocation is a trusted local operator action and must NEVER require a
 * separate `setToolEnabled` step. The CLI transparently enables a gated tool
 * (`defaultEnabled: false`, e.g. `deleteDevice`) on its one-shot proxy connection
 * before the call, and leaves default-enabled tools untouched.
 */
describe("CLI transparently enables gated tools", () => {
  afterEach(() => {
    resetDaemonProxyFactoryForTesting();
  });

  function recordProxy(calls: Array<{ name: string; params: unknown }>) {
    setDaemonProxyFactoryForTesting((): any => ({
      callTool: async (name: string, params: unknown): Promise<any> => {
        calls.push({ name, params });
        return { content: [{ type: "text", text: "{}" }] };
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

  test("does NOT pre-enable a default-enabled tool", async () => {
    const calls: Array<{ name: string; params: unknown }> = [];
    recordProxy(calls);

    const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await runCliCommand(["listDevices", "--platform", "android"]);
    } finally {
      exitSpy.mockRestore();
    }

    const names = calls.map((c) => c.name);
    expect(names).not.toContain("setToolEnabled");
    expect(names).toEqual(["listDevices"]);
  });
});
