import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { SessionToolSelectionRepository } from "../../../../src/db/sessionToolSelectionRepository";
import { SessionToolSelectionService } from "../../../../src/features/toolSelection/SessionToolSelectionService";
import {
  enrichAcquiredSession,
  enrichProvisionDeviceResult,
} from "../../../../src/server/pipeline/ingress/acquisition";
import { ToolRegistry } from "../../../../src/server/toolRegistry";
import { isolateEmptyToolRegistry } from "../../../helpers/withTemporaryTool";
import captured from "../../../fixtures/android-tv-tools-list/tv-session-tools.json";

isolateEmptyToolRegistry();

// #18029: what the TV session listed, and the default-off tools it left out.
const LISTED = captured.toolsListNames;
const HIDDEN = captured.toolCatalogEntries
  .filter((entry) => !entry.enabledWithoutSession)
  .map((entry) => entry.name);
const SESSION = "tv-session";

class InMemorySelectionRepository implements SessionToolSelectionRepository {
  readonly rows = new Map<string, Map<string, boolean>>();

  async list(sessionUuid: string): Promise<Map<string, boolean>> {
    return new Map(this.rows.get(sessionUuid) ?? []);
  }

  async set(sessionUuid: string, toolName: string, enabled: boolean): Promise<void> {
    const rows = this.rows.get(sessionUuid) ?? new Map<string, boolean>();
    rows.set(toolName, enabled);
    this.rows.set(sessionUuid, rows);
  }

  async deleteSession(sessionUuid: string): Promise<void> {
    this.rows.delete(sessionUuid);
  }
}

function registerCapturedTools(): void {
  ToolRegistry.clearTools();
  for (const name of [...LISTED, ...HIDDEN]) {
    ToolRegistry.registerDeviceAware(name, name, z.object({}), {
      handler: async () => ({ content: [] }),
      defaultEnabled: !HIDDEN.includes(name),
      // As focusNavigateTool registers it.
      ...(name === "focusNavigate" ? { defaultEnabledOnTv: true } : {}),
    });
  }
}

/** `tools/list` for one session: every registered tool the selection enables there. */
function listSessionTools(service: SessionToolSelectionService) {
  return async (sessionUuid: string) => ({
    tools: (
      await Promise.all(
        ToolRegistry.getAllTools().map(async (tool) =>
          (await service.isEnabled(sessionUuid, tool.name, tool.defaultEnabled ?? true))
            ? { name: tool.name }
            : undefined,
        ),
      )
    ).filter((tool): tool is { name: string } => tool !== undefined),
  });
}

/** A getAndroid result: its device description carries `platform` and `formFactor`. */
function acquisitionResult(formFactor: string, platform = "android") {
  const payload = { platform, formFactor, runtime: { session: { sessionUuid: SESSION } } };
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

async function acquire(
  service: SessionToolSelectionService,
  formFactor: string,
  platform?: string,
) {
  const result = await enrichAcquiredSession({
    toolName: "getAndroid",
    result: acquisitionResult(formFactor, platform),
    acquiredSessionUuid: SESSION,
    requestedEnableTools: [],
    sessionToolSelectionService: service,
    listSessionTools: listSessionTools(service),
    requestSignal: undefined,
  });
  return JSON.parse(result.content[0]!.text!) as { enabledTools: string[]; gatedTools: string[] };
}

describe("a TV session lists focusNavigate in tools/list (#18029)", () => {
  let repository: InMemorySelectionRepository;

  beforeEach(() => {
    registerCapturedTools();
    repository = new InMemorySelectionRepository();
  });

  test("the fake reproduces the captured TV tools/list before the fix", async () => {
    const service = new SessionToolSelectionService(repository);
    const listed = (await listSessionTools(service)(SESSION)).tools.map((tool) => tool.name);
    expect(listed.sort()).toEqual([...LISTED].sort());
  });

  test("an Android TV acquisition lists focusNavigate and keeps the other default-off tools hidden", async () => {
    const service = new SessionToolSelectionService(repository);
    const { enabledTools, gatedTools } = await acquire(service, "tv");

    expect(enabledTools).toContain("focusNavigate");
    expect(gatedTools).toEqual(["executePlan", "getLogs", "provisionDevice", "recordToolCalls"]);
    const listed = (await listSessionTools(service)(SESSION)).tools.map((tool) => tool.name);
    expect(listed).toContain("focusNavigate");
  });

  test("an Apple TV acquisition lists it too", async () => {
    const service = new SessionToolSelectionService(repository);
    expect((await acquire(service, "unknown", "tvos")).enabledTools).toContain("focusNavigate");
  });

  test("a phone acquisition leaves focusNavigate default-off", async () => {
    const service = new SessionToolSelectionService(repository);
    const { gatedTools } = await acquire(service, "phone");
    expect(gatedTools).toContain("focusNavigate");
    expect(repository.rows.size).toBe(0);
  });

  test("an operator's --disable-tool focusNavigate wins on a TV", async () => {
    const service = new SessionToolSelectionService(
      repository,
      new Map([["focusNavigate", false]]),
    );
    expect((await acquire(service, "tv")).gatedTools).toContain("focusNavigate");
    expect(repository.rows.size).toBe(0);
  });

  test("a session that already turned focusNavigate off keeps it off", async () => {
    await repository.set(SESSION, "focusNavigate", false);
    const service = new SessionToolSelectionService(repository);
    expect((await acquire(service, "tv")).gatedTools).toContain("focusNavigate");
  });

  test("provisionDevice booting an Android TV reports focusNavigate in enabledTools", async () => {
    const service = new SessionToolSelectionService(repository);
    const payload = {
      sessionId: SESSION,
      device: { name: "tv_1080p", platform: "android", formFactor: "tv" },
    };
    const result = await enrichProvisionDeviceResult(
      "provisionDevice",
      { content: [{ type: "text", text: JSON.stringify(payload) }] },
      SESSION,
      { service, enableTools: [], connectionProfileUuid: undefined },
    );
    expect(JSON.parse(result.content[0]!.text!).enabledTools).toContain("focusNavigate");
  });
});
