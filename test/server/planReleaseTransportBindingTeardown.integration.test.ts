import { afterEach, describe, expect, test } from "bun:test";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { SessionReleaseBroadcaster } from "../../src/server/sessionReleaseBroadcast";
import type { ToolCapability } from "../../src/features/toolSelection/SessionToolSelectionService";
import {
  resetSessionScreenshotResourceDependencies,
  setSessionScreenshotResourceDependencies,
} from "../../src/server/observationResources";

// End-to-end coverage for the server-side SessionToolBinding teardown wired into
// createMcpServer (issue #4611 Gap D). A transport seeded with a released-able
// session enforces that session's narrowed profile in tools/list; once the
// daemon actually releases the session (surfaced here via the process-wide
// SessionReleaseBroadcaster, the same channel heartbeat/idle/plan releases use),
// the transport binding is cleared and tools/list stops filtering.
describe("createMcpServer server-side session-binding teardown (issue #4611 Gap D)", () => {
  const RELEASED_SESSION = "session-S";
  let fixture: McpTestFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.teardown();
      fixture = undefined;
    }
    resetSessionScreenshotResourceDependencies();
  });

  // Narrow the released session so the whole "clipboard" capability is disabled
  // for it; every other session (and the unbound state) keeps it enabled.
  const profile = {
    isEnabled: async (sessionUuid: string, capability: ToolCapability): Promise<boolean> =>
      !(sessionUuid === RELEASED_SESSION && capability === "clipboard"),
  };

  test("a session release clears the transport binding so a later tools/list no longer enforces the released profile", async () => {
    fixture = new McpTestFixture({
      sessionContext: { sessionId: "transport-1", initialSessionToolBinding: RELEASED_SESSION },
      sessionToolSelectionService: profile,
    });
    await fixture.setup();
    const { client } = fixture.getContext();

    // While bound to the released session, the narrowed capability is filtered out.
    const before = await client.listTools();
    expect(before.tools.map((tool) => tool.name)).not.toContain("clipboard");

    // The daemon releases the session; the broadcaster reaches this transport.
    SessionReleaseBroadcaster.emit(RELEASED_SESSION);

    // The binding is gone, so tools/list reverts to the unbound (unfiltered) surface.
    const after = await client.listTools();
    expect(after.tools.map((tool) => tool.name)).toContain("clipboard");
  });

  test("a session release preserves typed fresh screenshot failures for the same transport", async () => {
    setSessionScreenshotResourceDependencies({
      resolveActiveSession: () => undefined,
      createScreenshotService: () => {
        throw new Error("inactive sessions must not capture screenshots");
      },
    });
    fixture = new McpTestFixture({
      sessionContext: {
        sessionId: "transport-resource",
        initialSessionToolBinding: RELEASED_SESSION,
      },
    });
    await fixture.setup();
    const { client } = fixture.getContext();

    SessionReleaseBroadcaster.emit(RELEASED_SESSION);

    const response = await client.readResource({
      uri: `automobile:device-session/${RELEASED_SESSION}/screenshot`,
    });

    expect(JSON.parse(response.contents[0].text!)).toMatchObject({
      code: "SESSION_NOT_ACTIVE",
      retryable: false,
    });
  });

  test("releasing an unrelated session leaves the bound profile intact", async () => {
    fixture = new McpTestFixture({
      sessionContext: { sessionId: "transport-2", initialSessionToolBinding: RELEASED_SESSION },
      sessionToolSelectionService: profile,
    });
    await fixture.setup();
    const { client } = fixture.getContext();

    SessionReleaseBroadcaster.emit("some-other-session");

    const tools = await client.listTools();
    // The still-bound released session keeps filtering the narrowed capability.
    expect(tools.tools.map((tool) => tool.name)).not.toContain("clipboard");
  });
});
