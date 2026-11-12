import { describe, expect, test } from "bun:test";
import {
  createGetLogsHandler,
  defaultGetLogsDependencies,
  type GetLogsArgs,
} from "../../src/server/getLogsTools";
import { getLogsResultSchema } from "../../src/server/getLogsToolOutputSchemas";
import type { BootedDevice } from "../../src/models";
import { parseThreadtime } from "../../src/features/deviceLogs/logcatQuery";

import {
  getToolSelectionContext,
  runWithToolSelectionContext,
} from "../../src/features/toolSelection/toolSelectionContext";
import { internalToolInvocationContext } from "../../src/server/pipeline/internalInvocationContext";

const ANDROID: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

describe("getLogs tool (#14082)", () => {
  test("the internal-call seam carries a run anchor into getLogs and nested calls", async () => {
    await runWithToolSelectionContext({ planStartMs: 1234 }, async () => {
      const invocation = internalToolInvocationContext({}, { forPlan: true });
      await runWithToolSelectionContext(invocation, async () => {
        const deps = defaultGetLogsDependencies(ANDROID, {} as GetLogsArgs);
        expect(deps.clock.planStartMs?.()).toBe(1234);
        expect(internalToolInvocationContext({}, { planStartMs: 5678 }).planStartMs).toBe(5678);
      });
    });
    expect(getToolSelectionContext()?.planStartMs).toBeUndefined();
    expect(
      defaultGetLogsDependencies(ANDROID, {} as GetLogsArgs).clock.planStartMs?.(),
    ).toBeUndefined();
  });

  test("a run-start read passes only this run's elapsed window to the log source", async () => {
    let seconds: number | undefined;
    const handler = createGetLogsHandler(() => ({
      clock: {
        now: () => 130_000,
        planStartMs: () => 120_000,
        lastActionStartMs: () => 129_000,
        sessionStartMs: () => 0,
      },
      android: () => ({
        read: async (request) => {
          seconds = request.sinceSeconds;
          return { lines: [], pids: [], attribution: "none", warnings: [] };
        },
      }),
      ios: () => ({ collect: async () => ({ text: "", truncated: false }) }),
    }));
    await handler(ANDROID, { since: "run-start" } as GetLogsArgs);
    expect(seconds).toBe(10);
  });

  test("returns schema-valid structured lines and passes the session to sessionStart", async () => {
    let sessionAsked: string | undefined;
    const handler = createGetLogsHandler((_device, args) => ({
      clock: {
        now: () => 70_000,
        lastActionStartMs: () => undefined,
        sessionStartMs: () => {
          sessionAsked = args.sessionUuid;
          return 10_000;
        },
      },
      android: () => ({
        read: async (request) => ({
          lines: parseThreadtime(
            `10-21 08:00:00.000  7  7 E AndroidRuntime: since ${request.sinceSeconds}`,
          ),
          pids: [7],
          attribution: "uid",
          warnings: [],
        }),
      }),
      ios: () => ({ collect: async () => ({ text: "", truncated: false }) }),
    }));
    const response = (await handler(ANDROID, {
      appId: "com.example",
      since: "sessionStart",
      sessionUuid: "session-1",
    } as GetLogsArgs)) as { structuredContent: unknown };
    const parsed = getLogsResultSchema.parse(response.structuredContent);
    expect(sessionAsked).toBe("session-1");
    expect(parsed).toMatchObject({
      success: true,
      sinceSeconds: 60,
      pids: [7],
      lines: [{ tag: "AndroidRuntime", message: "since 60" }],
    });
  });
});
