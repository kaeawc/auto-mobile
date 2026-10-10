import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  DaemonConnectionSessionReleasedError,
  DaemonMcpProxy,
  resourceUriNamesSession,
} from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { createMcpServer } from "../../src/server/index";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// #11483 item 2, the other half: once a release was reported, a resource read that names no
// session is forwarded without one, but a URI that NAMES a session never is. The released
// session's own resources keep the typed terminal answer in every session-scoped family, not
// only the observation ones. The table is every resource template the server registers, so a new
// session-scoped template cannot slip past the proxy's classifier.

const DEAD = "dead-session-uuid";
const DEVICE = "emulator-5554";
const FRESH_SCREENSHOT = `automobile:device-session/${DEAD}/screenshot`;
const LOGS = `automobile:device-session/${DEAD}/apps/com.x/logs`;

/** A concrete URI for a template: the session parameter names the dead session. */
function expand(uriTemplate: string): string {
  return uriTemplate
    .replace(/\{\?[^}]*\}/g, "")
    .replace(/\{([^}]+)\}/g, (_match, name: string) => (/session/i.test(name) ? DEAD : "x"));
}

let templates: string[] = [];
let restoreServerFixture: () => void;

beforeAll(() => {
  restoreServerFixture = installHermeticServerFixture();
  // The production registration, so the table cannot drift from what the server serves.
  createMcpServer({ daemonMode: true });
  templates = ResourceRegistry.getTemplateDefinitions().map((template) => template.uriTemplate);
});

afterAll(() => {
  restoreServerFixture();
});

function sessionScopedTemplates(): string[] {
  return templates.filter((template) => /\{[^}]*session[^}]*\}/i.test(template));
}

describe("the proxy's session-naming classifier against the registered templates", () => {
  test("the known session-scoped families are registered", () => {
    expect(sessionScopedTemplates().map(expand)).toEqual(
      expect.arrayContaining([
        `automobile:observation/session/${DEAD}/latest`,
        `automobile:observation/session/${DEAD}/latest/screenshot`,
        FRESH_SCREENSHOT,
        LOGS.replace("com.x", "x"),
      ]),
    );
  });

  test("every template with a session parameter is session-naming, and no other template is", () => {
    const misclassified = templates.filter(
      (template) =>
        resourceUriNamesSession(expand(template)) !== sessionScopedTemplates().includes(template),
    );
    expect(misclassified).toEqual([]);
  });

  test("query strings and deeper paths do not hide the session", () => {
    expect(resourceUriNamesSession(`${LOGS}?lastSeconds=30`)).toBe(true);
    expect(resourceUriNamesSession(`automobile:device-session/${DEAD}`)).toBe(true);
    expect(resourceUriNamesSession("automobile:devices/booted")).toBe(false);
    expect(resourceUriNamesSession("automobile:observation/latest")).toBe(false);
  });
});

describe("resource reads naming the released session after the release was reported", () => {
  let client: FakeDaemonClient;
  let proxy: DaemonMcpProxy;
  let spies: Array<ReturnType<typeof spyOn>>;

  beforeEach(async () => {
    client = new FakeDaemonClient({
      resourceResult: { contents: [] },
      toolResultFor: (name) =>
        name === "getAndroid"
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    platform: "android",
                    runtime: { deviceId: DEVICE, session: { sessionUuid: DEAD } },
                  }),
                },
              ],
            }
          : { content: [{ type: "text", text: "ok" }] },
    });
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    spies = [
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager,
      autoStartDaemon: false,
      timer: new FakeTimer(),
      idGenerator: new FakeIdGenerator(),
      heartbeatTimeoutMs: 4_000,
      heartbeatIntervalMs: 2_000,
    });
    await proxy.callTool("getAndroid", {});
    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, DEAD, "lazy-expiry");
    // One call is told about the release; reads that need no session go through from here on.
    await expect(proxy.callTool("tapOn", { text: "OK" })).rejects.toThrow(/released/);
  });

  afterEach(async () => {
    await proxy.close();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  test("the session log resource keeps the typed terminal answer and is not forwarded", async () => {
    await expect(proxy.readResource(LOGS)).rejects.toBeInstanceOf(
      DaemonConnectionSessionReleasedError,
    );
    expect(client.readResourceCalls).toEqual([]);
  });

  test("every registered session-scoped template keeps the typed terminal answer", async () => {
    const uris = sessionScopedTemplates()
      .map(expand)
      .filter((uri) => uri !== FRESH_SCREENSHOT);
    expect(uris.length).toBeGreaterThanOrEqual(3);

    for (const uri of uris) {
      await expect(proxy.readResource(uri)).rejects.toBeInstanceOf(
        DaemonConnectionSessionReleasedError,
      );
    }
    expect(client.readResourceCalls).toEqual([]);

    // The one exemption is unchanged: the fresh screenshot is read under the released session,
    // which the daemon answers with its own inactivity report.
    await proxy.readResource(FRESH_SCREENSHOT);
    expect(client.readResourceCalls).toEqual([FRESH_SCREENSHOT]);
    expect(client.readResourceParams.at(-1)?.sessionUuid).toBe(DEAD);
  });

  test("a resource that names no session is still forwarded without one", async () => {
    await proxy.readResource("automobile:devices/booted");
    expect(client.readResourceParams.at(-1)).toEqual({});
  });
});
