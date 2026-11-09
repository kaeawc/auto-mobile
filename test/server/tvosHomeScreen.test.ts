import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ActionableError, type BootedDevice } from "../../src/models";
import { tvosRunners } from "../../src/features/tvos/TvosRunnerRegistry";
import {
  APPLE_PLATFORM_SUPPORTED_TOOLS,
  assertRequestedPlatformSupported,
  assertToolSupportsDevicePlatform,
} from "../../src/server/applePlatformToolSupport";
import { withTvosHomeScreen } from "../../src/server/tvosHomeScreen";
import { FakeTvosRunnerClient } from "../fakes/FakeTvosRunnerClient";
import { toolIsError, toolStructured } from "../helpers/toolResponse";

const tv: BootedDevice = { platform: "tvos", name: "TV", deviceId: "tvos-home-screen" };

describe("homeScreen on an Apple TV (#17525)", () => {
  let client: FakeTvosRunnerClient;
  let unregister: () => void;
  const mobileCalls: string[] = [];
  const handler = withTvosHomeScreen(async (device: BootedDevice, _args: unknown) => {
    mobileCalls.push(device.platform);
    return { content: [] };
  });

  beforeEach(() => {
    mobileCalls.length = 0;
    client = new FakeTvosRunnerClient();
    unregister = tvosRunners.register(tv.deviceId, client);
  });
  afterEach(() => unregister());

  test("is on the tvOS allowlist", () => {
    expect(APPLE_PLATFORM_SUPPORTED_TOOLS.tvos.has("homeScreen")).toBe(true);
    expect(() => assertToolSupportsDevicePlatform("homeScreen", tv)).not.toThrow();
    expect(() =>
      assertRequestedPlatformSupported("homeScreen", { platform: "tvos" }),
    ).not.toThrow();
  });

  test("presses the remote home button through the runner", async () => {
    const response = await handler(tv, {});

    expect(client.commands).toEqual([{ type: "request_press_button", action: "home" }]);
    expect(mobileCalls).toEqual([]);
    expect(toolStructured(response)).toMatchObject({
      message: "Pressed the Siri Remote home button",
      success: true,
      navigationMethod: "hardware",
    });
    expect(toolIsError(response)).toBe(false);
  });

  test("a runner failure surfaces as an actionable error", async () => {
    client.failure = new Error("runner gone");

    await expect(handler(tv, {})).rejects.toThrow(ActionableError);
    await expect(handler(tv, {})).rejects.toThrow("Failed to go to home screen");
  });

  test("an aborted call presses nothing", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(handler(tv, {}, undefined, controller.signal)).rejects.toThrow();
    expect(client.commands).toEqual([]);
  });

  test("other platforms keep the mobile handler", async () => {
    await handler({ platform: "ios", name: "iPhone", deviceId: "IPHONE" }, {});
    expect(mobileCalls).toEqual(["ios"]);
    expect(client.commands).toEqual([]);
  });
});
