import { describe, expect, test } from "bun:test";
import { SimctlIosSimulatorMediaClient } from "../../src/server/iosSimulatorMediaClient";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";

describe("SimctlIosSimulatorMediaClient", () => {
  test("imports media with exact simctl argv boundaries", async () => {
    const simctl = new FakeSimCtlClient();
    const client = new SimctlIosSimulatorMediaClient(() => simctl as never);
    const device = {
      deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      name: "iPhone",
      platform: "ios" as const,
    };

    await client.importMedia(device, ["/tmp/photo one.png", "/tmp/video;two.mov"]);

    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      {
        args: ["addmedia", device.deviceId, "/tmp/photo one.png", "/tmp/video;two.mov"],
        timeoutMs: undefined,
      },
    ]);
  });
});
