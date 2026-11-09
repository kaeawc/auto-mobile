import { afterEach, beforeEach, expect, test } from "bun:test";
import { watchRunners } from "../../src/features/watch/WatchRunnerRegistry";
import { FakeWatchRunnerClient } from "../fakes/FakeWatchRunnerClient";
import { tapOnHandler, tapAtHandler } from "../../src/server/interactionTools/tapHandlers";
import { swipeOnHandler } from "../../src/server/interactionTools/gestureHandlers";
import { pressButtonHandler } from "../../src/server/interactionTools/deviceHandlers";
import { tapOnSchema, tapAtSchema } from "../../src/server/interactionTools/tapSchemas";
import { swipeOnSchema } from "../../src/server/interactionTools/gestureSchemas";
import { pressButtonSchema } from "../../src/server/interactionTools";
import { assertToolSupportsDevicePlatform } from "../../src/server/applePlatformToolSupport";
import type { BootedDevice } from "../../src/models";
import { ActionableError } from "../../src/models/ActionableError";
import { WatchRunnerError } from "../../src/features/watch/WatchRunnerError";
import {
  rotateCrownHandler,
  rotateCrownSchema,
  registerRotateCrownTools,
} from "../../src/server/rotateCrownTool";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "watch-handlers", platform: "watchos", name: "Watch" };
let client: FakeWatchRunnerClient;
let unregister: () => void;
beforeEach(() => {
  client = new FakeWatchRunnerClient();
  unregister = watchRunners.register(device.deviceId, client);
});
afterEach(() => unregister());

test("registers a watch-only crown tool with device targeting", () => {
  registerRotateCrownTools();
  expect(ToolRegistry.getTool("rotateCrown")?.requiresDevice).toBe(true);
  expect(() => assertToolSupportsDevicePlatform("rotateCrown", device)).not.toThrow();
  expect(
    rotateCrownSchema.parse({ delta: -0.5, platform: "watchos", sessionUuid: "watch-session" }),
  ).toMatchObject({
    delta: -0.5,
    platform: "watchos",
    sessionUuid: "watch-session",
  });
  for (const platform of ["android", "ios", "tvos"]) {
    expect(rotateCrownSchema.safeParse({ delta: 1, platform }).success).toBe(false);
  }
});

test.each([
  {},
  { delta: 0 },
  { delta: NaN },
  { delta: Infinity },
  { delta: -Infinity },
  { delta: "1" },
  { delta: null },
  { delta: true },
  { delta: 1, velocity: 0 },
  { delta: 1, velocity: -1 },
  { delta: 1, velocity: NaN },
  { delta: 1, velocity: Infinity },
  { delta: 1, velocity: -Infinity },
  { delta: 1, velocity: "1" },
  { delta: 1, velocity: null },
  { delta: 1, extra: true },
])("crown schema rejects invalid arguments %j", (args) => {
  expect(rotateCrownSchema.safeParse(args).success).toBe(false);
  expect(client.commands).toEqual([]);
});

test.each([undefined, 0.25])("crown handler dispatches velocity %s", async (velocity) => {
  const result = await rotateCrownHandler(
    device,
    rotateCrownSchema.parse({ delta: -0.5, velocity }),
  );
  expect(result).toMatchObject({
    structuredContent: { success: true, delta: -0.5, velocity: velocity ?? 1 },
  });
  expect(client.commands).toEqual([{ type: "crown", delta: -0.5, velocity: velocity ?? 1 }]);
});

test.each(["android", "ios"] as const)(
  "crown handler rejects a resolved %s device",
  async (platform) => {
    await expect(rotateCrownHandler({ ...device, platform }, { delta: 1 })).rejects.toBeInstanceOf(
      ActionableError,
    );
    expect(client.commands).toEqual([]);
  },
);

test("existing tool schemas and registry admit watch tapOn, tapAt, swipeOn and home press", async () => {
  for (const tool of ["tapOn", "tapAt", "swipeOn", "pressButton"]) {
    expect(() => assertToolSupportsDevicePlatform(tool, device)).not.toThrow();
  }
  await tapOnHandler(
    device,
    tapOnSchema.parse({ selector: { text: "CtrlProxy Watch" }, platform: "watchos" }),
  );
  await tapAtHandler(device, tapAtSchema.parse({ x: 10, y: 20, platform: "watchos" }));
  await swipeOnHandler(device, swipeOnSchema.parse({ direction: "up", platform: "watchos" }));
  await pressButtonHandler(
    device,
    pressButtonSchema.parse({ button: "home", platform: "watchos" }),
  );
  expect(client.commands).toEqual([
    { type: "hierarchy" },
    { type: "tap", identifier: "ctrlproxy-crown" },
    { type: "tap", x: 10, y: 20 },
    { type: "swipe", direction: "up" },
    { type: "home" },
  ]);
});
test("long press is refused by the real handler before hierarchy or input", async () => {
  await expect(
    tapOnHandler(device, { selector: { text: "CtrlProxy Watch" }, duration: 1000 }),
  ).rejects.toThrow("longPress");
  expect(client.commands).toEqual([]);
});

const unchangedCrown =
  "rotateCrown changed nothing the accessibility tree shows. Tap the view that should receive the crown, then observe before trying again.";

test.each([0.1, -0.5])(
  "an unchanged sub-revolution crown turn %s names the turn size as a cause",
  async (delta) => {
    client.failure = new WatchRunnerError(unchangedCrown, "command_failed");
    const error = await rotateCrownHandler(device, rotateCrownSchema.parse({ delta })).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(WatchRunnerError);
    expect((error as WatchRunnerError).errorCode).toBe("command_failed");
    expect((error as Error).message).toStartWith(unchangedCrown);
    expect((error as Error).message).toContain(`A delta of ${delta} is ${Math.abs(delta)} of one`);
    expect((error as Error).message).toContain("smaller than one step of the focused control");
    expect((error as Error).message).toContain("if it is not at its limit, try a larger delta");
    expect(client.commands).toEqual([{ type: "crown", delta, velocity: 1 }]);
  },
);

test.each([
  { delta: 1, failure: new WatchRunnerError(unchangedCrown, "command_failed") },
  { delta: -2, failure: new WatchRunnerError(unchangedCrown, "command_failed") },
  { delta: 0.1, failure: new WatchRunnerError("Watch command failed", "command_failed") },
  { delta: 0.1, failure: new ActionableError(unchangedCrown) },
])("crown failure for delta $delta passes through unchanged", async ({ delta, failure }) => {
  client.failure = failure;
  await expect(rotateCrownHandler(device, rotateCrownSchema.parse({ delta }))).rejects.toBe(
    failure,
  );
});
