import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  IDLE_WINDOW_MS,
  LivenessScenario,
  RELEASE_SLACK_MS,
} from "../helpers/livenessScenarioHarness";

// #11558: a control call refused as `device_outside_bound_session` (its `deviceId` is not its
// session's device) is refused before readiness and never drives a device. ToolRegistry used to
// stamp the session at admission and mark the call's end as use before that routing check, so a
// client that kept sending a stale `deviceId` held its device for ever with no device
// interaction (#10655 class). The routing check now runs before admission; each refusal kind is
// tabled in test/server/namedForeignSessionActivity.test.ts.

const DEVICE_A = "emulator-5554";
const DEVICE_B = "emulator-5556";
const IDLE_REASONS = ["cleanup-expired"];

let scenario: LivenessScenario;

beforeAll(async () => {
  await (await LivenessScenario.start()).stop();
});

afterEach(async () => {
  await scenario.stop();
});

/** The typed code of an `isError` tool result, as the proxy's MCP client receives a refusal. */
const errorResultCode = (result: unknown): string | undefined => {
  if (typeof result !== "object" || result === null || Reflect.get(result, "isError") !== true) {
    return undefined;
  }
  const content: unknown = Reflect.get(result, "content");
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text: unknown = typeof first === "object" && first !== null && Reflect.get(first, "text");
  const payload: unknown = typeof text === "string" ? JSON.parse(text) : undefined;
  const code: unknown =
    typeof payload === "object" && payload !== null ? Reflect.get(payload, "code") : undefined;
  return typeof code === "string" ? code : "untyped-error";
};

/** How the call was answered: the refusal's code (thrown, or on the error result), or admitted. */
const refusalCode = (call: Promise<unknown>): Promise<string | undefined> =>
  call.then(
    (result) => errorResultCode(result) ?? "admitted",
    (error: { code?: string }) => error.code,
  );

describe("a control call refused for naming a device its session does not hold", () => {
  test("is not use: the session is freed one idle window after its last admitted call", async () => {
    scenario = await LivenessScenario.start({ devices: [DEVICE_A, DEVICE_B] });
    const holder = await scenario.acquire(DEVICE_A);
    await scenario.toolCall(holder);
    const lastCallAt = scenario.timer.now();
    const drivenBefore = scenario.driven.length;
    const readinessBefore = scenario.readinessTouches;

    // Inside the window the agent names its own session with the other (free) device, twice.
    const codes: Array<string | undefined> = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      await scenario.idle(50_000);
      codes.push(
        await refusalCode(
          scenario.proxy.callTool("homeScreen", { sessionUuid: holder, deviceId: DEVICE_B }),
        ),
      );
    }
    expect(codes).toEqual(["device_outside_bound_session", "device_outside_bound_session"]);
    // Refused before readiness; no tool body ran on either device.
    expect(scenario.readinessTouches).toBe(readinessBefore);
    expect(scenario.driven.length).toBe(drivenBefore);

    // Refused calls are not use: the idle deadline is still one window after the last real call.
    expect(scenario.daemon.manager.getSession(holder)?.lastUsedAt).toBe(lastCallAt);
    const releasedAt = await scenario.idleUntilReleased(holder, 20_000 + RELEASE_SLACK_MS);
    expect(releasedAt).toBeDefined();
    expect(releasedAt!).toBeLessThanOrEqual(lastCallAt + IDLE_WINDOW_MS + RELEASE_SLACK_MS);
    expect(IDLE_REASONS).toContain(scenario.releaseOf(holder)?.reason!);
  });
});
