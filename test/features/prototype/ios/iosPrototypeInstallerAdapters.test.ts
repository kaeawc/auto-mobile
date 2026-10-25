import { SimulatorContainerOwnershipError } from "../../../../src/utils/ios-cmdline-tools/simulatorOwnContainer";
import { cloneContainerFixture } from "../../../helpers/simulatorContainerFixture";
import {
  simulatorOwnership,
  simulatorDataContainer,
} from "../../../helpers/simulatorContainerFixture";
import { expect, test } from "bun:test";
import { DefaultPrototypeSimctl } from "../../../../src/features/prototype/ios/iosPrototypeInstallerAdapters";
import { FakeSimctl } from "../../../fakes/FakeSimctl";

function harness() {
  const client = new FakeSimctl();
  const calls: Array<{ method: string; args: Array<string | undefined> }> = [];
  const adapter = new DefaultPrototypeSimctl(
    {
      installApp: async (path, udid) => {
        calls.push({ method: "install", args: [path, udid] });
      },
      uninstallApp: async (bundleId, udid) => {
        calls.push({ method: "uninstall", args: [bundleId, udid] });
      },
      executeCommandArgs: client.executeCommandArgs.bind(client),
      listAppsOrThrow: client.listAppsOrThrow.bind(client),
    },
    simulatorOwnership,
  );
  return { client, calls, adapter };
}

test("simctl adapter preserves argument order and uses data container argv", async () => {
  const h = harness();
  h.client.setContainerPath(
    "proto.id",
    ` ${simulatorDataContainer("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")}\n`,
  );
  await h.adapter.install("udid", "/tmp/Viewer.app");
  await h.adapter.uninstall("udid", "proto.id");
  expect(await h.adapter.getDataContainer("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "proto.id")).toBe(
    simulatorDataContainer("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"),
  );
  expect(h.calls).toEqual([
    { method: "install", args: ["/tmp/Viewer.app", "udid"] },
    { method: "uninstall", args: ["proto.id", "udid"] },
  ]);
  expect(h.client.getMethodCalls("executeCommandArgs")[0]).toMatchObject({
    args: ["get_app_container", "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "proto.id", "data"],
  });
});

test("simctl list adapter maps names, skips malformed records and propagates failures", async () => {
  const h = harness();
  h.client.setInstalledApps([
    { bundleId: "a", CFBundleDisplayName: "A", CFBundleName: "fallback" },
    { bundleId: "b", CFBundleName: "B" },
    { bundleId: "c" },
    null,
    "bad",
    { bundleId: 3 },
  ]);
  expect(await h.adapter.listApps("udid")).toEqual([
    { bundleId: "a", displayName: "A" },
    { bundleId: "b", displayName: "B" },
    { bundleId: "c" },
  ]);
  h.client.setListAppsError(new Error("simulator unavailable"));
  await expect(h.adapter.listApps("udid")).rejects.toThrow("simulator unavailable");
});

for (const proven of [true, false]) {
  test(`prototype installer container clone ownership: ${proven}`, async () => {
    const deviceId = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const clone = cloneContainerFixture(deviceId, proven ? "proto.id" : null);
    const client = new FakeSimctl();
    client.setContainerPath("proto.id", clone.reported);
    const adapter = new DefaultPrototypeSimctl(client, clone.ownership);
    if (!proven) {
      await expect(adapter.getDataContainer(deviceId, "proto.id")).rejects.toBeInstanceOf(
        SimulatorContainerOwnershipError,
      );
    } else {
      expect(await adapter.getDataContainer(deviceId, "proto.id")).toBe(clone.own);
    }
    expect(clone.inspected).toEqual([clone.own]);
  });
}

test("installer retains empty-output handling for its existing caller", async () => {
  const client = new FakeSimctl();
  const adapter = new DefaultPrototypeSimctl(client, simulatorOwnership);
  expect(await adapter.getDataContainer("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "proto.id")).toBe(
    "",
  );
});
