import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  registerToolSelectionTools,
  SET_TOOL_ENABLED_TOOL_NAME,
  type SessionPlatformLookup,
} from "../../src/server/toolSelectionTools";
import type { Platform } from "../../src/models/Platform";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { toolJson } from "../helpers/toolResponse";
import { FakeToolSelectionRepository } from "../fakes/FakeToolSelectionRepository";
import { SessionToolSelectionService } from "../../src/features/toolSelection/SessionToolSelectionService";

isolateToolRegistry();

const WATCH_SESSION = "watch-session-19186";

// Device-aware tools watchOS refuses at the platform gate, verbatim from the issue's enabledTools.
const REFUSED_ON_WATCHOS = [
  "appLifecycle",
  "homeScreen",
  "keyboard",
  "putAppFile",
  "recentApps",
  "shareSheet",
  "tapAny",
  "wakeAndUnlock",
];
const CALLABLE_DEVICE_AWARE = ["observe", "tapOn"];
const PLAIN = ["listDevices"];

function registerTools(): void {
  ToolRegistry.clearTools();
  for (const name of [...REFUSED_ON_WATCHOS, ...CALLABLE_DEVICE_AWARE]) {
    ToolRegistry.registerDeviceAware(name, name, z.object({}), {
      handler: async () => ({ content: [] }),
      defaultEnabled: true,
    });
  }
  for (const name of PLAIN) {
    ToolRegistry.register(name, name, z.object({}), {
      handler: async () => ({ content: [] }),
      defaultEnabled: true,
    });
  }
}

async function enabledToolsFor(
  platforms: Readonly<Record<string, Platform>>,
  routingSessionUuid: string,
): Promise<string[]> {
  const lookup: SessionPlatformLookup = (uuid) => platforms[uuid];
  registerToolSelectionTools(lookup);
  const tool = ToolRegistry.getTool(SET_TOOL_ENABLED_TOOL_NAME)!;
  const result = await runWithToolSelectionContext(
    {
      routingSessionUuid,
      sessionToolSelectionService: new SessionToolSelectionService(
        new FakeToolSelectionRepository("server"),
      ),
    },
    () => tool.handler(tool.schema.parse({ toolName: "observe" })),
  );
  return toolJson(result).enabledTools as string[];
}

describe("setToolEnabled reports only tools the session's platform admits (#19186)", () => {
  beforeEach(registerTools);
  afterEach(() => ToolRegistry.clearTools());

  test("a watch session's enabledTools omit device-aware tools watchOS refuses", async () => {
    const enabled = await enabledToolsFor({ [WATCH_SESSION]: "watchos" }, WATCH_SESSION);

    expect(enabled).toEqual([...CALLABLE_DEVICE_AWARE, ...PLAIN].sort());
    for (const name of REFUSED_ON_WATCHOS) {
      expect(enabled).not.toContain(name);
    }
  });

  test("an iOS session keeps every enabled tool", async () => {
    const enabled = await enabledToolsFor({ [WATCH_SESSION]: "ios" }, WATCH_SESSION);

    expect(enabled).toContain("appLifecycle");
    expect(enabled).toContain("wakeAndUnlock");
  });

  test("a session with no known platform keeps every enabled tool", async () => {
    const enabled = await enabledToolsFor({}, WATCH_SESSION);

    expect(enabled).toContain("keyboard");
    expect(enabled.length).toBe(
      REFUSED_ON_WATCHOS.length + CALLABLE_DEVICE_AWARE.length + PLAIN.length,
    );
  });
});
