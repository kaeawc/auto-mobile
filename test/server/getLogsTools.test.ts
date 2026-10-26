import { describe, expect, test } from "bun:test";
import { createGetLogsHandler, type GetLogsArgs } from "../../src/server/getLogsTools";
import { getLogsResultSchema } from "../../src/server/getLogsToolOutputSchemas";
import type { BootedDevice } from "../../src/models";
import { parseThreadtime } from "../../src/features/deviceLogs/logcatQuery";

const ANDROID: BootedDevice = { name: "Pixel", platform: "android", deviceId: "emulator-5554" };

describe("getLogs tool (#14082)", () => {
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
