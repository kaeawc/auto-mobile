import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  enableToolsSchemaField,
  registerToolSelectionTools,
} from "../../src/server/toolSelectionTools";

/**
 * #6869 — a client had to acquire a device, read `gatedTools`, and then spend
 * one `setToolEnabled` round-trip per tool before its first interaction.
 * `getAndroid` / `getApple` / `provisionDevice` now take `enableTools`, applied
 * while the session is minted, and report the resulting `enabledTools`
 * alongside `gatedTools`.
 */
describe("acquisition-time enableTools (#6869)", () => {
  let fixture: McpTestFixture | undefined;

  const registerAcquisition = (name: string) => {
    ToolRegistry.register(
      name,
      "acquire",
      z.object({ enableTools: enableToolsSchemaField }),
      async () => ({
        content: [{ type: "text", text: JSON.stringify({ sessionUuid: "acquired-session" }) }],
      }),
      { defaultEnabled: true },
    );
    ToolRegistry.register("inputText", "input", z.object({}), async () => ({ content: [] }), {
      defaultEnabled: false,
    });
    ToolRegistry.register("clearText", "clear", z.object({}), async () => ({ content: [] }), {
      defaultEnabled: false,
    });
    ToolRegistry.register("observe", "observe", z.object({}), async () => ({ content: [] }), {
      defaultEnabled: true,
    });
    registerToolSelectionTools();
  };

  const acquire = async (name: string, args: Record<string, unknown>) => {
    const response = await fixture!.client.request(
      { method: "tools/call", params: { name, arguments: args } },
      z.any(),
    );
    return { response, payload: JSON.parse(response.content[0].text) };
  };

  beforeEach(async () => {
    fixture = new McpTestFixture();
    await fixture.setup();
    ToolRegistry.clearTools();
  });

  afterEach(async () => {
    await fixture?.teardown();
    fixture = undefined;
    ToolRegistry.clearTools();
  });

  for (const acquisition of ["getAndroid", "getApple"] as const) {
    test(`${acquisition} enables the requested tools while minting the session`, async () => {
      registerAcquisition(acquisition);

      const { payload } = await acquire(acquisition, {
        enableTools: ["inputText", "clearText"],
      });

      expect(payload.sessionUuid).toBe("acquired-session");
      expect(payload.gatedTools).toEqual([]);
      expect(payload.enabledTools).toEqual(
        [acquisition, "clearText", "inputText", "observe"].sort(),
      );
      expect((await fixture!.client.listTools()).tools.map((tool) => tool.name)).toContain(
        "inputText",
      );
    });

    test(`${acquisition} reports enabledTools even without enableTools`, async () => {
      registerAcquisition(acquisition);

      const { payload } = await acquire(acquisition, {});

      expect(payload.gatedTools).toEqual(["clearText", "inputText"]);
      expect(payload.enabledTools).toEqual([acquisition, "observe"].sort());
    });

    test(`${acquisition} rejects an unknown name before acquiring anything`, async () => {
      let acquisitionsRun = 0;
      ToolRegistry.register(
        acquisition,
        "acquire",
        z.object({ enableTools: enableToolsSchemaField }),
        async () => {
          acquisitionsRun += 1;
          return {
            content: [{ type: "text", text: JSON.stringify({ sessionUuid: "acquired-session" }) }],
          };
        },
        { defaultEnabled: true },
      );
      registerToolSelectionTools();

      await expect(
        fixture!.client.request(
          {
            method: "tools/call",
            params: { name: acquisition, arguments: { enableTools: ["notATool"] } },
          },
          z.any(),
        ),
      ).rejects.toThrow("Tool 'notATool' is not user-configurable.");

      expect(acquisitionsRun).toBe(0);
    });
  }

  // #6886 review — `tools/list` and the call gate resolve a tool against the
  // UNION of the connection profile and the routing session. provisionDevice's
  // freshly minted session carries no override for a capability the caller
  // enabled earlier on its connection profile, so reporting `enabledTools` from
  // the minted UUID alone omitted tools that stay callable.
  test("provisionDevice reports capabilities the connection profile enabled too", async () => {
    registerAcquisition("provisionDevice");
    // A sessionless setToolEnabled is exactly the connection-profile update.
    await fixture!.client.request(
      {
        method: "tools/call",
        params: { name: "setToolEnabled", arguments: { toolName: "inputText" } },
      },
      z.any(),
    );

    const { payload } = await acquire("provisionDevice", {});

    expect(payload.enabledTools).toContain("inputText");
  });

  /**
   * #6886 review — a rejected capability write used to be swallowed by the
   * enrichment catch, so the acquisition still returned a plain success and the
   * caller's next call hit a tool that was never enabled. The acquisition itself
   * really did succeed, so the minted session handle must survive; the failure
   * has to be stated in the response instead of inferred.
   */
  describe("a failed capability write", () => {
    const withFailingSelectionWrites = async () => {
      await fixture?.teardown();
      fixture = new McpTestFixture({
        sessionToolSelectionService: {
          isEnabled: async (_sessionUuid, _toolName, declaredDefault) => declaredDefault,
          setEnabled: async () => {
            throw new Error("selection storage unavailable");
          },
        },
      });
      await fixture.setup();
      ToolRegistry.clearTools();
    };

    for (const acquisition of ["getAndroid", "getApple"] as const) {
      test(`${acquisition} reports the failure and keeps the minted session`, async () => {
        await withFailingSelectionWrites();
        registerAcquisition(acquisition);

        const { payload } = await acquire(acquisition, { enableTools: ["inputText"] });

        expect(payload.sessionUuid).toBe("acquired-session");
        expect(payload.enableToolsError).toContain("selection storage unavailable");
        expect(payload.enableToolsError).toContain("inputText");
        expect(payload.gatedTools).toContain("inputText");
      });
    }

    test("provisionDevice reports the failure and keeps the minted session", async () => {
      await withFailingSelectionWrites();
      registerAcquisition("provisionDevice");

      const { payload } = await acquire("provisionDevice", { enableTools: ["inputText"] });

      expect(payload.sessionUuid).toBe("acquired-session");
      expect(payload.enableToolsError).toContain("selection storage unavailable");
      expect(payload.enabledTools).not.toContain("inputText");
    });

    test("a successful acquisition carries no enableToolsError", async () => {
      registerAcquisition("getAndroid");

      const { payload } = await acquire("getAndroid", { enableTools: ["inputText"] });

      expect(payload.enableToolsError).toBeUndefined();
    });
  });

  test("provisionDevice enables the requested tools and reports enabledTools", async () => {
    registerAcquisition("provisionDevice");

    const { payload } = await acquire("provisionDevice", { enableTools: ["inputText"] });

    expect(payload.sessionUuid).toBe("acquired-session");
    expect(payload.enabledTools).toEqual(["inputText", "observe", "provisionDevice"]);
  });
});
