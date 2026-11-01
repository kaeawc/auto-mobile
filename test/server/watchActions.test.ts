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
const device: BootedDevice = { deviceId: "watch-handlers", platform: "watchos", name: "Watch" };
let client: FakeWatchRunnerClient;
let unregister: () => void;
beforeEach(() => {
  client = new FakeWatchRunnerClient();
  unregister = watchRunners.register(device.deviceId, client);
});
afterEach(() => unregister());

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
