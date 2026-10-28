import { describe, expect, test } from "bun:test";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { FakeMcpServer } from "../fakes/FakeMcpServer";
import { fakeServerContext } from "../helpers/fakeServerContext";
import {
  clientAdvertisesMcpApps,
  mcpAppsRequestMeta,
  requestAdvertisesMcpApps,
} from "../../src/server/mcpAppsSupport";
import {
  OBSERVE_APP_RESOURCE_URI,
  registerObserveAppResource,
  type ObserveAppDataSource,
} from "../../src/server/observeAppResource";
import {
  renderObserveAppShellHtml,
  OBSERVE_APP_SHELL_META,
} from "../../src/server/observeAppShell";
import { ResourceRegistry, type ResourceReadContext } from "../../src/server/resourceRegistry";

const APP_MIME = "text/html;profile=mcp-app";
const UI = "io.modelcontextprotocol/ui";

describe("clientAdvertisesMcpApps", () => {
  test("is true only when the ui extension is listed", () => {
    expect(clientAdvertisesMcpApps({ extensions: { [UI]: { mimeTypes: [APP_MIME] } } })).toBe(true);
    expect(clientAdvertisesMcpApps({ extensions: { [UI]: {} } })).toBe(true);
  });

  test("is false for a client that does not advertise it, or lists another profile", () => {
    for (const capabilities of [
      undefined,
      null,
      {},
      { extensions: {} },
      { extensions: { "io.modelcontextprotocol/tasks": {} } },
      { extensions: { [UI]: null } },
      { extensions: { [UI]: { mimeTypes: ["text/html"] } } },
      { extensions: "yes" },
      { roots: {} },
    ]) {
      expect(clientAdvertisesMcpApps(capabilities)).toBe(false);
    }
  });
});

describe("ui://automobile/observe by client", () => {
  const dataSource: ObserveAppDataSource = { getObservation: async () => undefined };
  const read = async (context: Parameters<ReturnType<typeof registerAndGet>>[0]) =>
    registerAndGet()(context);
  const registerAndGet = () => {
    ResourceRegistry.clearResources();
    registerObserveAppResource({ dataSource });
    return ResourceRegistry.getResource(OBSERVE_APP_RESOURCE_URI)!.handler;
  };

  test("an Apps client gets the stable live shell and the restrictive _meta.ui", async () => {
    const content = await read({ sessionUuid: "s1", clientSupportsApps: true });
    expect(content.mimeType).toBe(APP_MIME);
    expect(content.text).toBe(renderObserveAppShellHtml());
    expect(content._meta).toEqual(OBSERVE_APP_SHELL_META);
  });

  test("the shell is identical for different sessions, so it cannot carry one call's data", async () => {
    const a = await read({ sessionUuid: "s1", clientSupportsApps: true });
    const b = await read({ sessionUuid: "s2", clientSupportsApps: true });
    expect(a.text).toBe(b.text);
  });

  test("every other client keeps the static snapshot with no _meta", async () => {
    for (const context of [{}, { sessionUuid: "s1" }, { clientSupportsApps: false }]) {
      const content = await read(context);
      expect(content.text).not.toContain('data-observe-app="shell"');
      expect(content.text).toContain("No session-bound observation is available");
      expect(content._meta).toBeUndefined();
    }
  });
});

describe("request Apps capabilities", () => {
  const meta = {
    [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [UI]: { mimeTypes: [APP_MIME] } } },
  };

  test("projects only the advertised UI extension and leaves legacy clients alone", () => {
    expect(
      mcpAppsRequestMeta({ roots: {}, extensions: { [UI]: { mimeTypes: [APP_MIME] }, other: {} } }),
    ).toEqual(meta);
    expect(mcpAppsRequestMeta({})).toBeUndefined();
    expect(
      mcpAppsRequestMeta({ extensions: { [UI]: { mimeTypes: ["text/html"] } } }),
    ).toBeUndefined();
  });

  test("distinguishes an absent declaration from explicit non-Apps capabilities", () => {
    expect(requestAdvertisesMcpApps({})).toBeUndefined();
    expect(requestAdvertisesMcpApps({ envelope: {}, meta })).toBe(true);
    expect(requestAdvertisesMcpApps({ envelope: meta })).toBe(true);
    for (const capabilities of [{}, null, { extensions: { [UI]: { mimeTypes: ["text/html"] } } }]) {
      expect(
        requestAdvertisesMcpApps({
          envelope: { [CLIENT_CAPABILITIES_META_KEY]: capabilities },
          meta,
        }),
      ).toBe(false);
    }
  });

  test("registry uses each request's Apps flag while retaining trusted session context", async () => {
    ResourceRegistry.clearResources();
    const observedContexts: ResourceReadContext[] = [];
    registerObserveAppResource({
      dataSource: {
        getObservation: async (context) => {
          observedContexts.push(context);
          return undefined;
        },
      },
    });
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server, () => ({
      sessionUuid: "trusted",
      clientSupportsApps: false,
    }));
    const read = async (
      requestMeta?: Record<string, unknown>,
      envelope?: Record<string, unknown>,
    ) => {
      const ctx = fakeServerContext();
      const handler = server.server.handlersBySchema.get("resources/read")!;
      const result = await handler(
        { method: "resources/read", params: { uri: OBSERVE_APP_RESOURCE_URI } },
        {
          ...ctx,
          mcpReq: { ...ctx.mcpReq, _meta: requestMeta, envelope },
        },
      );
      return result as { contents: { text: string; _meta?: Record<string, unknown> }[] };
    };
    try {
      const legacy = await read();
      expect((await read(meta)).contents[0].text).toBe(renderObserveAppShellHtml());
      expect((await read(undefined, meta)).contents[0]._meta).toEqual(OBSERVE_APP_SHELL_META);
      expect(await read({ [CLIENT_CAPABILITIES_META_KEY]: {} })).toEqual(legacy);
      expect(await read()).toEqual(legacy);
      ResourceRegistry.registerWithServer(server, () => ({
        sessionUuid: "trusted",
        clientSupportsApps: true,
      }));
      expect((await read()).contents[0].text).toBe(renderObserveAppShellHtml());
      expect(
        await read({
          [CLIENT_CAPABILITIES_META_KEY]: {},
          sessionUuid: "untrusted",
          clientSupportsApps: true,
        }),
      ).toEqual(legacy);
      expect(observedContexts.at(-1)).toEqual({
        sessionUuid: "trusted",
        clientSupportsApps: false,
      });
    } finally {
      ResourceRegistry.untrackServer(server);
      ResourceRegistry.clearResources();
    }
  });
});
