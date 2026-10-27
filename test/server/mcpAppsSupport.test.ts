import { describe, expect, test } from "bun:test";
import { clientAdvertisesMcpApps } from "../../src/server/mcpAppsSupport";
import {
  OBSERVE_APP_RESOURCE_URI,
  registerObserveAppResource,
  type ObserveAppDataSource,
} from "../../src/server/observeAppResource";
import {
  renderObserveAppShellHtml,
  OBSERVE_APP_SHELL_META,
} from "../../src/server/observeAppShell";
import { ResourceRegistry } from "../../src/server/resourceRegistry";

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
