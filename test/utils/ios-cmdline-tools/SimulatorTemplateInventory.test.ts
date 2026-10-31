import { afterEach, expect, test } from "bun:test";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { createExecResult } from "../../../src/utils/execResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSimulatorDeviceTypeProfiles } from "../../fakes/FakeSimulatorDeviceTypeProfiles";
import { isExcludedFromAutoStart } from "../../../src/daemon/deviceAutoStartExclusion";
afterEach(() => SimCtlClient.invalidateDeviceListCache());
function rig(output = "clone-udid", fail = false) {
  const calls: string[][] = [];
  const listing = {
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
        {
          udid: "template",
          name: "automobile-template-12345678",
          state: "Shutdown",
          isAvailable: true,
        },
        { udid: "user", name: "automobile-template-mine", state: "Shutdown", isAvailable: true },
        { udid: "work", name: "work", state: "Shutdown", isAvailable: true },
      ],
    },
  };
  const client = new SimCtlClient(
    null,
    async (_file, args) => {
      calls.push(args);
      if (args.includes("clone")) {
        if (fail) {
          throw new Error("clone failed");
        }
        return createExecResult(output, "");
      }
      if (args.join(" ") === "simctl list devices --json") {
        return createExecResult(JSON.stringify(listing), "");
      }
      throw new Error(`Unexpected command ${args.join(" ")}`);
    },
    {
      timer: new FakeTimer(),
      platform: "darwin",
      deviceTypeProfiles: new FakeSimulatorDeviceTypeProfiles(),
    },
  );
  return { client, calls };
}
test("templates remain raw but disappear from DeviceInfo and autostart", async () => {
  const { client } = rig();
  expect(
    (await client.listSimulators()).devices["com.apple.CoreSimulator.SimRuntime.iOS-26-0"],
  ).toHaveLength(3);
  const infos = await client.listSimulatorImages(undefined, { bypassCache: true });
  expect(infos.map((image) => image.deviceId)).toEqual(["user", "work"]);
  expect(
    isExcludedFromAutoStart({ ...infos[0]!, name: "automobile-template-12345678" }, undefined),
  ).toBe(true);
});
for (const [name, output, fail] of [
  ["success", "clone-udid", false],
  ["empty", " ", false],
  ["error", "", true],
] as const) {
  test(`clone argv and cache invalidation on ${name}`, async () => {
    const { client, calls } = rig(output, fail);
    await client.listSimulatorImages();
    const promise = client.cloneSimulator("template", "name with ; shell text");
    if (name === "success") {
      expect(await promise).toBe("clone-udid");
    } else {
      await expect(promise).rejects.toThrow(name === "empty" ? "empty UDID" : "clone failed");
    }
    await client.listSimulatorImages();
    expect(calls).toContainEqual(["simctl", "clone", "template", "name with ; shell text"]);
    expect(calls.filter((args) => args.join(" ") === "simctl list devices --json")).toHaveLength(2);
  });
}
