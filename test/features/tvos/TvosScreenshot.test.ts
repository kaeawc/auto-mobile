import { describe, expect, test } from "bun:test";
import { captureTvosScreenshot } from "../../../src/features/tvos/TvosScreenshot";
import { TvosRunnerRegistry } from "../../../src/features/tvos/TvosRunnerRegistry";
import type { BootedDevice } from "../../../src/models";
import { FakeTvosRunnerClient } from "../../fakes/FakeTvosRunnerClient";

const APPLE_TV: BootedDevice = { name: "Apple TV 4K", platform: "tvos", deviceId: "tv-udid" };

describe("captureTvosScreenshot (#16725)", () => {
  test("uses the connected runner's screenshot", async () => {
    const runners = new TvosRunnerRegistry();
    const client = new FakeTvosRunnerClient();
    client.screenshotData = Buffer.from("runner-png").toString("base64");
    runners.register(APPLE_TV.deviceId, client);
    const simctl = async (): Promise<Buffer> => {
      throw new Error("simctl must not be used while a runner is connected");
    };

    const png = await captureTvosScreenshot(APPLE_TV, undefined, runners, simctl);

    expect(png.toString()).toBe("runner-png");
    expect(client.commands).toEqual([{ type: "request_screenshot" }]);
  });

  test("falls back to simctl when no runner is connected", async () => {
    const captured: string[] = [];
    const png = await captureTvosScreenshot(
      APPLE_TV,
      undefined,
      new TvosRunnerRegistry(),
      async (device) => {
        captured.push(device.deviceId);
        return Buffer.from("simctl-png");
      },
    );
    expect(png.toString()).toBe("simctl-png");
    expect(captured).toEqual(["tv-udid"]);
  });

  test("refuses a runner reply that is not base64 text", async () => {
    const runners = new TvosRunnerRegistry();
    runners.register(APPLE_TV.deviceId, new FakeTvosRunnerClient());
    await expect(captureTvosScreenshot(APPLE_TV, undefined, runners)).rejects.toThrow(
      "Invalid tvOS screenshot; reconnect the runner.",
    );
  });
});
