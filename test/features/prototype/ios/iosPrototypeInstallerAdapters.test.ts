import { expect, test } from "bun:test";
import { DefaultPrototypeSimctl } from "../../../../src/features/prototype/ios/iosPrototypeInstallerAdapters";
import { FakeSimCtlClient } from "../../../fakes/FakeSimCtlClient";

function harness() {
  const client = new FakeSimCtlClient();
  const calls: Array<{ method: string; args: Array<string | undefined> }> = [];
  const adapter = new DefaultPrototypeSimctl({
    installApp: async (path, udid) => {
      calls.push({ method: "install", args: [path, udid] });
    },
    uninstallApp: async (bundleId, udid) => {
      calls.push({ method: "uninstall", args: [bundleId, udid] });
    },
    executeCommandArgs: client.executeCommandArgs.bind(client),
    listAppsOrThrow: client.listAppsOrThrow.bind(client),
  });
  return { client, calls, adapter };
}

test("simctl adapter preserves argument order and uses data container argv", async () => {
  const h = harness();
  h.client.setContainerPath("proto.id", " /container/data\n");
  await h.adapter.install("udid", "/tmp/Viewer.app");
  await h.adapter.uninstall("udid", "proto.id");
  expect(await h.adapter.getDataContainer("udid", "proto.id")).toBe("/container/data");
  expect(h.calls).toEqual([
    { method: "install", args: ["/tmp/Viewer.app", "udid"] },
    { method: "uninstall", args: ["proto.id", "udid"] },
  ]);
  expect(h.client.getMethodCalls("executeCommandArgs")[0]).toMatchObject({
    args: ["get_app_container", "udid", "proto.id", "data"],
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
